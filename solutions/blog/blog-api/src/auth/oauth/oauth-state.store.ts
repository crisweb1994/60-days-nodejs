import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/**
 * OAuth 的 state 存储（防 CSRF）。
 * 流程：发起授权前生成一个随机 state、记下来，跳转时带给 GitHub；GitHub 回调时原样带回，
 * 我们核对 + 一次性消费。攻击者无法伪造一个我们认识的 state，于是没法把别人的回调塞给你。
 *
 * ⚠️ 这里用内存 Map：单实例、重启即丢。多实例 / 生产应放 Redis（Day 36）并带 TTL。
 */
@Injectable()
export class OAuthStateStore {
  private readonly store = new Map<string, number>(); // state → 过期时间(ms)
  private readonly ttlMs = 10 * 60 * 1000; // 10 分钟

  generate(): string {
    const state = randomBytes(16).toString('hex');
    this.store.set(state, Date.now() + this.ttlMs);
    this.sweep();
    return state;
  }

  /** 一次性消费：存在且未过期 → 删掉并返回 true；否则 false（用过 / 不存在 / 过期都拒） */
  consume(state: string): boolean {
    const expiresAt = this.store.get(state);
    if (expiresAt === undefined) return false;
    this.store.delete(state);
    return expiresAt > Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [s, exp] of this.store) {
      if (exp <= now) this.store.delete(s);
    }
  }
}
