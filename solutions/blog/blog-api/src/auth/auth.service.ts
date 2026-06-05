import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { IssuedTokens, TokensService } from './tokens.service';

// bcrypt 工作因子（cost）：每 +1 计算量翻倍。10 是常见起点；机器越快可调高。
const BCRYPT_COST = 10;

// 登录时即使「用户不存在」也跑一次 bcrypt.compare，让响应耗时和「密码错」一致，
// 避免攻击者靠响应时间判断邮箱是否注册过（用户枚举 / 时序侧信道）。这是一个废弃哈希。
const DUMMY_HASH = bcrypt.hashSync('a-dummy-value-for-constant-time-login', BCRYPT_COST);

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
  ) {}

  async register(dto: RegisterDto) {
    // 预检唯一（给友好错误）；写入处再兜 P2002 竞态。
    // 两次按唯一键查（走索引），email 优先——结果确定，不像 OR findFirst 同时撞两列时任取一行。
    if (
      await this.prisma.user.findUnique({
        where: { email: dto.email },
        select: { id: true },
      })
    ) {
      throw this.emailTaken();
    }
    if (
      await this.prisma.user.findUnique({
        where: { username: dto.username },
        select: { id: true },
      })
    ) {
      throw this.usernameTaken();
    }

    const password = await bcrypt.hash(dto.password, BCRYPT_COST);
    let user: User;
    try {
      user = await this.prisma.user.create({
        data: { email: dto.email, username: dto.username, password },
      });
    } catch (e) {
      // 预检到写入之间被并发抢注 → P2002，按冲突字段给对应错误
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = JSON.stringify((e.meta as { target?: unknown })?.target ?? '');
        throw target.includes('email') ? this.emailTaken() : this.usernameTaken();
      }
      throw e;
    }
    return this.authResponse(user, await this.tokens.issue(user));
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // 用户不存在也比对一次（用废弃哈希），保持常量时间；任何失败都回同一个错误
    const ok = await bcrypt.compare(dto.password, user?.password ?? DUMMY_HASH);
    if (!user || !ok) {
      throw new BusinessException(
        ErrorCodes.INVALID_CREDENTIALS,
        '邮箱或密码错误',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.authResponse(user, await this.tokens.issue(user));
  }

  async refresh(rawRefresh: string) {
    const { user, tokens } = await this.tokens.rotate(rawRefresh);
    return this.authResponse(user, tokens);
  }

  async logout(rawRefresh: string) {
    await this.tokens.revoke(rawRefresh);
    return { success: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // token 签名有效，但用户已被删 → 当未认证
      throw new BusinessException(
        ErrorCodes.UNAUTHORIZED,
        '用户不存在',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.toUserResponse(user);
  }

  // Day 33：列出所有用户（仅 admin，路由层用 @Roles('admin') 把关）。脱敏后返回。
  async listUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return users.map((u) => this.toUserResponse(u));
  }

  private authResponse(user: User, tokens: IssuedTokens) {
    return { ...tokens, tokenType: 'Bearer', user: this.toUserResponse(user) };
  }

  // ★ 出口统一脱敏：绝不把 password 带出去
  private toUserResponse(user: User) {
    return {
      id: user.id,
      email: user.email,
      username: user.username,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  private emailTaken() {
    return new BusinessException(ErrorCodes.EMAIL_TAKEN, '该邮箱已注册', HttpStatus.CONFLICT);
  }
  private usernameTaken() {
    return new BusinessException(ErrorCodes.USERNAME_TAKEN, '该用户名已被占用', HttpStatus.CONFLICT);
  }
}
