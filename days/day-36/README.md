# Day 36 — Redis 基础与缓存策略

> Day 35 末尾那张「诚实清单」留了个尾巴：分布式撞库要靠 Redis 做全局限流。但 Redis 在我们手里要干的第一件、也是最高频的事，其实是**缓存**——把读得最猛的接口挡在数据库前面。
>
> 这一天的核心不是「背 Redis 命令」，而是搞懂两件事：**Redis 到底是什么**（它不是「一个更快的数据库」），以及**缓存为什么是「加上去容易、加对很难」的东西**。缓存领域有句老话——计算机科学只有两个真正的难题：缓存失效和命名。今天我们正面碰第一个。

## 📋 今日目标

- 用 Docker 起 Redis，过一遍 `redis-cli` 基本命令，建立「内存数据结构」的直觉
- 吃透五种数据结构（String / Hash / List / Set / Sorted Set）各自**擅长什么**，而不是背 API
- 把三种缓存策略（Cache-Aside / Write-Through / Write-Behind）讲清楚，并想明白**为什么 95% 的场景都是 Cache-Aside**
- 认清缓存的三大坑——**穿透 / 击穿 / 雪崩**——的成因与对策
- 在 `blog-api` 真正接一遍 Cache-Aside：读路径回填、写路径失效、`X-Cache` 头可观测、Redis 挂了照样能跑

> 配套代码：`solutions/blog/blog-api/`。新增 `src/cache/redis.service.ts`（ioredis 封装 + 优雅降级）、`src/cache/cache.module.ts`；
> `PostsService` 的 `findOne` / `findAll` 走 Cache-Aside，`create` / `update` / `remove` 做失效；
> 用 `AsyncLocalStorage`（CLS）把缓存命中状态从单例 service 传到 `X-Cache` 响应头（`src/common/request-context.ts` + `cache-header.interceptor.ts`）；
> 新增 `test/cache.e2e.test.ts`（命中 / 失效 / 列表 / 负结果五组用例）。`solutions/blog/blog-db/docker-compose.yml` 加了一个 `redis` 服务，`docker compose up -d` 一起起。

---

## 📖 核心知识点

### 1. 先校准一个认知：Redis 不是「更快的数据库」

很多人第一次接触 Redis，把它理解成「一个比 PostgreSQL 快的数据库」。这个心智模型会把你带偏。更准确的说法是：

> **Redis 是一个「内存里的数据结构服务器」。**

拆开看三个关键词：

- **内存**：数据常驻 RAM。这是它快的根本原因——内存访问是纳秒级，磁盘是毫秒级，差了五六个数量级。代价是：断电/重启数据可能丢（它有持久化，但那是兜底，不是它的本职）。
- **数据结构**：它不只会「按主键存一行」，而是原生支持 String / Hash / List / Set / Sorted Set 这些结构，每个结构配一套「在服务端就能算」的命令（`INCR`、`LPUSH`、`ZADD`、`SINTER`…）。你可以把一段本来要在应用层 for 循环写的逻辑，下推到 Redis 一条命令搞定。
- **服务器**：它是个独立进程，通过网络协议（RESP）通信。你的应用和 Redis 是两个独立故障域——这点决定了后面所有「优雅降级」的设计。

还有一个绕不开的事实：**Redis 命令执行是单线程的**（6.0 之后网络读写多线程，但执行命令仍是串行）。单线程的好处是无锁、好推理；坏处是**一条慢命令会卡住整个实例**。这就是为什么后面会反复强调「绝不用 `KEYS`」——它是 O(N) 且阻塞的，生产环境一调就可能让所有请求排队超时。

把这三点连起来，你就懂了为什么 Redis 在架构里的定位几乎总是：

> **真相源（PostgreSQL）之外的「加速层 / 辅助层」：缓存、限流计数、分布式锁、会话、排行榜……它快、但它存的数据「丢了能恢复」（重新从 DB 回填、重新计数）。**

这定位直接决定了我们今天最重要的一条工程原则：**缓存层挂了，绝对不能让系统跟着挂。** 这也是 `RedisService` 为什么和 `PrismaService` 哲学完全相反——后面细讲。

### 2. 起 Redis + 过一遍基本命令

`solutions/blog/blog-db/docker-compose.yml` 已经加了 redis 服务（关掉了持久化——缓存丢了无所谓，换来更干净的 dev 体验）：

```yaml
redis:
  image: redis:7-alpine
  container_name: redis-blog
  command: ["redis-server", "--save", "", "--appendonly", "no"]  # 不持久化
  ports:
    - "${REDIS_PORT:-6379}:6379"
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
```

起起来：

```bash
cd solutions/blog/blog-db
docker compose up -d          # 顺便也把 PG 起了
docker exec -it redis-blog redis-cli   # 进交互终端
```

进 `redis-cli` 后，把这几组命令敲一遍，建立手感（`127.0.0.1:6379>` 是提示符）：

```
PING                          # → PONG                  连通性探针
SET greeting "hello" EX 60    # → OK                    存一个键，60 秒后自动过期（EX = 秒）
GET greeting                  # → "hello"               取
TTL greeting                  # → (integer) 58          剩余秒数（-1 = 永不过期，-2 = 已不存在/过期）
EXISTS greeting               # → (integer) 1           是否存在
DEL greeting                  # → (integer) 1           删，返回删掉的键数
INCR counter                  # → 1, 再敲 → 2 ...       原子自增（这是个「并发安全计数器」）
```

这里有两个要点，是新手最容易踩的：

- **`SET key value EX 60` 的 `EX` 才是缓存的灵魂**。它给键一个「兜底过期时间」。哪怕你的代码忘了主动删它，60 秒后它自己也会消失。**TTL 不是可选项，是缓存正确性的最后一道防线**——它把「忘了失效」的后果从「永远返回脏数据」降级成「最多脏 60 秒」，保证数据最终一致。后面 `invalidate` 会反复用到这个思路。
- **`KEYS *` 看着很诱人，但千万别在生产用**。它遍历整个 keyspace，是 O(N) 阻塞命令。要「按前缀找键」只能用 `SCAN`（增量、不阻塞）。这一条几乎每个 Redis 教程都会强调，因为踩的人实在太多了——我们的 `delByPrefix` 就是用 `SCAN` 实现的。

### 3. 五种数据结构：为什么叫「数据结构服务器」

Redis 的五个基础结构，记住**每个结构擅长解决哪类问题**比记命令重要得多：

| 结构 | 一句话定位 | 典型场景 | 代表命令 |
|---|---|---|---|
| **String** | 一个值（字符串/数字/序列化 JSON 都行） | 缓存对象、计数器、限流桶、分布式锁 | `SET`/`GET`/`INCR`/`SETNX` |
| **Hash** | 一个对象的多个字段（field→value） | 用户资料、商品属性——想单独改一个字段时 | `HSET`/`HGET`/`HINCRBY` |
| **List** | 有序、可重复的双端队列 | 消息队列、最近访问列表、异步任务 | `LPUSH`/`RPOP`/`LRANGE` |
| **Set** | 无序、去重的集合 | 标签、共同好友（交并差）、去重 | `SADD`/`SISMEMBER`/`SINTER` |
| **Sorted Set** | 带分数（score）排序的去重集合 | 排行榜、按时间排序的 feed、延迟队列 | `ZADD`/`ZRANGE`/`ZRANGEBYSCORE` |

几个**容易想错的点**，点破一下：

- **「存一个对象，用 String 还是 Hash？」** 都行，但取舍不同。用 String 你存的是序列化后的 JSON（取出来整个反序列化，改一个字段要读-改-写全量）；用 Hash 你存的是 `field→value`，能 `HINCRBY user:1 viewCount 1` 只动一个字段。**字段会被单独读写 → Hash；对象总是整存整取 → String（缓存层最省事）**。我们今天的文章缓存就是 String 存整篇 JSON。
- **「计数器为什么非得用 Redis 的 `INCR`？」** 因为它是**原子的**。在多进程/多实例下，你在应用层 `read + 1 + write` 是有并发竞争的（两个请求同时读到 5，都写 6，丢一次计数）。Redis 单线程 + `INCR` 一条命令，从机制上保证不丢。Day 35 提的「全局限流要放 Redis」，靠的就是这个原子性 + 过期。
- **「Sorted Set 怎么就成排行榜了？」** `ZADD board user score` 按 score 自动排序，`ZREVRANGE board 0 9` 一条命令拿到 Top 10。换成 SQL 你得 `ORDER BY score DESC LIMIT 10`，数据量大时还要维护索引。Redis 把这件事做到 O(log N)。

今天我们只用 String 做缓存，但理解这五个结构，你才知道「为什么 Redis 不只是个 key-value store」——它的价值在于**把常见的数据操作下推成一条原子命令**。

### 4. 缓存策略三选一：为什么 Cache-Aside 一统江湖

应用层加缓存，本质是回答两个问题：**「读的时候，缓存和数据源怎么配合」「写的时候，先动谁」**。三种经典策略，差别全在「写」上：

| 策略 | 读 | 写 | 特点 |
|---|---|---|---|
| **Cache-Aside（旁路缓存）** | 先查缓存；miss 查 DB，回填缓存 | **只失效缓存**（删掉），让 DB 当唯一写入方 | 最简单；缓存是「可选的」，挂了不影响正确性 |
| **Write-Through（直写）** | 命中直接返回 | **同时写**缓存和 DB（缓存是 DB 的同步镜像） | 强一致；但每次写都要双写，且要处理双写的一致性 |
| **Write-Behind（回写）** | 命中直接返回 | **只写缓存**，异步批量刷 DB | 写延迟最低、吞吐最高；但宕机会丢未刷盘的数据 |

为什么绝大多数业务用 Cache-Aside？因为它把复杂度降到了最低，而且换来一个极其重要的属性：

> **在 Cache-Aside 里，缓存是「可以随时消失」的。** Redis 整个宕机，系统照常工作——只是变慢（直连 DB）。而在 Write-Through 里，写缓存失败你怎么处理？回滚 DB 吗？缓存成了正确性的参与者，它就不再是「可选的」了。

还有一条 Cache-Aside 的关键纪律，初学者经常做错：**写路径要「失效」缓存，而不是「更新」缓存。**

```ts
// ✅ 失效（invalidate）：删掉缓存，下次读自然会从 DB 拿到最新的并回填
await db.update(id, patch);
await cache.del(`post:${id}`);

// ❌ 更新（update）：写完 DB 再去把缓存「改」成新值
await db.update(id, patch);
await cache.set(`post:${id}`, newValue);   // 看似更"新鲜"，其实埋了并发竞赛的雷
```

为什么「更新」更危险？因为「写 DB」和「写缓存」是两个独立操作，中间有窗口。想象两个并发写请求 A、B，执行顺序错乱成 `A写DB → B写DB → B写缓存 → A写缓存`：DB 里是 B 的新值，缓存里却被后到的 A 覆盖成了旧值——缓存和 DB 不一致，且会一直不一致到 TTL 到期。**失效没有这个问题**：删是幂等的，谁先删谁后删结果一样，下次读统一从 DB 重灌。

> 一句话原则：**让数据库当唯一的写入真相源，缓存永远只是它的一个「可能过期的副本」，读的时候按需重建。** 这就是 Cache-Aside 的全部哲学。

Write-Through / Write-Behind 不是没用——金融余额这种要强一致的、写入量极大可以容忍少量丢失的日志/计数场景，分别有它们的位置。但除非你有明确的、非用不可的理由，**默认就选 Cache-Aside**。

### 5. Cache-Aside 落到 blog-api：读路径

我们给「按 id 查单篇」（`GET /posts/:id`）和「列表」（`GET /posts`）接缓存。读路径就是 Cache-Aside 的标准四步——查缓存 → 命中返回 → 未命中查库 → 回填缓存：

```ts
// src/posts/posts.service.ts
async findOne(id: string): Promise<Post> {
  if (!this.cache) {
    setCacheState('BYPASS');            // 没有 Redis（如单测）——直连库，标记 BYPASS
    return this.loadById(id);
  }
  const key = `post:${id}`;
  const cached = await this.cache.get(key);
  if (cached) {
    setCacheState('HIT', key);          // 命中：原样反序列化返回，根本没碰数据库
    return this.deserializePost(cached);
  }
  // 未命中：查库（带击穿守卫，见 §7），回填缓存
  const post = await this.coalesce(key, () => this.loadById(id));
  await this.cache.set(key, this.serialize(post), this.postTtl);   // ★ EX 兜底失效
  setCacheState('MISS', key);
  return post;
}
```

几个**实现里要讲清的决策**：

- **负结果不缓存**。`loadById` 在文章不存在时抛 404，我们**不**把「空」也缓存起来。缓存空值能挡「穿透」（见 §7），但要额外处理空值反序列化、还得给很短的 TTL，复杂度上来了。博客场景查不到 id 的请求很少，我们选择「让 404 直接冒泡、每次真查库」——用一点点 DB 开销换简单。**这是个典型的命中率 vs 复杂度的权衡，要讲明白为什么这么选。**
- **为什么 `Date` 要手动恢复**。`JSON.stringify` 把 `Date` 变成 ISO 字符串，`JSON.parse` 不会把它变回 `Date`——下游若调 `.getTime()` 就炸。所以进缓存前 `stringify`，出来后显式 `new Date(...)` 转回来，保证缓存值和 DB 读出来的一模一样。
- **可观测性：`X-Cache` 头**。`curl -i` 一眼就能看见这次是命中还是没命中，缓存有没有生效立刻可见。难点在「命中状态」产生于**单例 service**（整个应用共享一个实例），却要写到**每个请求**的响应头上——下一节专门讲我们怎么用 CLS 解决。

**为什么只缓存 `findOne` 和 `findAll`，不缓存 `search` / `feed`？** 见 §9「什么不该缓存」——这两个是高基数、强时效的典型反例。

### 6. 让「命中状态」穿透到响应头：AsyncLocalStorage（CLS）

我们想给响应加个 `X-Cache: HIT|MISS` 头，方便观测。问题是：**命中与否是 service 在处理请求时才知道的，而设响应头是 HTTP 边界（拦截器）的事。** service 是单例、看不到 `req`/`res`，怎么把这个「请求级」的状态传出去？

三条路，各自的问题：

1. **把 service 改成请求级（`@Scope(REQUEST)`）**。能直接拿到 `req`，但单例变多例，每个请求重新实例化整个依赖图，性能和心智都不值。
2. **`@Res({ passthrough: true })` 透传到 service**。把 `res` 塞给 service 设头——破坏分层，service 不该知道 HTTP。
3. **AsyncLocalStorage（CLS）**。Node 内置的「按异步调用链传递的上下文」：中间件在最外层 `store.run({}, next)` 开一个上下文，这条请求后续所有的 `await` / Promise 链都能 `getStore()` 拿到**同一份、且只属于这一个请求**的 store，不改任何 provider 的作用域。`nestjs-cls` 这类库底层就是它。

我们用 3。它和项目里「request-id 存在 `req.headers`、拦截器读 `req`」是同一个心智模型，只是存储后端从 Express 的 `req` 换成了 Node 的 ALS——因为这里**写状态的是 service，而 service 看不到 `req`**：

```ts
// src/common/request-context.ts —— 请求级上下文
export const requestContextStorage = new AsyncLocalStorage<{ cache?: CacheState }>();
export function setCacheState(state: CacheState, key?: string) {
  const store = requestContextStorage.getStore();   // 拿当前请求的 store
  if (store) store.cache = state;                   // 写进去
}
```

```ts
// src/common/middleware/request-context.middleware.ts —— 最外层开上下文
use(_req, _res, next) {
  requestContextStorage.run({}, () => next());      // 整条异步链都在这个 store 里
}
```

```ts
// src/common/interceptors/cache-header.interceptor.ts —— 在响应阶段读出来设头
intercept(ctx, next) {
  const res = ctx.switchToHttp().getResponse();
  return next.handle().pipe(tap(() => {             // ★ 等 handler 跑完（service 已写好状态）再读
    const { cache, cacheKey } = getRequestContext();
    if (cache) res.setHeader('X-Cache', cache);
  }));
}
```

**关键细节：为什么在 `tap`（请求成功之后）里读，而不是在 `intercept` 开头？** 因为「命中没命中」是 service 在**处理过程中**才知道的（得先查了缓存才有结论）。所以得等 `next.handle()` 的数据流走完再去读——这时 service 已经把 HIT/MISS 写进 store 了，而 CLS 沿着这条异步链一路传过来，`tap` 里读得到。`RequestContextMiddleware` 必须**最先**挂，否则上下文包不住整条链。

### 7. 失效：缓存最难的命题，以及三大坑

> 「缓存失效」之所以是计算机科学的两大难题之一，难不在「删一个 key」——难在「你怎么知道哪些 key 该删、什么时候删、删错了怎么办」。

**写后失效（post-write invalidation）** 是 Cache-Aside 的写路径标准动作：写完 DB，把可能受影响的缓存删掉。我们在 `create` / `update` / `remove` 里都调了 `invalidate`：

```ts
// src/posts/posts.service.ts
private async invalidate(postId?: string): Promise<void> {
  if (!this.cache) return;
  if (postId) await this.cache.del(`post:${postId}`);          // 单篇：精确删，O(1)
  await this.cache.delByPrefix('posts:list:');                 // 列表：按前缀 SCAN 全清
}
```

这里藏着一个**「列表缓存不划算」的根因**，值得想透：

- **单篇失效是 `DEL` 一个 key，O(1)**。改一篇文章，删 `post:<id>` 就完事，干净利落。
- **列表失效是「按前缀扫」**。改一篇文章，所有页码 / 排序 / 过滤的列表都可能受影响（它可能挪到另一页、改变排序位置），你不知道具体哪个 key 脏，只能**全清**。而「全清」在 Redis 里只能 `SCAN` 遍历（绝不能用 `KEYS`），是 O(N) 的扫描。

这就是为什么缓存教科书都说：**优先缓存「按主键查的实体」，慎缓存「列表 / 聚合查询」**——前者的失效是廉价的，后者的失效是昂贵的。我们两个都做了，是为了让你亲眼看这个差别；真到了生产，列表缓存往往会换成「全局版本号 key」（`posts:list:v3:...`，改一次数据就让版本号 +1，旧 key 自然过期，不扫不删）或「标签失效」这类更高级的玩法。

**该接受多旧的陈旧数据？** 这是缓存设计的核心拷问。我们做了一个刻意的取舍——**浏览数 `viewCount` 不失效**：

```ts
// incrementView：原子 +1 后，故意【不】删 post:<id> 缓存
async incrementView(id: string) {
  const post = await this.repo.incrementViewCount(id);
  /* ... 404 处理 ... */
  return post;   // 不调 invalidate(id)
}
```

理由：浏览数是「低价值、强写入」（每次访问都 +1）的字段。如果每次浏览都清缓存，`findOne` 的缓存基本就废了（刚回填就被清）。我们接受 `viewCount` 在 TTL 内「最终一致」（最多滞后 5 分钟）——对一个显示用的计数，完全够。而**标题**改了就必须立刻失效（用户改完文章、刷新看到旧标题是不能接受的）。**哪些字段「脏了无所谓」、哪些「脏了必须立刻纠正」，是你在加缓存前就要逐字段想清楚的。**

#### 缓存的三大坑

| 坑 | 成因 | 后果 | 对策 |
|---|---|---|---|
| **穿透（penetration）** | 查一个**根本不存在**的 key，缓存永远 miss，每次都打到 DB | 攻击者用一堆假 id 打垮 DB | 缓存空值（短 TTL）/ 布隆过滤器挡掉「不存在的」 |
| **击穿（breakdown）** | **热点 key** 刚过期那一瞬间，大量并发同时 miss，全打到 DB | 瞬间 N 条同样的查询压垮 DB | 互斥锁（只放一个请求去查库）/ 逻辑过期 |
| **雪崩（avalanche）** | **大量 key 同时过期**（比如缓存预热时统一设了相同 TTL） | 同一瞬间全部 miss，DB 被集中轰击 | TTL 加随机抖动，错开过期时间 |

我们对这三个坑的处理，分别对应不同选择，正好覆盖「什么时候值得加复杂度」的判断：

- **穿透**：我们选择**不缓存空值**（§5 说过），让 404 真查库。博客场景假 id 攻击面小，不值得为它引入空值缓存 + 反序列化逻辑。**有明确攻击面（比如开放搜索、短链解析）时再上布隆过滤器。**
- **击穿**：我们**上了**一个单进程的击穿守卫（`coalesce`）——同一个 key 的并发未命中，合并成一次 DB 查询：

  ```ts
  // 同一 key 的在途加载共享一个 Promise，并发 miss 不会打出 N 条同样的 SQL
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private async coalesce<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;          // 别人在查了，等它的结果
    const promise = loader().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
  ```

  它利用了 JS 单线程的特性：`get` 和 `set` 之间没有 `await`，不会被别的微任务插队，所以不会漏。**但要诚实说明它的边界：这只在单进程内有效**。我们的 API 上生产多半是多实例（多 Pod），每个进程各有一个 `inFlight` Map，跨进程的击穿它挡不住——那要靠**基于 Redis 的分布式锁**（`SET key value NX EX 3`，抢到锁的去查库、抢不到的轮询缓存）。这是从「单机缓存」走向「分布式缓存」必须补的一步。
- **雪崩**：我们现在的 TTL 是配置项（`POST_CACHE_TTL` / `LIST_CACHE_TTL`），全站统一。**真到生产，应该给 TTL 加一个随机抖动**（`ttl + random(0, 60s)`），避免同一批回填的 key 在同一秒集体过期。这一步我们没做，留作思考题——因为本地 dev 几乎撞不上雪崩。

### 8. 优雅降级：缓存挂了，系统不挂

这是今天最该内化的一条工程纪律。回到 §1 的定位——Redis 是「真相源之外的加速层」。那么：

> **缓存故障，应该让系统「变慢」，而不是「宕机」。**

这条原则贯穿了 `RedisService` 的每一个设计决策，和 `PrismaService` 形成鲜明对比：

| | `PrismaService`（真相源） | `RedisService`（缓存） |
|---|---|---|
| 连不上时 | **启动崩溃**（`onModuleInit` 里 `$connect` 失败直接挂） | **降级**：每个命令 `try/catch`，出错当「未命中」，请求照常走 DB |
| env 校验 | `DATABASE_URL` 必填，缺了启动报错 | `REDIS_URL` 有默认值，连不上也不阻塞启动 |
| 重试策略 | 可以等（等数据库起来） | **必须快失败**：`maxRetriesPerRequest: 1` + `enableOfflineQueue: false`，绝不让一个 `get` 把请求挂住 |

```ts
// src/cache/redis.service.ts —— 每个命令都包了 try/catch，出错就当 miss
async get(key: string): Promise<string | null> {
  try {
    return await this.client.get(key);
  } catch (e) {
    this.debugMiss(key, e);
    return null;     // ← 出错返回 null = 未命中，service 自然回退到查库
  }
}
```

两个**新手必踩、但坑很隐蔽**的点：

- **ioredis 的 `error` 事件必须有人接**。如果 Redis 连不上，ioredis 会不断发 `error` 事件；Node 里「没人监听的 `error` 事件」会冒泡成 `uncaughtException`，**直接让进程崩溃**。缓存绝不能搞崩进程——所以 `RedisService` 构造里必须 `.on('error', ...)` 接住它。这是这一层存在的核心理由之一。
- **默认的重试策略会害死缓存**。ioredis 默认 `maxRetriesPerRequest: null`——命令在断连期间会无限排队重试，一个 `get` 能把请求挂住几十秒。对数据库这无所谓（你本来就在等它），对缓存是灾难。我们显式设成 `1`（最多重试一次就 reject），让外层 `try/catch` 赶紧转成 miss。

> 一句话总结这条原则：**永远问自己——「如果这一层整个消失了，系统还能正确工作吗？」对缓存，答案必须是「能，只是变慢」。如果答案是「不能」，那它就不是缓存，是真相源，得换一套可靠性设计。**

### 9. 什么不该缓存

缓存不是「加了就快」的银弹。**加错缓存的危害，比不加更大**——它引入了「陈旧数据」和「失效复杂度」两个新问题。这几类数据要克制：

- **高基数的查询**：搜索词组合几乎是无限的，游标分页的 `cursor` 每翻一页就一个新值。缓存命中率趋近 0，还要为它们维护失效——纯负收益。所以我们的 `/posts/search` 和 `/posts/feed` **都不缓存**。
- **强一致性要求的**：账户余额、库存。缓存就意味着「可能读到旧值」，金融场景里这是事故。要么不缓存，要么用 Write-Through 保证强一致。
- **写多读少的**：缓存的价值在读放大。一个疯狂被写、很少被读的字段，缓存命中率低，还要不停失效，得不偿失。
- **个人化 / 会话级数据**：除非真的热，否则别缓存——每个用户一份，键空间膨胀，命中率还低。

判断标准很简单：**这个数据「读远多于写」吗？「短暂陈旧能接受」吗？两个都 yes，才值得缓存。** 博客文章（读多写少、标题旧几秒无所谓）完美符合；实时库存则两个都不符合。

### 10. 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `src/cache/redis.service.ts` | **新增**：ioredis 封装，每命令 `try/catch` 优雅降级，`SCAN` 实现 `delByPrefix`，接 `error` 事件防崩溃 |
| `src/cache/cache.module.ts` | **新增**：`@Global` 模块，全应用可注入 `RedisService` |
| `src/posts/posts.service.ts` | `findOne`/`findAll` 走 Cache-Aside；`create`/`update`/`remove` 调 `invalidate`；`coalesce` 单进程击穿守卫；`incrementView` 故意不失效 |
| `src/common/request-context.ts` | **新增**：AsyncLocalStorage 请求上下文 + `setCacheState` |
| `src/common/middleware/request-context.middleware.ts` | **新增**：最外层 `.run` 开 CLS 上下文 |
| `src/common/interceptors/cache-header.interceptor.ts` | **新增**：把命中状态写成 `X-Cache` / `X-Cache-Key` 响应头 |
| `src/common/common.module.ts` | 注册上述中间件（最先）+ 拦截器 |
| `src/app.module.ts` | import `CacheModule` |
| `src/config/{configuration,config.validation}.ts` | 新增 `REDIS_URL`（默认 localhost）+ `POST_CACHE_TTL`/`LIST_CACHE_TTL` |
| `.env.example` / `.env` | 补 Redis 连接串 + 两个 TTL |
| `solutions/blog/blog-db/docker-compose.yml` | 加 `redis` 服务（关持久化） |
| `test/cache.e2e.test.ts` | **新增**：命中 / 更新失效 / 删除失效 / 列表失效 / 负结果五组用例 |
| `test/api.e2e.test.ts` | **新增**：端到端「接口联调」，串起认证/CRUD/缓存/搜索/乐观锁/RBAC/Token 轮换/优雅降级（含停 Redis 仍 200 的降级用例） |
| `test/setup.cjs` | 测试用 access token 给长 TTL（1h），防慢机器上 token 中途过期 |

### 11. 一份诚实清单：今天做对了什么，还差什么

✅ **今天到位的：**
- Cache-Aside 完整读路径（查缓存 → miss 查库 → 回填）+ TTL 兜底
- 写后失效（单篇 `DEL` + 列表 `SCAN` 前缀清）
- **优雅降级**：Redis 挂了请求照常走 DB，进程不崩
- 单进程击穿守卫（`coalesce`）
- `X-Cache` 可观测头 + 完整 e2e（命中/失效/列表/负结果）

⚠️/❌ **还没做、明确知道的缺口：**
- **分布式击穿守卫**：`coalesce` 只在单进程内有效，多实例要换成 Redis 分布式锁（`SETNX`）
- **TTL 随机抖动**：现在全站统一 TTL，大量 key 同期过期有雪崩风险，生产该加 `ttl + random()`
- **缓存空值 / 布隆过滤器**：穿透靠「让 404 查库」扛，有明确攻击面时再补
- **缓存预热**：重启后缓存全空，第一波请求全 miss（冷启动）。高流量场景要预热热点 key
- **监控**：命中率（`HIT/(HIT+MISS)`）是缓存最重要的指标，现在只有 `X-Cache` 头，还没接指标系统来算命中率、告警
- **限流/分布式锁上 Redis**：Day 35 留的「全局限流」尾还没接——`@nestjs/throttler` 现在是进程内计数，多副本额度翻倍。这是 Redis 的下一个高频用武之地

把「还差什么」列出来比「做了什么」更重要——缓存是「永远在调优」的系统，知道边界才是用对它的前提。

---

## 💻 实践练习

1. **起 Redis 看缓存**：`cd solutions/blog/blog-db && docker compose up -d`，然后 `docker exec -it redis-blog redis-cli`。在另一个终端起 blog-api（`pnpm start:dev`），`curl` 两次同一个文章：
   ```bash
   curl -i http://localhost:3000/posts/<某篇id>   # 第一次：X-Cache: MISS
   curl -i http://localhost:3000/posts/<某篇id>   # 第二次：X-Cache: HIT
   ```
   回到 redis-cli 敲 `KEYS post:*`，亲眼看到那篇被缓存了；`TTL post:<id>` 看剩余秒数。
2. **验证失效**：`curl -X PATCH` 改一下标题，再 `curl` 那篇，`X-Cache` 应该变回 `MISS` 且标题是新的；redis-cli 里 `GET post:<id>` 应该已经不存在。
3. **验证优雅降级**：`docker compose stop redis` 把 Redis 停了，`curl` 接口——应该**照常 200 返回**，且 `X-Cache` 变成 `BYPASS`（service 检测到缓存层不通就绕过它直连库），日志里能看到降级提示。`docker compose start redis` 恢复，下一次读又会变回 `MISS` 并重新回填。
4. **跑测试**：`cd solutions/blog/blog-api && pnpm test`，看 `cache.e2e.test.ts` 的五组用例全绿（需要 PG + Redis 都起着）。
5. **思考题**：如果我们有 10 个 API 实例（10 个 Pod），现在的「击穿守卫」为什么就失效了？要把它升级成「分布式锁」，你会用 Redis 的哪条命令、怎么避免「拿到锁的实例崩了导致锁不释放」？（提示：`SET NX EX` + 锁的 TTL 兜底）

---

## ✅ 今日产出

- [ ] 完成核心知识点学习（Redis 定位 / 五结构 / 三策略 / 三大坑 / 优雅降级）
- [ ] 跑通 `cache.e2e.test.ts`，用 `curl -i` 看到 `X-Cache` 在 HIT/MISS 间切换
- [ ] 在笔记里写下「我的项目里哪些数据值得缓存、哪些不该」，并说清理由
- [ ] 提交代码到 GitHub

---

[⬅️ Day 35](../day-35/) | [➡️ Day 37](../day-37/)
