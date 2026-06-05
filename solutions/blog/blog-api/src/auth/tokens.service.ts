import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma, type User } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { ErrorCodes } from '../common/constants/error-codes';
import { BusinessException } from '../common/exceptions/business.exception';
import type { AppConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // access token 存活秒数
}

/**
 * 令牌的签发 / 轮换 / 作废。
 * - access token：无状态 JWT（不入库），sub=userId、role=角色，secret/expiresIn 由 JwtModule 配
 * - refresh token：不透明随机串，库里**只存 sha256 哈希**，可撤销（呼应 Day 31）
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  // 不可逆哈希：库里存它，明文 refresh 只在响应里给客户端一次
  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  // client 可传入事务句柄 tx：rotate 把"作废旧的 + 写新的"放进同一事务时需要
  async issue(
    user: Pick<User, 'id' | 'role'>,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role });

    const refreshToken = randomBytes(32).toString('base64url');
    const days = this.config.get('auth.refreshTtlDays', { infer: true });
    await client.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hash(refreshToken),
        expiresAt: new Date(Date.now() + days * 86_400_000),
      },
    });

    return {
      accessToken,
      refreshToken,
      expiresIn: this.config.get('auth.accessTtl', { infer: true }),
    };
  }

  /**
   * 用 refresh 换新 token：校验 → 作废旧的 → 发新的，**整个放进一个事务**。
   * 为什么要事务（对照 posts update 的 $transaction）：
   *  - 原子性：若发新 token 失败，作废也回滚，用户不会被"凭空登出"。
   *  - 防并发重放：两个请求拿同一个 refresh 并发刷新时，靠"条件作废 + 命中行数"
   *    保证只有一个成功（另一个被行锁挡住后看到已 revoked → 0 行 → 拒绝）。
   */
  async rotate(rawRefresh: string): Promise<{ user: User; tokens: IssuedTokens }> {
    const hash = this.hash(rawRefresh);
    return this.prisma.$transaction(async (tx) => {
      const record = await tx.refreshToken.findUnique({
        where: { tokenHash: hash },
        include: { user: true },
      });
      if (!record || record.revokedAt || record.expiresAt <= new Date()) {
        throw this.invalidRefresh();
      }
      // 条件作废：只在"仍未撤销"时作废。命中 0 行 = 已被并发请求抢先用过 → 拒绝（一次性保证）
      const revoked = await tx.refreshToken.updateMany({
        where: { id: record.id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (revoked.count === 0) throw this.invalidRefresh();
      return { user: record.user, tokens: await this.issue(record.user, tx) };
    });
  }

  private invalidRefresh(): BusinessException {
    return new BusinessException(
      ErrorCodes.INVALID_REFRESH_TOKEN,
      'refresh token 无效或已过期',
      HttpStatus.UNAUTHORIZED,
    );
  }

  /** 登出：作废这个 refresh。幂等——未知 / 已作废的 token 也当成功，不泄露它存不存在 */
  async revoke(rawRefresh: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash: this.hash(rawRefresh), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}
