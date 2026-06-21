import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import { RedisService } from './redis.service';

// Day 40：账号级登录锁定。和 Day 35 的限流（@Throttler，**按 IP**）正交——
//   限流挡「同一来源 IP 的洪泛」，锁定挡「针对同一账号的密码爆破」。
//   攻击者用一堆 IP（代理池）撞一个账号时，IP 限流逐个 IP 都没超阈值，
//   只有「账号维度」的计数能把这种爆破拦下来。
//
// 状态落在 Redis（一个带 TTL 的计数器 key），复用 Day 36/37 的「可选层」哲学：
//   Redis 连不上 → 整套锁定静默关闭，登录照常走（哪怕少了这层防护，也不让登录挂）。
//   这和存储选 S3 时的 fail-fast（Day 39 §6）刻意相反：锁定是「锦上添花的安全层」，
//   不是运营命脉，挂了宁可降级。
//
// 单 key 设计：loginfail:<email> = 失败次数，首次失败时起算窗口（windowSec），到期自动归零
//   → 账号自动解锁，无需人工介入、也不会永久误锁。成功登录立即 del 清零。

/** 一次失败计数的结果：当前累计次数、是否已触发锁定。 */
export interface AttemptResult {
  attempts: number;
  locked: boolean;
}

@Injectable()
export class LoginAttemptService {
  private readonly maxAttempts: number;
  private readonly windowSec: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.maxAttempts = config.get('auth.lockout.maxAttempts', { infer: true });
    this.windowSec = config.get('auth.lockout.windowSec', { infer: true });
  }

  // 邮箱归一化成小写当 key 一部分：大小写不同的输入别算成两个账号。
  private key(email: string): string {
    return `loginfail:${email.trim().toLowerCase()}`;
  }

  /** Redis 不通就视为「无锁定能力」（available 由 RedisService 暴露，读连接状态）。 */
  private get enabled(): boolean {
    return this.redis.available;
  }

  /**
   * 账号是否当前被锁。登录入口先问它：锁了就省掉 bcrypt 比对、直接拒（也省 CPU）。
   * Redis 不通恒返回 false（不锁）——降级。
   */
  async isLocked(email: string): Promise<boolean> {
    if (!this.enabled) return false;
    const raw = await this.redis.get(this.key(email));
    const n = Number(raw);
    return Number.isInteger(n) && n >= this.maxAttempts;
  }

  /**
   * 记一次失败，返回是否刚好触发锁定。计数器由 Redis 原子自增（见 RedisService.incrWithTtl），
   * 首次失败起算窗口，到期自动归零。
   */
  async recordFailure(email: string): Promise<AttemptResult> {
    if (!this.enabled) return { attempts: 0, locked: false };
    const attempts = await this.redis.incrWithTtl(this.key(email), this.windowSec);
    return { attempts, locked: attempts >= this.maxAttempts };
  }

  /**
   * 登录成功立即清零。这一点很关键：否则合法用户某次手滑输错几次后，
   * 计数器会在窗口内一直挂着，下次哪怕输对也快顶到阈值。成功即抹掉历史。
   */
  async clear(email: string): Promise<void> {
    if (!this.enabled) return;
    await this.redis.del(this.key(email));
  }
}
