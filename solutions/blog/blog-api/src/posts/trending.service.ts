import { Injectable } from '@nestjs/common';
import { RedisService } from '../cache/redis.service';

/**
 * TrendingService —— 用 Redis Sorted Set 维护「热门文章排行榜」。
 *
 * 为什么用 ZSET 而不是在数据库里 ORDER BY view_count：
 *   - 排行榜是「写极频繁」（每次浏览都加分）+「读要按名次取 Top N」的组合。
 *     ZSET 的 ZINCRBY 是原子加分、ZREVRANGE 是 O(log N + N) 取前 N，全在内存里，
 *     比每次都 `ORDER BY view_count DESC LIMIT N`（要全表排序 / 靠索引）快得多、对 DB 零压力。
 *   - 这是 Redis「数据结构服务器」价值的典型体现：把「高频写 + 排序取」下推成两条原子命令。
 *
 * 分数怎么定义：这里用最朴素的「累计浏览数」（每次浏览 ZINCRBY +1）。
 *   真实「热门」通常要时间衰减（让新内容有机会上榜、老内容淡出），比如 score = Σ 浏览 × 衰减因子，
 *   或定期把旧分数衰减。本 demo 用累计浏览数足够讲清 ZSET；README 会展开时间衰减的思路。
 *
 * ★ 和缓存一样：Redis 挂了排行榜就退化成「直查 DB 取 Top N」，绝不让接口挂掉。降级由调用方处理。
 */
@Injectable()
export class TrendingService {
  /** 全局唯一的排行榜键。所有文章共用一个 ZSET：member=post id，score=浏览数。 */
  static readonly KEY = 'hot:posts';

  constructor(private readonly redis: RedisService) {}

  /** 某文章浏览 +1 → 给它在榜上的分数 +1。原子，多实例并发安全。 */
  async bump(postId: string): Promise<void> {
    if (!this.redis.available) return; // Redis 不通就跳过——排行榜滞后无所谓，浏览本身照常落 DB
    await this.redis.zincrby(TrendingService.KEY, 1, postId);
  }

  /** 某文章被删 → 从榜上摘掉，免得排行榜里挂着已删除的 id。 */
  async drop(postId: string): Promise<void> {
    await this.redis.zrem(TrendingService.KEY, postId);
  }

  /**
   * 取 Top N。返回 [{ id, score }]，分数从高到低。
   * Redis 不可用、或榜为空（还没人浏览过）→ 返回 []，调用方据此回退到「DB 按 view_count 取」。
   */
  async top(limit: number): Promise<Array<{ id: string; score: number }>> {
    if (!this.redis.available) return [];
    const rows = await this.redis.zrevrangeWithScores(
      TrendingService.KEY,
      0,
      Math.max(0, limit - 1),
    );
    return rows.map((r) => ({ id: r.member, score: r.score }));
  }

  /** 仅测试用：清空榜单。 */
  async reset(): Promise<void> {
    await this.redis.del(TrendingService.KEY);
  }
}
