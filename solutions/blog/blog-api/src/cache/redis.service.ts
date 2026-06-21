import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import type { AppConfig } from '../config/configuration';

/**
 * RedisService —— 包一层 ioredis，对外只暴露「键值 + 优雅降级」的最小能力。
 *
 * 为什么不直接把 ioredis client 注得到处都是：
 *   1. 统一错误兜底。Redis 是缓存，不是真相源——它挂了，读请求要照常走数据库、
 *      写请求照常成功，绝不能因为缓存故障把 API 打成 500。这一层把每条命令都
 *      try/catch：出错就「当缓存不存在」（get→null，set/del→静默忽略），并限频打日志。
 *   2. 集中管理连接生命周期：onModuleDestroy 时关闭连接，把资源干净还给 Redis。
 *   3. 换实现（Cluster / Sentinel / 自建协议）只动这一个文件。
 *
 * ★ 注意它和 PrismaService 的哲学正好相反：
 *   - PrismaService（真相源）：连不上就启动崩溃（fail fast）。
 *   - RedisService（缓存）：连不上就降级、绝不能拖垮主流程。
 *   一句话区分：数据库挂了系统没法工作，缓存挂了只是变慢——这是「缓存」二字的全部含义。
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService<AppConfig, true>) {
    const url = config.get('redis.url', { infer: true });
    this.client = new Redis(url, {
      // 缓存要求「快速失败」：连不上时，别让请求在命令队列里无限重试干等。
      // 默认值 null 会无限重试（这对真相源合适，对缓存是灾难——一个 get 能挂住整个请求）。
      // 设成 1：每条命令最多重试一次就 reject，外层 try/catch 再把它变成「缓存未命中」。
      maxRetriesPerRequest: 1,
      // 连不上时不排队：立刻 reject，请求以「无缓存」状态继续，不被拖慢。
      enableOfflineQueue: false,
    });

    // ★ ioredis 的 'error' 事件如果没人接，会冒泡成 Node 进程 uncaughtException 直接崩溃。
    //   缓存绝不能搞崩进程——必须接住，这正是这一层存在的理由之一。
    let down = false;
    this.client.on('error', (err) => {
      if (!down) {
        down = true;
        // 只在「刚掉线」那一刻记一次 WARN；重连途中反复触发的 error 不刷屏。
        this.logger.warn(`Redis 不可用，缓存降级为直连数据库：${err.message}`);
      }
    });
    this.client.on('ready', () => {
      if (down) {
        down = false;
        this.logger.log('Redis 已恢复，缓存重新生效');
      }
    });
  }

  /** 健康检查 / 探针用：能 PING 通就说明缓存层活着。 */
  async ping(): Promise<boolean> {
    try {
      const reply = await this.client.ping();
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * 缓存层是否「看起来」可用（连接已就绪）。
   * service 用它在请求入口先判断：不通就 BYPASS，省掉一次注定失败的命令。
   * ★ 它只是个快速启发式（读 ioredis 的 status），不是绝对真相——status 说 ready 但恰好这一瞬断开，
   *   后面的 get/set 仍可能抛，那由各命令自己的 try/catch 兜成 miss。两层一起，既快又稳。
   */
  get available(): boolean {
    return this.client.status === 'ready';
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (e) {
      this.debugMiss(key, e);
      return null; // 出错当未命中，直连 DB
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      // EX = 秒级过期。TTL 是缓存的「兜底失效」——哪怕忘了自己主动 del，
      // 到期也会自动消失，保证数据最终一致（见 README「缓存失效的三道防线」）。
      await this.client.set(key, value, 'EX', ttlSeconds);
    } catch (e) {
      this.debugMiss(key, e);
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (e) {
      this.debugMiss(key, e);
    }
  }

  // ── Day 40：账号锁定要的「带 TTL 的原子计数器」────────────────────
  /**
   * 自增 key 并在它【第一次被创建时】设过期：`INCR` + 首次 `EXPIRE`，两步用一条 Lua 原子完成。
   *
   * 为什么不写 `INCR` 再 `EXPIRE` 两条普通命令：进程在两者之间崩了，计数器就**永不过期**——
   * 某个邮箱的一次失败永远占着内存、且账号会被永久误锁。和分布式锁里 `SETNX`+`EXPIRE` 的老坑
   * 同构（见 Day 37 §3）。Lua 脚本在 Redis 里原子执行，从根上堵掉这个窗口。
   *
   * 用途：登录失败计数（Day 40 账号锁定）。第一次失败创建计数器并起算窗口（windowSec），
   * 后续失败只 INCR、不续期——窗口固定从首次失败起算，到期自动归零、账号自动解锁。
   * 返回当前累计次数；Redis 出错则返回 0（调用方据此降级成「不做锁定」）。
   */
  async incrWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const script = `
      local n = redis.call('INCR', KEYS[1])
      if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
      return n
    `;
    try {
      const n = await this.client.eval(script, 1, key, ttlSeconds);
      return typeof n === 'number' ? n : 0;
    } catch (e) {
      this.debugMiss(key, e);
      return 0;
    }
  }

  // ── Day 37：分布式锁要的 SET NX EX ──────────────────────────────────
  /**
   * 「只在键不存在时写入，并设过期」——SET key value NX EX。
   * 返回 true = 抢到了（键原先不存在、刚被你设上）；false = 键已存在（别人占着）。
   * 这是分布式锁的原子基石：NX（不存在才写）+ EX（必带过期，防持锁者崩了锁永不释放）二合一，一条命令原子完成。
   */
  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    try {
      const res = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return res === 'OK';
    } catch (e) {
      this.debugMiss(key, e);
      return false; // 出错当没抢到——调用方降级，不阻塞业务
    }
  }

  /**
   * 执行 Lua 脚本。Redis 保证单条 Lua 脚本「原子执行」（脚本跑的时候，别的命令都得排队）。
   * 用来做分布式锁的「安全释放」：先比对 token 再删，这两步必须原子，否则有竞态（见 RedisLockService）。
   */
  async eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    try {
      return await this.client.eval(script, keys.length, ...keys, ...args);
    } catch (e) {
      this.debugMiss(keys.join(','), e);
      return null;
    }
  }

  // ── Day 37：排行榜要的 Sorted Set（ZSET）命令 ──────────────────────
  // ZSET = member（成员）→ score（分数）的有序去重集合，Redis 自动按 score 排序。排行榜的本命结构。

  /** 给某成员加分（原子）。`ZINCRBY key incr member`——不存在则按 0 起算。 */
  async zincrby(key: string, incr: number, member: string): Promise<void> {
    try {
      await this.client.zincrby(key, incr, member);
    } catch (e) {
      this.debugMiss(key, e);
    }
  }

  /** 删掉某成员。`ZREM key member`。 */
  async zrem(key: string, member: string): Promise<void> {
    try {
      await this.client.zrem(key, member);
    } catch (e) {
      this.debugMiss(key, e);
    }
  }

  /**
   * 按 score 从高到低取一段成员 + 分数：`ZREVRANGE key start stop WITHSCORES`。
   * 返回 [{ member, score }]。排行榜「取 Top N」就靠它——一条命令拿到前 N 名，O(log N + N)。
   */
  async zrevrangeWithScores(
    key: string,
    start: number,
    stop: number,
  ): Promise<Array<{ member: string; score: number }>> {
    try {
      // ioredis 返回 [member, score, member, score, ...] 的扁平数组
      const flat = (await this.client.zrevrange(key, start, stop, 'WITHSCORES')) as string[];
      const out: Array<{ member: string; score: number }> = [];
      for (let i = 0; i < flat.length; i += 2) {
        out.push({ member: flat[i], score: Number(flat[i + 1]) });
      }
      return out;
    } catch (e) {
      this.debugMiss(key, e);
      return [];
    }
  }

  /**
   * 按前缀批量删除——列表缓存失效时用（一篇文章变了，所有页/排序/过滤的列表都可能受影响）。
   *
   * ★ 用 SCAN 游标遍历，绝不用 KEYS：
   *   KEYS 是 O(N) 阻塞命令，会卡住整个 Redis（单线程！），生产库里一调就可能让所有请求超时。
   *   这是 Redis 入门最经典的踩坑，没有之一。SCAN 增量、分批、不阻塞，是唯一正确的姿势。
   *   COUNT 只是「每次建议扫描多少」，不是精确返回数，实际可能多可能少。
   */
  async delByPrefix(prefix: string): Promise<number> {
    let cursor = '0';
    let deleted = 0;
    try {
      do {
        const [next, keys] = await this.client.scan(
          cursor,
          'MATCH',
          `${prefix}*`,
          'COUNT',
          100,
        );
        cursor = next;
        if (keys.length > 0) {
          deleted += await this.client.del(...keys);
        }
      } while (cursor !== '0');
      return deleted;
    } catch (e) {
      this.debugMiss(prefix, e);
      return 0;
    }
  }

  private debugMiss(key: string, e: unknown): void {
    // 调试级：缓存降级不阻塞业务，只在 debug 日志留痕。生产关掉 debug 即可完全静音。
    this.logger.debug(`缓存操作失败（已降级）key=${key} err=${(e as Error).message}`);
  }

  async onModuleDestroy(): Promise<void> {
    // quit() 会先把队列里的命令发完再优雅关闭；连不上时它可能 reject，缓存无关紧要，吞掉即可。
    this.client.quit().catch(() => undefined);
  }
}
