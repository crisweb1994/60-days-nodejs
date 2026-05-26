# Day 26 — Prisma ORM 进阶

## 📋 今日目标

- 把事务的本质（ACID 中的 A 和 I）和 Prisma 的两套事务 API 想清楚
- 分清 PG 四种隔离级别——RC / RR / Serializable 在 Prisma 里怎么显式指定
- 看穿 N+1 问题——它**不**是 ORM 的原罪，是 API 用错；知道怎么定位、怎么修
- 用 Prisma Client Extensions 实现"软删过滤"、"加自定义方法"、"统一日志"
- 把 `$transaction` 玩明白：什么时候用顺序数组、什么时候用 callback、什么时候根本不该用
- 了解 Prisma 的连接池配置和生产级性能注意事项

---

## 📖 核心知识点

### 1. 事务到底解决什么问题

事务（Transaction）的核心是 **ACID** 里的两个字母：
- **A** (Atomicity)：要么全成、要么全不成。中间崩了能 rollback
- **I** (Isolation)：多个事务并发跑，互相不窥探"半成品"

C（Consistency）由你的约束和触发器保证；D（Durability）由 WAL（write-ahead log）保证。这两个是 PG 给你的，跟事务 API 怎么用关系不大。

**最常见的现实场景**——博客的"点赞 + 创建通知"：

```typescript
// ❌ 没事务：两个写之间崩了 → 用户被加了赞但作者没收到通知（或反过来）
await prisma.like.create({ ... })
await prisma.notification.create({ ... })

// ✅ 事务：两个一起成功，或者一个都没发生
await prisma.$transaction([
  prisma.like.create({ ... }),
  prisma.notification.create({ ... }),
])
```

记住：**事务不是为了"加速"，而是为了"原子性"**。性能上事务**永远比无事务慢**（要拿锁、要写日志）。

### 2. Prisma 的两套事务 API

```typescript
// API A：顺序数组（sequential / batch）
await prisma.$transaction([
  prisma.like.create({ data: { ... } }),
  prisma.notification.create({ data: { ... } }),
])

// API B：交互式 callback（interactive）
await prisma.$transaction(async tx => {
  const post = await tx.post.findUnique({ where: { id } })
  if (post.likeCount > 1000) throw new Error('热度过高')
  await tx.like.create({ ... })
  await tx.notification.create({ ... })
})
```

**怎么选**：

| 场景 | 选谁 |
|------|------|
| 几条独立写，**无控制流** | 数组 |
| 中间要 `findXxx` 再决定写什么 | callback |
| 中间要 `throw` 触发 rollback | callback |
| 中间要 `$queryRaw` 自定义 SQL | callback |
| 写入要按某种顺序（如 A 完成才能 B）| 数组（数组保证顺序）|

**铁律**：
- callback 里**只用 `tx.xxx`，不要用外层的 `prisma.xxx`**——后者不在事务里，行为像两个独立请求
- callback 里不要 `Promise.all([tx.x, tx.y])` 并行发请求——同一事务底层是一根连接，PG 一次只能执行一条语句，Prisma 不保证并行行为，可能抛"Transaction already closed"。**永远串行 await**
- callback 内 `throw` 会自动 rollback；返回值会作为 `$transaction` 的结果

### 3. PG 四种隔离级别 + Prisma 的指定方式

SQL 标准定义四种隔离级别，但 PG 的实际行为比标准更强：

| 级别 | PG 实际行为 |
|------|------------|
| **Read Uncommitted (RU)** | PG 不实现真正的 RU，请求 RU 时被静默提升成 RC——所以 PG 里**永远读不到脏数据** |
| **Read Committed (RC)** ★默认 | 防脏读；同一事务里两次查同一行可能不一样（不可重复读）；两次范围查可能行数变（幻读）|
| **Repeatable Read (RR)** | 实现是 Snapshot Isolation，**脏读 / 不可重复读 / 幻读全防**——PG 这里比标准强 |
| **Serializable** | 在 RR 基础上加 SSI（Serializable Snapshot Isolation），保证可串行化；冲突时其中一方抛 `40001` 要 retry |

具体定义：

- **脏读**：读到了别人未提交的修改
- **不可重复读**：同一事务里两次读同一行，值不一样
- **幻读**：同一事务里两次范围查询，行数不一样

Prisma 里指定隔离级别：

```typescript
import { Prisma } from '@prisma/client'

await prisma.$transaction(async tx => {
  // ... 业务
}, {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,   // 等锁最多 5 秒
  timeout: 10_000,  // 事务总时长上限 10 秒
})
```

**实战经验**：
- 95% 的业务用默认的 **Read Committed** 就够，配合应用层乐观锁（version 字段）
- 钱、库存、积分这种**强一致敏感的写**用 `Serializable`，并准备好捕 retry 错误（PG 错误码 `40001`）
- **不要**为了"防一切"上来就 `Serializable`——性能差、容易死锁，反而拖垮

### 4. 行锁速览：FOR SHARE / FOR UPDATE

PG 主要靠 **MVCC + 行锁** 实现并发控制（MySQL/InnoDB 那种 gap lock 在 PG 里不存在；Serializable 隔离级别下 PG 用 predicate locks 实现可串行化检测）。手写锁日常就两个：

```typescript
// ROW SHARE：读时阻止别人 UPDATE，自己也只读不写
await tx.$queryRaw`SELECT * FROM posts WHERE id = ${id}::uuid FOR SHARE`

// ROW EXCLUSIVE：读时阻止别人读 + 写，常配合"先读后写"
await tx.$queryRaw`SELECT * FROM posts WHERE id = ${id}::uuid FOR UPDATE`
```

**最常见用法**：避免 "读-改-写" 竞态

```typescript
// ❌ 经典 lost update：两个事务同时 +1，结果只 +1
await prisma.$transaction(async tx => {
  const post = await tx.post.findUnique({ where: { id } })
  await tx.post.update({ where: { id }, data: { viewCount: post.viewCount + 1 } })
})

// ✅ 方案 1：原子操作（推荐）
await prisma.post.update({ where: { id }, data: { viewCount: { increment: 1 } } })

// ✅ 方案 2：行锁
await prisma.$transaction(async tx => {
  await tx.$queryRaw`SELECT id FROM posts WHERE id = ${id}::uuid FOR UPDATE`
  const post = await tx.post.findUnique({ where: { id } })
  await tx.post.update({ ... })
})
```

**死锁**：两个事务互相等对方持有的锁。PG 会**自动检测**死锁（默认 1 秒），杀掉其中一个、抛 `40P01`。应用层捕获错误后 **retry 几次**就行——不要试图"避免一切死锁"，那是不可能的。

### 5. N+1 问题的真相

教科书里的 N+1 描述：

```typescript
// ❌ 经典 N+1：1 次查所有 post，N 次查每个 author
const posts = await prisma.post.findMany()           // 1 次
for (const p of posts) {
  const author = await prisma.user.findUnique({ where: { id: p.authorId } })  // N 次
  console.log(p.title, author.username)
}
```

总共 1 + N 次查询。100 篇文章 = 101 次 round trip。

**Prisma 的修法**：

```typescript
// ✅ 改用 include 或 select 关联
const posts = await prisma.post.findMany({
  include: { author: { select: { username: true } } },
})
for (const p of posts) console.log(p.title, p.author.username)
// 一次 SQL（带 JOIN 或 LATERAL）
```

但 N+1 不止"循环 findUnique"这一种形态。**所有"先查列表再循环二次查询"的代码都是**：

```typescript
// ❌ 同样是 N+1：1 次查 post + N 次查 likes count
const posts = await prisma.post.findMany()
for (const p of posts) {
  const likes = await prisma.like.count({ where: { postId: p.id } })  // N 次
}

// ✅ 用 _count
const posts = await prisma.post.findMany({
  include: { _count: { select: { likes: true } } },
})
posts.forEach(p => console.log(p._count.likes))
```

**怎么发现**：
1. 开 `log: ['query']`——一个 HTTP 请求里看到 50 条 SQL 就是问题
2. 除了 `EXPLAIN ANALYZE` 看单条慢，还要看应用层接口耗时：列表接口 > 100ms 通常是 N+1 在咬
3. APM 工具（Datadog/NewRelic）能自动检测

**修法工具箱**：
- `include` / `select` 嵌套关联
- `_count` 投影替代循环 count
- `findMany` + `where: { id: { in: [...] } }` 批量预加载，然后内存里 join
- 实在不行落 `$queryRaw` 自己写 JOIN

### 6. Prisma 的 LATERAL JOIN 与查询策略

Prisma 5.7 把 `relationJoins` 引入为 preview（要在 schema 里 `previewFeatures = ["relationJoins"]` 才生效），5.20 在 PG / CockroachDB 上 GA 并作为**默认**。本项目用的 5.22 就是默认行为。它把嵌套查询从"多次查询 + 应用层 join"换成了**一条 LEFT JOIN LATERAL**：

```typescript
const users = await prisma.user.findMany({
  include: {
    posts: { take: 5, orderBy: { createdAt: 'desc' } }
  }
})
```

实际 SQL 是**一条** LEFT JOIN LATERAL，不是"先查 users 再为每个 user 查最近 5 篇"。**这对"每组取 N"性能极好**。

要强制旧行为：

```typescript
await prisma.user.findMany({
  include: { posts: true },
  relationLoadStrategy: 'query',  // 强制改回多次查询
})
```

**何时强制 `query`**：
- 关联表巨大且只取少量字段，LATERAL 反而扫多了
- 关联条件复杂导致 LATERAL 优化器选不到好计划

99% 场景用默认 `join` 就行，但**知道这个旋钮的存在**很重要，性能调优时能想起。

### 7. Prisma Client Extensions：扩展点全图

Extensions（Prisma 5.0+ GA）让你在不改 schema、不 fork 库的前提下扩展 Client。四类扩展：

```typescript
const ext = prisma.$extends({
  // 1. model：给某个 model 加自定义方法
  model: {
    post: {
      async findPublished(this: any) {
        return this.findMany({ where: { status: 'published', deletedAt: null } })
      },
    },
  },
  // 2. query：劫持每条查询，做前后处理
  query: {
    post: {
      async findMany({ args, query }) {
        args.where = { ...args.where, deletedAt: null }   // 软删自动过滤
        return query(args)
      },
    },
  },
  // 3. result：给查询结果加 computed 字段
  result: {
    post: {
      isPublic: {
        needs: { status: true, deletedAt: true },
        compute(post) {
          return post.status === 'published' && post.deletedAt === null
        },
      },
    },
  },
  // 4. client：给客户端本身加方法
  client: {
    async $health() {
      await this.$queryRaw`SELECT 1`
      return 'ok'
    },
  },
})

// 用法
await ext.post.findPublished()
await ext.$health()
const p = await ext.post.findUnique({ where: { id } })
p.isPublic  // 通过 result extension 自动算出来
```

**典型用例**：
- **soft delete**：用 `query` 扩展给所有 find* 加 `deletedAt: null`
- **审计日志**：`query` 扩展记录写入操作
- **多租户**：`query` 扩展自动加 `tenantId` 过滤
- **加 service 方法**：`model` 扩展把"published 文章列表"这类业务 query 沉淀

**重要警告**：
- Extension 返回的是**新 client**，不修改原 client。要么全代码用 ext，要么 ext 替换 prisma 单例
- `query` 扩展容易**漏一个 method 就出 bug**（比如忘记拦截 `findFirst`），写完要测全所有访问入口

### 8. 软删除实战：用 query extension 做对

业务需求：所有 find 自动加 `deletedAt: null`；delete 自动转 `update { deletedAt: now() }`。

```typescript
const prismaWithSoftDelete = prisma.$extends({
  query: {
    post: {
      async findMany({ args, query }) {
        args.where = { ...args.where, deletedAt: null }
        return query(args)
      },
      async findFirst({ args, query }) {
        args.where = { ...args.where, deletedAt: null }
        return query(args)
      },
      async findUnique({ args, query }) {
        // findUnique 只接 unique 字段，加 deletedAt 会破坏；用 findFirst 替代
        return (query as any)({ ...args, where: { ...args.where, deletedAt: null } })
      },
      async delete({ args, query }) {
        return prisma.post.update({
          where: args.where,
          data: { deletedAt: new Date() },
        }) as any
      },
      async deleteMany({ args, query }) {
        return prisma.post.updateMany({
          where: args.where,
          data: { deletedAt: new Date() },
        }) as any
      },
    },
  },
})
```

**坑点**：
- `findUnique` 严格只接受 unique 字段，硬塞 `deletedAt` 会让查询失效。要么转 `findFirst`，要么 fallback 应用层 if 检查
- 后台管理需要看已删数据，得提供一个"绕过 extension"的口子——通常用裸 `prisma` 单例做后台查询
- 关联查询里的 nested where（`include: { author: { ... } }`）不会自动加，每个 model 都要写 extension

**结论**：软删 extension 能做，但要小心。实战上很多团队选择**应用层显式过滤**——啰嗦但行为可预测。

### 9. 中间件（Middleware）：deprecated 但要知道

Prisma 5.0 之前推荐的扩展机制是 `$use`：

```typescript
prisma.$use(async (params, next) => {
  if (params.model === 'Post' && params.action === 'findMany') {
    params.args.where = { ...params.args.where, deletedAt: null }
  }
  return next(params)
})
```

**Prisma 5.0+ 标记为 deprecated**，5.x 里仍能用但官方推荐迁到 Extensions。差异：
- 中间件是**全局 hook**，所有 model / action 走同一条链路——容易乱
- Extensions 是**结构化的**——按 model / action 显式声明，IDE 提示更好

新代码用 Extensions。维护老项目的 `$use` 不用急着改，但有计划地迁。

### 10. `$transaction` 不是万能锤

新手最常见的滥用：

```typescript
// ❌ 没必要：单个写入不需要事务
await prisma.$transaction([
  prisma.post.update({ where: { id }, data: { viewCount: { increment: 1 } } }),
])

// ❌ 没必要：findMany 不改变状态，包事务没意义
await prisma.$transaction(async tx => {
  return tx.post.findMany()
})

// ❌ 弊大于利：把 HTTP 调用塞进 callback 事务
await prisma.$transaction(async tx => {
  const post = await tx.post.create({ ... })
  await sendEmail(post.id)        // ★ HTTP 请求在事务里，事务一直开着
  await tx.notification.create({ ... })
})
```

**判断标准**：
- 写操作 ≤ 1 个 → 不需要事务（单语句天然原子）
- 全是读 → 不需要事务（除非要可重复读级别快照）
- 中间有**外部副作用**（HTTP、消息队列、文件 IO）→ 把副作用挪到事务外
- 写操作 ≥ 2 个且**必须同步成败** → 用事务

事务时长越短越好。**生产经验：事务超过 100ms 就该警惕**——锁持有时间长，并发冲突激增。

### 11. 连接池：Prisma 的隐藏配置

Prisma 自己管一个连接池，默认大小 `num_physical_cpus * 2 + 1`。在容器里 cpus 探测经常错，建议**显式指定**：

```env
# .env
DATABASE_URL="postgresql://...?connection_limit=10&pool_timeout=20"
```

- `connection_limit`：池上限
- `pool_timeout`：拿不到连接等多久（秒），超时报错
- `connect_timeout`：第一次连 PG 等多久
- `socket_timeout`：单查询超时

**生产关键**：
- Lambda / Edge 等 serverless 环境每个实例都开池，几百实例 × 10 连接 = PG 直接打满。这种环境**必须**前面放 **PgBouncer**（transaction 模式），Prisma 端再设 `connection_limit=1`
- 长跑 Node 进程，`connection_limit` 设到 PG `max_connections` 的 20%~30% 比较合理
- 永远 `?pgbouncer=true` 跟 PgBouncer 配合，否则 prepared statement 缓存会出错

### 12. Prisma 的日志和性能可观测

调试时打开 query log：

```typescript
const prisma = new PrismaClient({
  log: [
    { level: 'query', emit: 'event' },
    { level: 'warn',  emit: 'stdout' },
    { level: 'error', emit: 'stdout' },
  ],
})

prisma.$on('query', e => {
  if (e.duration > 100) {
    console.warn(`SLOW QUERY (${e.duration}ms):`, e.query, e.params)
  }
})
```

生产监控除了应用层指标，还要拿 PG 端的 `pg_stat_statements`（Day 23 视角）。Prisma 翻译出来的 SQL 不一定漂亮，看到慢查询用 `EXPLAIN ANALYZE` 确认是 ORM 锅还是缺索引锅。

### 13. 批量插入 / 更新 / 删除的两套姿势

```typescript
// 方式 A：createMany（一条 INSERT 多行，最快）
await prisma.post.createMany({
  data: [
    { authorId, slug: 's1', title: 't1', content: 'c1' },
    { authorId, slug: 's2', title: 't2', content: 'c2' },
  ],
  skipDuplicates: true,   // ON CONFLICT DO NOTHING
})

// 方式 B：$transaction 数组（多条独立 INSERT）
await prisma.$transaction([
  prisma.post.create({ data: { ... } }),
  prisma.post.create({ data: { ... } }),
])
```

**两者差别**：
- `createMany`：**一条 SQL 多 VALUES**，最快；缺点：默认不返回创建的行；不能附带嵌套关联写入（`include`、`tags.create` 等）
- `$transaction` 数组：**多条 SQL，全部原子**；能附带关联写入；性能比 createMany 慢一个数量级

**要返回 id 的话用 `createManyAndReturn`**（Prisma 5.14+，仅 PG / CockroachDB 支持）：

```typescript
const created = await prisma.post.createManyAndReturn({
  data: [...],
  select: { id: true, slug: true },  // 可以挑字段，效果类似 RETURNING
})
```

批量插入巨量数据（百万级）：**走裸 SQL `COPY`，不是 Prisma**。`createMany` 也撑不住，PG 端会卡。

### 14. 实战陷阱清单

实际项目里 Prisma 经常踩的坑：

- **`$transaction` 嵌套**：不允许。callback 里再调 `prisma.$transaction()` 是新事务，行为未定义
- **callback 事务里调外层 `prisma`**：外层 client 不在事务里，行为像两个独立请求——靠 lint / code review 防范
- **`createMany` 不返回 id**：用 `createManyAndReturn`（Prisma 5.14+，PG/CockroachDB）；老版本只能逐条 `create` 或写完再 query
- **更新关联不能直接换 array**：`tags: [...]` 这种写法在 Prisma 里要拆成 `disconnect: ..., connect: ...`
- **`JsonValue` 类型不安全**：DB 里存的可能跟你以为的不一样，关键路径用 Zod 二次校验
- **`prisma.$transaction([])` 空数组无意义**：Prisma 不报错但什么也不做，容易误以为执行了
- **事务里 await 一个外部 Promise**：事务被挂起到 Promise resolve，期间锁一直持有。事务里**只 await `tx.xxx`**

### 15. 通往 Day 27 的桥

到这里 Prisma 单点用法基本闭环：schema、Client、关联、事务、N+1、扩展、性能。**Day 27 把 Prisma 接入 NestJS**：

- `PrismaModule` 的标准写法（DI、单例、生命周期）
- `PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy`
- Repository 模式在 Prisma 上还有没有意义（剧透：90% 项目不需要再封一层）
- 怎么把 Day 14~20 的内存版 blog-api 接入 PG（删 InMemoryRepo，换 Prisma）
- 测试策略：单测 mock vs 集成测起真 PG

Day 27 之后博客 API 就是真的生产级了——持久化、有事务、有索引、有约束。Day 28+ 进入鉴权、缓存、Job 系统等等业务横切关注点。

---

## 💻 实践练习

### 主练习：在 blog-prisma 上加 4 个 demo

继续用 Day 25 搭好的 `solutions/blog/blog-prisma/`，今天追加：

```
src/
├── 06_transactions.ts    # 数组 vs callback / 隔离级别 / 行锁 / 死锁演示
├── 07_n_plus_1.ts        # N+1 演示 + 三种修法 + EXPLAIN 对比
├── 08_extensions.ts      # model / query / result / client 四种扩展 + 软删扩展
└── 09_perf.ts            # createMany vs transaction 性能对比 + 连接池观察
```

跑法和 Day 25 一样：

```bash
cd solutions/blog/blog-prisma
pnpm demo:transactions
pnpm demo:n-plus-1
pnpm demo:extensions
pnpm demo:perf
```

### 加分练习：自己想答案再看

1. **callback 事务里抛错，外层会拿到什么？** 同一 await 链上的代码继续跑吗？rollback 在什么时机发生？
2. **`prisma.$transaction([...])` 里第 2 条失败，第 1 条会回滚吗？** 数组事务有没有"短路"？
3. **`isolationLevel: 'Serializable'` 下两个事务并发，PG 会怎么处理冲突？** Prisma 端会拿到什么错误？怎么 retry？
4. **写一个 Extension：给所有 `create` 操作自动塞 `updatedBy` 字段**——基于 request context（不写实现，列出思路就行）
5. **`include: { posts: true }` 触发 LATERAL JOIN，那 `include: { posts: { take: 100 } }` 还走 LATERAL 吗？** 100 篇文章 × 1000 个 author 内存压力多大？

### 验收清单

```bash
# 1. 四个新 demo 全 0 退出码
pnpm demo:transactions && echo OK
pnpm demo:n-plus-1     && echo OK
pnpm demo:extensions   && echo OK
pnpm demo:perf         && echo OK

# 2. 事务回滚效果验证
pnpm demo:transactions | grep -E '(rollback|回滚)'
# 应看到至少一次"事务回滚后数据未变"的验证输出

# 3. N+1 数量级差距
pnpm demo:n-plus-1 | grep -E 'SQL|ms'
# blog-db 小 seed（5 published）下：N+1 版 6 条 SQL ~180ms；修复版 1~2 条 SQL ~5ms
# 上 blog-db --large（10w 行）后差距会到几十倍——值得自己跑一次感受

# 4. 软删 extension 透明工作
pnpm demo:extensions | grep -i 'softDelete'
# 跑 update(deletedAt: now()) 之后，findMany 拿不到这条
```

---

## ⚠️ 常见误区

- **以为事务"更快"**：错。事务一定**比无事务慢**——拿锁、写日志、缩短并发窗口。
- **`$transaction(async tx => ...)` 里调外层 `prisma.xxx`**：脱事务，行为像两个请求。callback 里**只**用 `tx`。
- **事务里 await HTTP / 消息队列**：副作用挪到事务外。事务时长 ≤ 100ms 是好习惯。
- **N+1 等于"循环里查询"**：错。任何"先列表后单查"都是 N+1，包括 count、aggregate。
- **修 N+1 一律用 `include`**：未必。关联表巨大时 `findMany + where: { id: { in: [...] } }` 内存 join 更快。
- **隔离级别越高越好**：错。Serializable 性能差、易死锁。默认 RC + 应用层乐观锁是 95% 业务的甜区。
- **`$use` 中间件 + Extensions 混用**：deprecated 和新机制行为差异大。要么一律用 ext，要么暂时只用 `$use`。
- **Extension 改了 client 又用旧的 `prisma`**：拿不到扩展。要么替换单例，要么调用方一致用 ext 实例。
- **`createMany` 不返回 id 还期望拿到**：用 `createManyAndReturn`（Prisma 5.14+，仅 PG/CockroachDB），别再传说 `createMany` 没法拿 id 了。
- **Lambda 用默认 connection_limit**：实例数 × 池大小可把 PG 打满。必须配 PgBouncer。

---

## ✅ 今日产出

- [ ] 能讲清"事务在解决什么"以及为什么不能滥用
- [ ] 能区分 `$transaction([])` 和 `$transaction(async tx => ...)` 的适用场景
- [ ] 能写出指定隔离级别 + 配 `maxWait` / `timeout` 的事务
- [ ] 能演示一次 N+1 → 修复，看到 SQL 数量级变化
- [ ] 能用 query extension 实现"软删自动过滤"，且知道它的局限
- [ ] 4 个 demo 全部跑通，关键输出与文档一致
- [ ] 提交到 GitHub，commit message 写明 "day 26 prisma transactions/n+1/extensions"

---

## 📚 延伸阅读

- [Prisma — Transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)
- [Prisma — Client Extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions)
- [Prisma — Connection Pool](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-pool)
- [PostgreSQL — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)（必读，把四个隔离级别讲透）
- [Use The Index, Luke — Insert Performance](https://use-the-index-luke.com/sql/dml/insert)
- [Brandur Leach — PostgreSQL Serializable 实战](https://brandur.org/postgres-atomicity)（深入理解 Serializable 的实现）
- [Aiven — Connection Pooling with PgBouncer](https://aiven.io/blog/postgresql-connection-pooling-with-pgbouncer)

---

[⬅️ Day 25](../day-25/) | [➡️ Day 27](../day-27/)
