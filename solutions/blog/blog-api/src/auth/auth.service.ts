import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { Prisma, type User } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import { LoginAttemptService } from '../cache/login-attempt.service';
import { PrismaService } from '../prisma/prisma.service';
import { MailQueueService } from '../queue/mail-queue.service';
import { LoginDto } from './dto/login.dto';
import type { GithubUser } from './oauth/github-oauth.provider';
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
    // Day 38：注册成功后异步入队一封欢迎邮件。@Optional：单元测试不传也能 new AuthService。
    // ★ 注意我们【await 的是入队】，不是【发信】——入队只是往 Redis 塞一条任务（毫秒级），
    //   真正发信由后台 worker 慢慢做。用户只等这「入队」一下，不等 SMTP 的秒级往返。
    @Optional() private readonly mail?: MailQueueService,
    // Day 40：账号级登录锁定（防密码爆破）。@Optional：LoginAttemptService 由全局 CacheModule
    //   提供，真实运行时恒在；标 @Optional 只为单元测试能 new AuthService 不传它。
    @Optional() private readonly loginAttempts?: LoginAttemptService,
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

    // Day 38：异步解耦——注册成功后，把「发欢迎邮件」甩进队列，不阻塞响应、也不因邮件故障连累注册。
    // enqueue 永不抛错（内部已降级），所以就算 Redis 挂了，注册依旧正常返回 token。
    // 幂等键 `welcome_<userId>` 同时作为 BullMQ 的 jobId（入队侧去重）+ Redis 幂等标记后缀。
    // ★ 用下划线不用冒号：BullMQ 禁止队列名和 jobId 含 `:`（会拼进 Redis key `bull:mail:<jobId>` 撞命名空间）。
    await this.mail?.enqueue({
      kind: 'welcome',
      to: dto.email,
      subject: `欢迎加入，${dto.username}！`,
      body: `你好 ${dto.username}，感谢注册。这是一封由消息队列异步发送的欢迎邮件。`,
      idempotencyKey: `welcome_${user.id}`,
    });

    return this.authResponse(user, await this.tokens.issue(user));
  }

  async login(dto: LoginDto) {
    // Day 40：账号级闸门——锁定优先于一切。已锁就省掉 bcrypt 比对（省 CPU），也避免再泄露信息。
    // Redis 不通时 isLocked 恒 false（降级），登录照常走，绝不被这层安全配置拖垮。
    if (await this.loginAttempts?.isLocked(dto.email)) {
      // 423 Locked（RFC 4918）：语义比 429/403 更准——账号被锁，不是「频率太快」也不是「没权限」。
      // HttpStatus 枚举里没有 423，用数字字面量（业务码 ACCOUNT_LOCKED 才是前端真正 key 的东西）。
      throw new BusinessException(
        ErrorCodes.ACCOUNT_LOCKED,
        '账号因连续登录失败已被临时锁定，请稍后再试',
        423 as HttpStatus,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // 用户不存在也比对一次（用废弃哈希），保持常量时间；任何失败都回同一个错误
    const ok = await bcrypt.compare(dto.password, user?.password ?? DUMMY_HASH);
    if (!user || !ok) {
      // Day 40：记一次失败（达阈值即锁）。不区分「用户不存在 / 密码错」——都对同一 email 计数，
      // 否则「不存在的邮箱不计失败」这个差行为本身就成了枚举信号。
      await this.loginAttempts?.recordFailure(dto.email);
      throw new BusinessException(
        ErrorCodes.INVALID_CREDENTIALS,
        '邮箱或密码错误',
        HttpStatus.UNAUTHORIZED,
      );
    }
    // Day 40：成功即清零。否则用户偶发手滑几次后，计数器会在窗口内一直挂着顶到阈值。
    await this.loginAttempts?.clear(dto.email);
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

  // Day 34：用 GitHub 资料登录/注册本系统，发我们自己的 token。三步绑定策略：
  async loginWithGithub(gh: GithubUser) {
    // 1) 已绑过 GitHub → 直接是这个人
    let user = await this.prisma.user.findUnique({ where: { githubId: gh.id } });

    // 2) 没绑过，但邮箱已注册 → 关联到已有账号（信任 GitHub 已验证的主邮箱）
    if (!user && gh.email) {
      const existing = await this.prisma.user.findUnique({ where: { email: gh.email } });
      if (existing) {
        user = await this.prisma.user.update({
          where: { id: existing.id },
          data: { githubId: gh.id },
        });
      }
    }

    // 3) 全新用户 → 建号。无密码（password: null，只能用 GitHub 登录）；
    //    邮箱缺失就用 GitHub 的 noreply 占位，保证 email 唯一不冲突。
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          email: gh.email ?? `${gh.id}+${gh.login}@users.noreply.github.com`,
          username: await this.uniqueUsername(gh.login),
          githubId: gh.id,
          password: null,
        },
      });
    }

    return this.authResponse(user, await this.tokens.issue(user));
  }

  // 把 GitHub login 洗成合法且唯一的 username（撞了就补随机后缀）
  private async uniqueUsername(base: string): Promise<string> {
    let cleaned = base.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    if (cleaned.length < 3) cleaned = `gh-${cleaned || 'user'}`;
    for (let i = 0; i < 5; i++) {
      const candidate = i === 0 ? cleaned : `${cleaned}-${randomBytes(2).toString('hex')}`;
      const exists = await this.prisma.user.findUnique({
        where: { username: candidate },
        select: { id: true },
      });
      if (!exists) return candidate;
    }
    return `${cleaned}-${randomBytes(4).toString('hex')}`;
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
