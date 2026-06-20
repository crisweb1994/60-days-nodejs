# Day 37 — Redis 进阶应用

> Day 36 我们搭起了 Redis 缓存，但那张「诚实清单」留了好几个尾巴：击穿守卫只在单进程内有效、TTL 没有抖动会雪崩、负结果没缓存会穿透、限流还停在进程内。
>
> 这一天就是来兑现这些「留到以后」的。除了把缓存的三个老坑（穿透 / 击穿 / 雪崩）真正补上，还要吃透两个 Redis 的招牌用法：**Sorted Set 排行榜**和**分布式锁**。它们共同说明一件事——Redis 的价值不在「比数据库快」，而在「把高频写的、要排序的、要互斥的逻辑，下推成一条原子命令」。

## 📋 今日目标

- 用 **Sorted Set** 做一个「热门文章排行榜」，体会 ZSET 为什么是排行榜的本命结构
- 吃透**分布式锁**的正确姿势：`SET NX EX` 抢锁 + Lua 脚本安全释放，以及每一步为什么不能少
- 把 Day 36 留的三个坑真正补齐：**穿透（负缓存）/ 击穿（分布式锁重建）/ 雪崩（TTL 抖动）**
- 理解**发布订阅（Pub/Sub）**的能力边界，说清它和「消息队列」（Day 38）的差别

> 配套代码：`solutions/blog/blog-api/`。新增 `src/cache/redis-lock.service.ts`（分布式锁）、`src/posts/trending.service.ts`（ZSET 排行榜）；
> `RedisService` 补齐 ZSET / `SET NX` / Lua `eval` 能力；`PostsService` 的 `findOne` 升级为「分布式锁重建 + 负缓存 + TTL 抖动」，新增 `GET /posts/trending`；
> 仓储加 `findTopByViewCount`（排行榜的 DB 兜底）；新增 `test/redis-advanced.e2e.test.ts`（排行榜 / 锁 / 负缓存）。

---

## 📖 核心知识点

### 1. 这天在解决什么：把「留到以后」兑现

先把 Day 36 的尾巴摆出来，对照今天怎么补：

| Day 36 留的问题 | 后果 | Day 37 的对策 |
|---|---|---|
| 击穿守卫 `coalesce` 只在**单进程**有效 | 多实例部署时，N 个 Pod 各放一个请求打穿 DB | **分布式锁**（`SET NX EX`）：全集群同一个 key 只让一个实例查库 |
| TTL 全站统一，没有抖动 | 一次性预热的大量 key 同期过期 → **雪崩** | 给 TTL 加**随机抖动**，错开过期时刻 |
| 负结果（不存在的 id）不缓存 | 攻击者拿一堆假 id 反复打 → **穿透**到 DB | **负缓存**：把「不存在」也短缓存一段 |
| 排行榜只能 `ORDER BY view_count` | 高频浏览 + 频繁取 Top N，全压在 DB 上 | **Sorted Set**：把加分和排序下推成两条原子命令 |

带着这张表读后面的每一节，会发现它们都在回答同一个问题：**怎么在不牺牲正确性的前提下，把数据库挡在后面。**

### 2. Sorted Set：排行榜的本命结构

排行榜的需求长这样：**写极频繁**（每次浏览都要给文章加分），**读要按名次取 Top N**。这个组合在关系库里很别扭——

```sql
-- 每次取榜都要全表（或索引）排序
SELECT * FROM posts ORDER BY view_count DESC LIMIT 10;
```

浏览是高频写，每次写完都要维护一个有序结构才能快速取 Top N。SQL 做这件事要么靠 `view_count` 上的索引（但浏览每次 `+1` 都要更新索引，写放大严重），要么每次取榜现排（CPU 全花在排序上）。

Sorted Set（ZSET）正是为这个需求生的：**member（成员）→ score（分数）的有序去重集合**，Redis 自动按 score 维护顺序。三个操作各一行命令搞定：

```
ZINCRBY hot:posts 1 <postId>          # 给某文章 +1 分（原子，不存在则按 0 起算）
ZREVRANGE hot:posts 0 9 WITHSCORES    # 取分数最高的前 10 名（从高到低）
ZREM hot:posts <postId>               # 文章被删，从榜上摘掉
```

- `ZINCRBY` 是原子加分，多实例并发浏览不会丢计数（和 Day 36 讲的 `INCR` 同理）。
- `ZREVRANGE` 取前 N 是 `O(log N + N)`，全在内存里，比 SQL 排序快一两个数量级，且**对 DB 零压力**。

落地（`src/posts/trending.service.ts`）：

```ts
// 浏览时加分
async bump(postId: string) {
  if (!this.redis.available) return;          // Redis 不通就跳过——浏览本身照常落 DB
  await this.redis.zincrby(TrendingService.KEY, 1, postId);
}
// 取 Top N：返回 [{id, score}]，分数从高到低
async top(limit: number) {
  if (!this.redis.available) return [];       // 不通/榜空 → 返回 []，调用方走 DB 兜底
  return (await this.redis.zrevrangeWithScores(TrendingService.KEY, 0, limit - 1))
    .map((r) => ({ id: r.member, score: r.score }));
}
```

`GET /posts/trending` 先问 ZSET；榜空或 Redis 不可用，就回退到 `repo.findTopByViewCount`（DB `ORDER BY view_count DESC LIMIT N`）。**排行榜和缓存一样，是可降级层——挂了只是「退回慢路径」，绝不让接口挂。**

两个**分数怎么设计**的点，值得想透：

- **我们用「累计浏览数」当分数**，简单、和 `view_count` 一致。但真实「热门」通常要**时间衰减**——否则一篇三年前的爆款会永远霸榜。常见做法：score = `Σ 浏览 × 衰减因子`，或定时任务把全榜分数乘个小于 1 的系数（老内容淡出、新内容有机会上榜）。本 demo 用累计浏览数够讲清 ZSET，时间衰减留给你按业务定。
- **榜单别无限膨胀**：ZSET 里可能挂着已删文章的 id。我们 `remove` 时 `ZREM` 清掉；生产还可以用 `ZREMRANGEBYRANK` 定期裁剪，只留 Top N，控制内存。

### 3. 分布式锁：`SET NX EX` + Lua 安全释放

Day 36 的 `coalesce` 只在一个进程里有效——它用的是进程内的 `Map`。生产部署通常是多实例（多 Pod），每个进程各一把内存锁，**彼此根本看不见**，同一个 key 的并发请求会被 N 个实例各放一个过去。要「全集群只放一个」，锁必须放在所有实例都看得到的地方：Redis。

一把**正确**的分布式锁，靠三件事，缺一不可：

**① 抢锁要原子：`SET key token NX EX ttl`**

```ts
// src/cache/redis.service.ts
async setNx(key, value, ttlSeconds) {
  const res = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
  return res === 'OK';   // 抢到了 = 键原先不存在；false = 已被占
}
```

经典反面教材是老版本的 `SETNX` + `EXPIRE` 两条命令：`SETNX` 抢到锁后、`EXPIRE` 设过期前，进程崩了——锁就**永远不会释放**（没 TTL），后面所有人都抢不到，系统「锁死」。`SET NX EX` 是 Redis 2.6.8 起的一条命令，把「不存在才写」和「设过期」**原子地**合一，从根上堵掉这个窗口。

**② 必带 TTL**

持锁进程如果崩溃（没来得及释放），锁要能自动过期。`EX` 就是这道保险。代价：TTL 内任务若没跑完，锁会提前释放、被别人抢走——所以 **TTL 要略大于「最慢一次临界区执行」**，且临界区要尽量短（我们的锁只护「查库 + 回填缓存」，毫秒级）。

**③ 释放要「只删自己的」——靠 Lua 脚本**

这点最反直觉、也最容易写错。直觉是「释放就 `DEL` 呗」，但考虑这个时序：

```
进程 A 抢到锁（token=A），TTL=3s
进程 A 的临界区卡了 4s，锁自动过期
进程 B 抢到锁（token=B）
进程 A 终于跑完，执行 DEL —— 把 B 的锁删了！
```

A 删掉的不是自己的锁，是 B 的。B 以为它还持着锁，结果锁没了，第三个进程 C 又抢进来——互斥被破坏。

正确做法：释放时**先比对 token（证明这把锁确实是我的）再删**，且「比对 + 删除」必须**原子**（否则两步之间锁过期易主，又回到上面的问题）。Redis 单条 Lua 脚本是原子执行的，正好用它：

```ts
// src/cache/redis-lock.service.ts
private static readonly RELEASE_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then   -- 是我的 token 吗？
    return redis.call('DEL', KEYS[1])             -- 是：删
  else
    return 0                                      -- 不是（已易主/已过期）：什么都不动
  end
`;
```

token 是抢锁时生成的随机串，释放时凭它「认领」。这样**只有真正持锁的进程能释放**，误删不了别人的。

落地后，我们用这把锁来修 Day 36 的击穿（见下一节），这是它最经典的用武之地。其它常见场景：分布式定时任务去重（「每分钟全集群只跑一次」）、防库存超卖（「扣库存」临界区加锁）。

### 4. 缓存击穿：从单进程守卫升级到分布式锁

Day 36 的 `coalesce` 把「同一个 key 的并发未命中」在进程内合并成一次 DB 查询。今天在它外面再套一层**分布式锁**，让效果跨进程：

```ts
// src/posts/posts.service.ts —— findOne 未命中后的重建
private async rebuildUnderLock(id, key) {
  const token = await this.locks.acquire(`lock:post:${id}`, this.lockTtl);
  if (token !== null) {
    try {
      // ★ 双重检查：等锁的这段时间，别人可能已经把缓存回填了——别再白查一次库
      const rechecked = await this.cache.get(key);
      if (rechecked !== null) return rechecked === NEGATIVE ? throw404() : deserialize(rechecked);
      return this.loadAndCache(id, key);   // 真正查库 + 回填
    } finally {
      await this.locks.release(`lock:post:${id}`, token);
    }
  }
  // 没抢到锁：有人在重建，短暂轮询等缓存出现
  for (let i = 0; i < 20; i++) { await sleep(50); const c = await cache.get(key); if (c) return ...; }
  // 等不到（持锁者崩了）——可用性优先，宁可多查一次也不能让请求干等
  return this.loadAndCache(id, key);
}
```

三个细节，每个都对应一个真实坑：

- **双重检查（double-check）**：抢到锁后，先再 `GET` 一次缓存。因为你排队等锁的这几毫秒里，前一个持锁者可能已经查完库、回填好了——直接用它的结果，省一次 DB 查询。这是锁 + 缓存组合的标准动作。
- **没抢到锁的去轮询、不傻等**：让没抢到锁的请求短暂轮询缓存（这里最多 ~1s），等持锁者回填。**不能无限等**——持锁者万一崩了，你等的是永远。轮询超时就走兜底直查，保住可用性。
- **`coalesce` 仍然留着**：进程内的 `coalesce` 是零成本的一层（不耗 Redis 往返），先它在进程内合并，再让分布式锁处理跨进程。两层叠加，既省 Redis 调用又跨进程安全。

> 一句话：**`coalesce` 管「一个进程内」，分布式锁管「整个集群」。** 单机用前者够了，多实例必须上后者——这正是 Day 36 把它推迟到今天的原因。

### 5. 缓存穿透：负缓存 与 布隆过滤器

先把**穿透**和**击穿**分清——这俩名字像、成因完全不同：

- **击穿**：key **存在**，但缓存刚好过期，高并发同时 miss。（Day 36 `coalesce` + 今天分布式锁解决）
- **穿透**：查一个**根本不存在**的 key，缓存永远 miss，每次都打到 DB。攻击者拿一堆假 id 反复打，就能把 DB 打垮。

穿透有两类对策，适用场景不同：

**① 负缓存（negative cache）——我们用这个**

把「不存在」也缓存起来，用一个正常数据绝不可能出现的哨兵值标记：

```ts
// src/posts/posts.service.ts
private async loadAndCache(id, key) {
  try {
    const post = await this.loadById(id);
    await this.cache.set(key, this.serialize(post), this.jitteredTtl(this.postTtl));
    return post;
  } catch (e) {
    // 穿透对策：查不到（404）就把「不存在」短缓存一段，挡住对同一假 id 的反复穿透
    if (e instanceof BusinessException && e.bizCode === ErrorCodes.POST_NOT_FOUND) {
      await this.cache.set(key, NEGATIVE, this.negativeTtl);   // ★ 短 TTL
    }
    throw e;   // 照样抛 404
  }
}
```

下次同一个假 id 来，缓存里是哨兵 → 直接 404，不碰 DB。**代价**：这段 TTL 内，这个 id 即便被创建了也读不到（要等负缓存过期）。所以负缓存 **TTL 故意短**（默认 30s）——「不存在」本就是异常态，过期要快，让被误判的 id 能尽快重新查证。这又是那个永恒的权衡：**挡穿透的力度 vs 数据新鲜度**，负缓存选了「短 TTL」偏向新鲜度。

**② 布隆过滤器（Bloom Filter）——大 key 空间才值得**

负缓存的问题是：如果攻击者每次用**不同**的假 id，你缓存了一堆「不存在」，内存被无意义占满。当 key 空间巨大（比如短链解析、海量商品 id 是否存在），负缓存不划算，上**布隆过滤器**：

- 一个概率数据结构，能用极小内存记住「哪些 id 可能存在」。
- 查询返回「可能存在」或「一定不存在」。「一定不存在」直接拦掉，连缓存都不查。
- 代价：有假阳性（说「可能存在」但实际不存在，少数穿透漏过去），但绝不会漏掉「不存在」。
- Redis 有 RedisBloom 模块（`BF.ADD` / `BF.EXISTS`），或用 `ioredis-bloom`。

博客场景假 id 攻击面小，负缓存足够；**只有当「不存在的 key」量级巨大时，布隆过滤器才值得引入**。两者不互斥，大系统常组合用：布隆挡掉绝大部分「一定不存在」，负缓存兜住漏网的少数。

### 6. 缓存雪崩：TTL 抖动

雪崩的成因一句话：**大量 key 在同一时刻过期**。常见于「缓存预热」——启动时批量灌进去，TTL 都设成一样的，到点集体消失，下一秒全部 miss，DB 被集中轰击。

对策极简——**给 TTL 加随机抖动**，错开过期时刻：

```ts
// src/posts/posts.service.ts
private jitteredTtl(base: number): number {
  const jitter = this.config?.get('redis.ttlJitterSec', { infer: true }) ?? 60;
  return base + Math.floor(Math.random() * (jitter + 1));   // 300s → 300~360s 之间随机
}
```

`findAll` 和 `findOne` 的回填都用 `jitteredTtl`。原本「全在第 300 秒过期」变成「散布在 300~360 秒」，过期时刻被打散，DB 不再被集中轰击。

> 更进一步的玩法是**热点 key 永不过期 + 逻辑过期**：TTL 设成永不过期，value 里带一个「逻辑过期时间」，后台异步刷新。彻底没有「物理过期瞬间」的击穿。代价是复杂度和「逻辑过期后短暂陈旧」。我们没做到这步——抖动已经够挡住常规雪崩。

### 7. 发布订阅（Pub/Sub）：能力与边界

最后讲清 Pub/Sub——它常和「消息队列」混为一谈，其实是两种不同的东西。

Redis 的 Pub/Sub 三条命令：

```
SUBSCRIBE chan1 chan2        # 订阅频道（可同时订多个）
PUBLISH chan1 "hello"        # 向频道发消息——所有【当前在线】的订阅者 instantly 收到
UNSUBSCRIBE chan1            # 退订
```

它的特点决定了它的边界：

- **即时、无持久化**：`PUBLISH` 时谁在线谁收到，**没人接就丢了**。不像缓存会存起来。
- **无回放**：后订阅的收不到历史消息。
- **无 ACK / 无重试**：发出去就算完，订阅者处理崩了也没人重发。

所以 Pub/Sub 适合**「在线才关心、丢了无所谓」**的实时广播：聊天室、实时通知推送、配置/缓存失效广播（一个实例清了缓存，PUBLISH 让其它实例也清）。**不适合**「必须送达」的任务——比如「用户注册后发邮件」：如果发邮件的服务那一刻不在线，消息就永久丢了。

后者正是**消息队列**要解决的：持久化、ACK 确认、失败重试、死信兜底。Redis 上做队列，工业界用 **BullMQ**（基于 Redis 的 List/Stream）而不是裸 Pub/Sub。这就是 **Day 38 的主题**——届时你会清楚看到「队列」相比「Pub/Sub」多出来的那一整层可靠性。

> 本项目今天没接 Pub/Sub：我们要的「评论通知异步发送」是「必须送达」的场景，属于 Day 38 的队列。今天把它的原理和边界讲清，是为了明天选型时不踩「用 Pub/Sub 当队列」的坑。

### 8. 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `src/cache/redis.service.ts` | 补 `setNx`（SET NX EX）、`eval`（Lua）、`zincrby` / `zrem` / `zrevrangeWithScores`（ZSET），全带优雅降级 |
| `src/cache/redis-lock.service.ts` | **新增**：分布式锁。`SET NX EX` 抢锁 + Lua 脚本安全释放 + `withLock` 包装 |
| `src/cache/cache.module.ts` | 导出 `RedisLockService` |
| `src/posts/trending.service.ts` | **新增**：ZSET 排行榜。`bump`/`drop`/`top`/`reset`，不可用时返回空 |
| `src/posts/posts.service.ts` | `findOne` 升级（分布式锁重建 + 负缓存 + TTL 抖动）；`incrementView` 顺手 `bump`、`remove` 顺手 `drop`；新增 `trending(limit)` |
| `src/posts/posts.controller.ts` | 新增 `GET /posts/trending`（静态路径，置于 `:id` 前；limit 解析+钳制） |
| `src/posts/repositories/*.ts` | 接口 + Prisma + InMemory 都加 `findTopByViewCount`（排行榜 DB 兜底） |
| `src/config/{configuration,config.validation}.ts` | 加 `CACHE_TTL_JITTER` / `NEGATIVE_CACHE_TTL` / `LOCK_TTL` |
| `test/redis-advanced.e2e.test.ts` | **新增**：排行榜排序 / 排行榜 DB 兜底 / 锁互斥+安全释放 / 负缓存 |

### 9. 一份诚实清单

✅ **今天到位的：**
- Sorted Set 排行榜（ZSET 加分 + 取 Top N + DB 兜底 + 删除摘榜）
- 分布式锁三件套（原子抢锁 / TTL / Lua 安全释放），用在缓存击穿的分布式重建上
- 击穿：`coalesce`（进程内）+ 分布式锁（跨进程）双层防护，带双重检查
- 穿透：负缓存（短 TTL 哨兵）
- 雪崩：TTL 随机抖动

⚠️/❌ **还没做、明确知道的缺口：**
- **排行榜时间衰减**：现在分数是累计浏览数，老爆款会长期霸榜；真实「热门」要衰减
- **布隆过滤器**：穿透只用了负缓存；若假 id 量级巨大，该上布隆（RedisBloom）
- **热点 key 逻辑过期**：雪崩只靠抖动，没做「永不过期 + 后台异步刷新」
- **分布式锁的「看门狗」续期**：我们的锁 TTL 固定，临界区超时就会提前释放。Redisson 那种「持锁期间自动续期」我们没实现——临界区要尽量短来规避
- **限流上 Redis**：Day 35/36 都提过，`@nestjs/throttler` 现在仍是进程内计数，多副本额度翻倍。这是 Redis 下一个明确用武之地

---

## 💻 实践练习

1. **看排行榜**：起服务，建 3 篇文章，`POST /posts/<a>/view` 连打几次让 A 浏览数最高。`curl http://localhost:3000/posts/trending`，确认 A 排第一。`docker exec redis-blog redis-cli ZRANGE hot:posts 0 -1 WITHSCORES` 亲眼看 ZSET 里的分数。
2. **验证锁互斥**：用 `RedisLockService` 抢同一把锁——第二次应返回 `null`；用错误 token `release` 应无效（锁还在），正确 token 才释放。
3. **验证负缓存**：`curl http://localhost:3000/posts/<假uuid>` → 404；`redis-cli GET post:<假uuid>` 应看到 `NOT_FOUND` 哨兵。再 `curl` 一次还是 404（命中负缓存，没查库）。
4. **验证抖动**：`.env` 设 `POST_CACHE_TTL=300`、`CACHE_TTL_JITTER=60`，读一篇文章后 `redis-cli TTL post:<id>`，应在 300~360 之间随机，每次回填都不同。
5. **思考题**：如果持锁的进程在「查库」途中卡死了（没崩、就是慢），TTL 到期锁被别人抢走——这时会发生什么？怎么避免？（提示：看门狗续期 / 临界区只做不可中断的操作；释放时的 token 比对能防住「删错锁」，但防不住「两人同时持锁」——这才是 TTL 必须够长的根因）

---

## ✅ 今日产出

- [ ] 完成核心知识点学习（Sorted Set / 分布式锁 / 穿透·击穿·雪崩 / Pub/Sub 边界）
- [ ] 跑通 `redis-advanced.e2e.test.ts`，用 `redis-cli` 亲眼看 ZSET 分数和负缓存哨兵
- [ ] 在笔记里写下「我的项目里哪些场景该用分布式锁、哪些该用 Pub/Sub、哪些该用消息队列」
- [ ] 提交代码到 GitHub

---

[⬅️ Day 36](../day-36/) | [➡️ Day 38](../day-38/)
