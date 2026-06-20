import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RedisService } from './redis.service';

/**
 * RedisLockService —— 基于 `SET NX EX` + Lua 安全释放的分布式锁。
 *
 * 为什么需要分布式锁：进程内的锁（Mutex / 我们的 coalesce）只在「一个进程」里有效。
 * 生产部署通常是多实例（多 Pod），每个进程各自一把内存锁，根本互不可见——同一个 key
 * 的并发请求会被 N 个实例各放一个过去。要「全集群只放一个」，锁必须放在所有实例都看得到
 * 的地方：Redis。
 *
 * 这把锁的正确性靠三件事，缺一不可：
 *
 * 1. **抢锁原子**：`SET key token NX EX ttl` 一条命令同时做到「不存在才写」+「设过期」。
 *    不能拆成「先 GET 再 SET」——两步之间有窗口，会两人都抢到。
 *
 * 2. **必带 TTL**：持锁进程如果崩溃，没来得及释放，锁要能自动过期，否则后续所有人都永远抢不到
 *    （「锁死了」）。EX 就是这道保险。代价是：TTL 内若任务没跑完，锁会提前释放、被别人抢走——
 *    所以 TTL 要略大于「最慢一次临界区执行」，且临界区要尽量短。
 *
 * 3. **释放要「只删自己的」**：用 token（随机串）标记「这把锁是我抢的」。释放时必须「比对 token
 *    相等才删」。关键：比对和删除必须原子——不能先 GET 比对再 DEL，否则中间锁过期、被别人
 *    重新抢走，你这一删就把别人的锁删了。用 Lua 脚本（Redis 单条脚本原子执行）一气呵成。
 *
 * 这把锁用在缓存击穿（thundering herd）的「分布式重建」上：同一个 key 全集群只让一个实例查库
 * 回填，其余实例排队等缓存（见 PostsService.rebuildUnderLock）。
 */
@Injectable()
export class RedisLockService {
  /** 安全释放脚本：GET 出来 == 我的 token 才 DEL，否则不动（说明锁已易主/已过期）。 */
  private static readonly RELEASE_SCRIPT = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    else
      return 0
    end
  `;

  constructor(private readonly redis: RedisService) {}

  /**
   * 抢锁。成功返回一个唯一的 token（释放时凭它认领）；失败（锁被占 / Redis 不可用）返回 null。
   * ★ token 随机：保证只有「真正抢到锁的那个进程」能释放它，别人误删不了。
   */
  async acquire(key: string, ttlSeconds: number): Promise<string | null> {
    if (!this.redis.available) return null;
    const token = randomUUID();
    const ok = await this.redis.setNx(key, token, ttlSeconds);
    return ok ? token : null;
  }

  /** 释放锁。Lua 脚本保证「比对 token + 删除」原子。token 不匹配（锁已易主）则什么都不删。 */
  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(
      RedisLockService.RELEASE_SCRIPT,
      [key],
      [token],
    );
  }

  /**
   * 抢锁 → 执行 fn → 释放（finally 保证释放）。抢不到返回 undefined，调用方据此降级。
   * 用它把「临界区」包起来最省心：拿不到锁不会傻等，直接降级走旁路。
   */
  async withLock<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T | undefined> {
    const token = await this.acquire(key, ttlSeconds);
    if (token === null) return undefined;
    try {
      return await fn();
    } finally {
      await this.release(key, token);
    }
  }
}
