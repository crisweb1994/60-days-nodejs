# Day 27 — NestJS + Prisma 整合

## 📋 今日目标

- 搞懂 NestJS 的依赖注入（DI）和 Prisma 的连接池怎么对接——`PrismaService` 为什么要 `extends PrismaClient`
- 用 `OnModuleInit` / `OnModuleDestroy` 管好连接的生与死，理解为什么 Prisma 5 不再需要老教程那套 `beforeExit` 写法
- 把 `PrismaModule` 做成 `@Global` 单例，想清楚"为什么不能每个 module 各 `new` 一个 client"
- 把 Day 20 内存版 `blog-api` 接到真 PostgreSQL：**只改一行 `useClass`**，Service / Controller / DTO 一行不动
- 想清楚一个有争议的问题：**Prisma 之上还要不要再封一层 Repository**——给出判断标准，而不是教条
- 把 Prisma 的错误码（P2025 / P2002）映射成业务语义
- 分清两种测试：**单测 mock 仓储**（不连库）和**集成测起真 PG**，各测什么、各自的代价

> 本节配套代码：`solutions/blog/blog-api/`（Day 20 的项目，今天在它上面长出数据库）。

---

## 📖 核心知识点

### 1. "整合"到底要解决什么

把 Prisma 塞进 NestJS，表面看就是 `new PrismaClient()` 然后到处用。但有两个东西必须对接好，否则上生产就出事：

1. **生命周期**：`PrismaClient` 背后是一个**连接池**。它什么时候连上 PG、什么时候断开，要跟 NestJS 应用的启动 / 关闭对齐。连早了浪费、连晚了首个请求超时；关不掉就**泄漏连接**，PG 的 `max_connections` 很快被打满。
2. **单例**：整个应用**只能有一套连接池**。如果 A 模块 `new` 一个、B 模块又 `new` 一个，连接数翻倍，且互相看不到对方的事务。

NestJS 的 DI 容器天生擅长这两件事——它管理单例、有生命周期钩子。所以"整合"的本质是：**把 `PrismaClient` 包成一个受 Nest 容器托管的 provider**。这就是 `PrismaService`。

### 2. PrismaService：继承 PrismaClient + 生命周期钩子

```typescript
// src/prisma/prisma.service.ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ log: ['warn', 'error'] });
  }

  async onModuleInit() {
    await this.$connect();           // 应用启动时主动连一次
  }

  async onModuleDestroy() {
    await this.$disconnect();        // 应用关闭时把连接还给 PG
  }
}
```

**为什么 `extends` 而不是组合？**

```typescript
// 写法 A：继承（推荐）—— PrismaService 本身就是一个 PrismaClient
class PrismaService extends PrismaClient { ... }
this.prisma.post.findMany()          // 和裸 client 完全一样，无转发层

// 写法 B：组合 —— 把 client 塞进字段
class PrismaService {
  private client = new PrismaClient()
  get post() { return this.client.post }   // 每个 delegate 都要手动转发，烦
}
```

继承的好处是：调用方写 `this.prisma.post.xxx` 和直接用 `PrismaClient` 体验一致，没有一层"转发样板代码"。官方 recipe 就是这么写的。

**为什么实现 `OnModuleInit`？** 让 `$connect()` 在**启动第一秒**跑。连不上数据库这种事，应该在 `pnpm start` 时就崩，而不是等用户第一个请求进来才 500——这和 Day 20 用 zod 校验环境变量是**同一个哲学：fail fast**。

> 严格说，Prisma 是 lazy 的：不调 `$connect()`，它会在第一次查询时自动连。手动连的唯一价值就是**把"连不上"这个错误提前到启动期**。值不值？生产环境值——你绝不想在凌晨被"首个请求超时"叫醒，却发现是 DB 配置错了一晚上没人知道。

### 3. `$disconnect` 与 `enableShutdownHooks`：别再抄老教程的 `beforeExit`

很多 2022 年的教程会教你这样写：

```typescript
// ❌ 过时写法（Prisma 5 里 beforeExit 对 library engine 已移除）
async enableShutdownHooks(app: INestApplication) {
  this.$on('beforeExit', async () => {
    await app.close();
  });
}
```

**这套现在不要用了。** Prisma 5 的默认 query engine（library 模式）**移除了 `beforeExit` 事件**，这段代码根本不触发。

现代写法只要两步，本项目都已就位：

1. `PrismaService` 实现 `OnModuleDestroy`，里面 `await this.$disconnect()`
2. `main.ts` 里调 `app.enableShutdownHooks()`（Day 20 早就加了，当时是为优雅关闭 HTTP）

```typescript
// main.ts —— 这一行让 SIGTERM 能传到所有 OnModuleDestroy
app.enableShutdownHooks();
```

链路是：容器发 `SIGTERM` → `enableShutdownHooks` 捕获 → Nest 逐个调 provider 的 `onModuleDestroy` → `PrismaService.$disconnect()` 跑 → 连接池干净释放。

**为什么这事重要？** k8s 滚动更新、`docker stop` 都是发 `SIGTERM`。没有这套，每次重启都泄漏一批连接，几轮发布后 PG 报 `too many clients`。

### 4. PrismaModule：@Global 单例

```typescript
// src/prisma/prisma.module.ts
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

**为什么 `@Global`？** `PrismaService` 是全应用唯一的基础设施，几乎每个 feature module（posts、将来的 users、comments……）都要注入它。不标 `@Global` 的话，每个用它的模块都得 `imports: [PrismaModule]`，啰嗦。标了之后，根模块导入一次，全应用直接注入。

**`@Global` 不是要滥用的东西**——它让依赖关系变隐式，一般业务模块绝不该 `@Global`。但"全局唯一的基础设施"（DB client、缓存 client、配置）正是它的标准场景。

**DI 怎么保证单例？** NestJS 的 provider **默认就是单例**（`Scope.DEFAULT`）。容器里 `PrismaService` 只会被实例化一次，所有注入点拿到的是**同一个实例 = 同一套连接池**。这正好是我们要的。反过来——如果你手贱给它加 `Scope.REQUEST`，每个请求都会 new 一套连接池，直接灾难。

> 注意 `exports: [PrismaService]`：`@Global` 让模块全局可见，但**还得 `exports` 才能被注入**。两者缺一不可，少写 `exports` 会报 "Nest can't resolve dependencies"。

### 5. 把内存版换成 Prisma：只动一行的代价

Day 20 埋了个伏笔：Service 不直接依赖 `InMemoryPostsRepository`，而是依赖一个**接口** `PostsRepository`（通过 `POSTS_REPOSITORY` 这个 Symbol token 注入）：

```typescript
// posts.service.ts —— Service 眼里只有接口，没有 ORM
constructor(
  @Inject(POSTS_REPOSITORY) private readonly repo: PostsRepository,
) {}
```

而且接口的每个方法**都返回 `Promise`**（内存版也走 `async`，虽然没必要）。这就是为了今天：

```typescript
// posts.module.ts —— Day 27 的全部改动就是这一行 useClass
{ provide: POSTS_REPOSITORY, useClass: PrismaPostsRepository }
//                                      ^^^^^^^^^^^^^^^^^^^^^ 从 InMemoryPostsRepository 换过来
```

**Service / Controller / DTO / Filter / 验收场景，一行未改。** 这就是依赖倒置（依赖接口而非实现）+ DI 容器的回报。

**但"零成本"是幻觉**——切换本身零成本，可有一部分工作躲不掉：**领域实体和数据库行不是同一个东西，要做映射**。

| 领域实体 `Post`（业务语言） | DB 行 `PrismaPost`（存储语言） |
|---|---|
| `meta?: PostMeta`（具名对象，可选） | `meta Json?`（JSONB，读出来是 `JsonValue \| null`） |
| `status: 'draft' \| 'published' \| 'archived'`（联合类型） | `status String`（VARCHAR，宽类型） |
| `tags: string[]` | `tags String[]`（PG 原生 `text[]`） |

这层映射全收在 `PrismaPostsRepository` 一个文件里，它就是**防腐层（Anti-Corruption Layer）**——把 ORM 的形状挡在业务代码外面：

```typescript
// prisma-posts.repository.ts
private toDomain(row: PrismaPost): Post {
  return {
    ...row,
    status: row.status as PostStatus,             // 宽类型收窄回联合类型
    meta: (row.meta ?? undefined) as PostMeta | undefined,  // null → undefined
  };
}
```

> ⚠️ `row.meta` 的类型是 `Prisma.JsonValue`——它**不保证**真的长成 `PostMeta`。这里 demo 直接断言，**生产代码应该用 Zod 再校验一次**（呼应 Day 26 §JSON 不安全）。DB 里的 JSON 是你最容易自欺欺人的地方。

### 6. 要不要在 Prisma 之上再封一层 Repository？（有争议，看清楚再决定）

这是 NestJS + Prisma 项目里最常见的架构争论。先说结论：**90% 的项目不需要再为"换 ORM"而封一层，但本项目封了，有它的特殊理由。**

**反对再封一层的理由（很硬）：**

- Prisma 的 `PrismaClient` **本身就是 Repository**。`prisma.post.findMany()` 已经是仓储接口了，再包一层 `PostsRepository.findMany()` 转发给它，常常只是**搬运代码**。
- "为了将来换 ORM" 是**最被高估的理由**。绝大多数项目这辈子不会换 ORM；为一个永不发生的事件天天写转发样板，是负收益。
- 多一层就多一层要测、要维护、要让新人理解的东西。

**本项目仍然封了一层，理由是教学 + 真实收益的结合：**

1. **它让 Day 20 → Day 27 的切换真的零改动**。如果 Service 直接调 `prisma.post.xxx`，今天就得改 Service。Repository 接口把"换实现"的成本锁死在一个文件。
2. **领域实体 ≠ DB 行**（见上一节）。映射逻辑总得有地方放，Repository 是天然的家。
3. **测试**：Service 依赖接口，单测时塞个 mock 就行，不用起 Prisma（见 §8）。

**给你的判断标准：**

| 情况 | 建议 |
|---|---|
| 简单 CRUD，DB 行就是业务对象 | **别封**，Service 直接用 `PrismaService` |
| 领域模型和表结构差异大（多表拼一个聚合 / 大量映射） | **封**，Repository 放映射 |
| 业务规则复杂，想让 Service 可单测、不碰 DB | **封**，方便 mock |
| 团队里"将来要换 ORM"喊了三年没换过 | 这**不是**封的理由 |

**别走极端**：很多团队的最优解是**直接在 Service 注入 `PrismaService`，不要 Repository 接口**——代码量最少、最直白。本项目封了是因为它是教学项目、且要演示"Day 20 的抽象真的兑现了"。你自己的项目，按上表判断。

### 7. PrismaPostsRepository：把 DTO 翻译成 Prisma 查询

内存版那套 `Array.filter()` / `.sort()`，在 Prisma 版里变成**下推到 PG 的 where / orderBy**：

```typescript
async findMany(query: QueryPostDto) {
  const where: Prisma.PostWhereInput = {};

  // keyword 匹配 title 或 content，不区分大小写 → PG 的 ILIKE
  if (query.keyword) {
    where.OR = [
      { title:   { contains: query.keyword, mode: 'insensitive' } },
      { content: { contains: query.keyword, mode: 'insensitive' } },
    ];
  }
  if (query.status) where.status = query.status;
  // tags 是数组列：has 等价于 SQL 的 'tag' = ANY(tags)
  if (query.tag) where.tags = { has: query.tag };

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const sortBy = query.sortBy ?? 'createdAt';
  const order = query.order ?? 'desc';

  // ★ count 和 findMany 包进同一个 $transaction（Day 26 的数组事务）
  const [rows, total] = await this.prisma.$transaction([
    this.prisma.post.findMany({
      where,
      orderBy: { [sortBy]: order },        // sortBy 已在 DTO 白名单校验，动态拼 key 安全
      skip: (page - 1) * limit,
      take: limit,
    }),
    this.prisma.post.count({ where }),
  ]);

  return { items: rows.map(r => this.toDomain(r)), total };
}
```

**两个关键点：**

- **`orderBy: { [sortBy]: order }` 动态拼 key 为什么安全？** 因为 `QueryPostDto` 里 `sortBy` 用 `@IsIn(SORT_FIELDS)` 做了**白名单校验**，非法值在进 Service 前就被 400 挡掉。脱离白名单直接拼字符串到 ORDER BY，就是 SQL 注入入口——这条 Day 12 / Day 23 反复强调。
- **count 和 findMany 为什么包进 `$transaction`？** 否则两条查询之间如果有并发写入，你可能拿到"第 2 页数据"配"另一个时刻的总数"，前端分页器算出诡异的页数。数组事务让它俩在同一事务里执行。（注意：默认 RC 隔离级别下，PG 每条语句各取一次快照，要绝对一致需 `RepeatableRead`——见 Day 26 §3。列表接口通常不值得上 RR，知道这个权衡即可。）

### 8. 错误映射：Prisma 的 P 码 → 业务语义

Prisma 抛的是带错误码的 `PrismaClientKnownRequestError`。Repository 的职责之一是把它**翻译成接口约定的返回值**，别让 P 码泄漏到 Service：

```typescript
async remove(id: string): Promise<boolean> {
  try {
    await this.prisma.post.delete({ where: { id } });
    return true;
  } catch (e) {
    // P2025 = 要操作的记录不存在 → 返回 false（和内存版 Map.delete 语义对齐）
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      return false;
    }
    throw e;       // 其它错误照常往上抛，交给全局 Filter 脱敏成 500
  }
}
```

常用的几个码：

| 错误码 | 含义 | 怎么处理 |
|---|---|---|
| **P2025** | 要 update / delete 的记录不存在 | 接口返回 `null` / `false`，Service 决定抛不抛 404 |
| **P2002** | 唯一约束冲突（如 slug 撞名） | 本项目**两道防线**：Service 先 `findBySlug` 拦正常路径，仓储再捕 P2002 兜并发竞态——都转成 409 SLUG_TAKEN |
| **P2003** | 外键约束失败 | 引用了不存在的关联（本项目单表暂时遇不到，加 author 后会用上）|

> **slug 撞名为什么要两道防线**：Service 先 `findBySlug` 检查（可读性好、错误信息友好），挡掉正常路径。但"检查通过到写入之间"有个时间窗——并发下两个请求可能都通过预检（Day 26 §lost update 同款竞态）。所以 `PrismaPostsRepository` 的 `create` / `update` 再**捕 P2002 兜底**，把唯一约束冲突翻译成同样的 409 SLUG_TAKEN。预检负责友好，P2002 负责正确：纯靠预检会漏竞态，纯靠 P2002 则错误信息没那么友好——所以两个都要。

### 9. schema 的两种活法：migrate vs db pull

这是本项目两个 Prisma 目录最大的区别，初学者经常搞混：

| | `blog-prisma`（Day 25/26） | `blog-api`（Day 27，这里） |
|---|---|---|
| 谁是 schema 的真相 | **SQL 文件**（blog-db 的 migrations） | **`schema.prisma`** |
| 怎么同步 | `prisma db pull`（从 DB 反向生成 schema） | `prisma migrate dev`（从 schema 正向建表 + 生成迁移）|
| 跑不跑 migration | 不跑，Prisma 只当查询客户端 | 跑，Prisma 管建表改表 |
| 适用场景 | 接手已有 SQL-first 的库 / DBA 管 schema | 应用自己拥有数据模型（绿地项目主流）|

```bash
# blog-api 的标准流程
pnpm prisma:generate     # 从 schema.prisma 生成 TS 类型化的 Client
pnpm prisma:migrate      # = prisma migrate dev，建表 + 在 prisma/migrations/ 留迁移记录
```

**为什么 blog-api 用独立的 `schema=blog_api`？** 它和 blog-db 复用**同一个 PG 实例**（省得再起一个容器），但放在不同 schema 里，物理隔离——blog-db 的 `public` schema 那套 7 张表（带 author_id、触发器）和 blog-api 自己的单张 `posts` 表互不干扰。连接串里 `?schema=blog_api` 就是干这个的。

> `migrate dev` 需要一个**影子数据库（shadow DB）**来检测 drift，它会临时建一个库再删掉——所以连接用户要有 `CREATEDB` 权限。blog-db 的 `blog` 用户是 superuser（postgres 镜像里 `POSTGRES_USER` 默认建成超级用户），所以没问题。生产环境用受限用户时，要么配 `shadowDatabaseUrl`，要么用 `migrate deploy`（只应用已有迁移，不需要 shadow DB）。

### 10. 测试策略：单测 mock vs 集成测真 PG

接了数据库，测试就分两层，**各测各的，别混**：

**① 单元测试（`posts.service.unit.test.ts`）——mock 仓储，不连库**

测的是 **Service 的业务规则**：slug 撞名抛 409、归档文章拒绝改、找不到抛 404……这些和数据库无关，连 PG 是浪费。

```typescript
// 塞一个假仓储，Service 只依赖接口，根本不知道背后没有真 DB
const service = new PostsService(mockRepo({ findById: async () => null }));
await assert.rejects(() => service.findOne('x'), /* 期望 POST_NOT_FOUND */);
```

特点：**毫秒级、可重复、不依赖环境**。这正是 §6 "封一层 Repository 接口"换来的最大实际收益——Service 可以脱离 DB 单测。

**② 集成测试（`posts.e2e.test.ts`）——起完整 Nest 应用 + 真 PG**

测的是 **从 HTTP 到 DB 的整条链路真的串起来了**：Prisma 映射对不对、where 翻译对不对、过滤器 / 拦截器 / 校验管道有没有生效。这些 mock 测不出来，必须连真库。

```typescript
beforeEach(async () => {
  await prisma.post.deleteMany();   // 每个用例一张干净表（对应内存版的 repo.clear()）
});
```

| | 单元测试 | 集成测试 |
|---|---|---|
| 依赖 | 无（mock） | 真 PG |
| 速度 | 毫秒 | 几十~几百毫秒 |
| 测什么 | 业务分支、边界 | 真实数据流、SQL、组件协作 |
| 数量 | 多（金字塔底） | 少而精（金字塔尖）|

**坑点**：集成测 `beforeEach` 会 `deleteMany()` 清表，**务必让 `DATABASE_URL` 指向一次性的 schema/库**（如 `blog_api` 或专门的 `blog_api_test`），别手滑指向有数据的库——这是真实事故高发区。

> 这就是经典的"**测试金字塔**"：大量快单测托底，少量慢集成测把关键链路。别倒过来——全写集成测，几百个用例每个都连库清库，CI 跑十分钟，最后没人愿意跑。

### 11. 生产注意（呼应 Day 26）

接进 NestJS 不改变 Day 26 讲的那些底层规律，反而更要记住：

- **连接池大小**：`DATABASE_URL` 加 `?connection_limit=10`。NestJS 长跑进程，按 Day 26 §11 设到 PG `max_connections` 的 20~30%。serverless 另说（要 PgBouncer）。
- **N+1 还在**：把查询挪进 Service / Repository 不会消灭 N+1。列表接口里循环 `findUnique` 照样炸，修法仍是 `include` / `select`（Day 26 §5）。
- **事务边界**：跨多个 Repository 方法的写操作要原子，得把 `tx` 传下去或在 Service 层用 `$transaction(async tx => ...)`。这块 Day 29 专门讲。
- **别在事务里 await HTTP**：Day 26 §10 的铁律，接进 Service 后更容易犯——Service 方法里顺手 `await sendEmail()` 就把外部调用塞进事务了。

---

## 💻 实践练习

### 主练习：把 blog-api 接上 PostgreSQL

在 `solutions/blog/blog-api/` 上完成（参考实现已就位，建议先自己写一遍再对照）：

1. 写 `src/prisma/prisma.service.ts`：`extends PrismaClient`，实现 `onModuleInit` / `onModuleDestroy`
2. 写 `src/prisma/prisma.module.ts`：`@Global` + `exports: [PrismaService]`
3. 写 `prisma/schema.prisma`：单 `Post` 模型，字段对齐 `entities/post.entity.ts`
4. 写 `src/posts/repositories/prisma-posts.repository.ts implements PostsRepository`：实现 6 个方法 + `toDomain` 映射
5. 改 `posts.module.ts`：`useClass` 换成 `PrismaPostsRepository`（**只改这一行**）
6. `config.validation.ts` 加 `DATABASE_URL` 的 zod 校验

跑起来：

```bash
cd ../blog-db && docker compose up -d && cd -   # 先把 PG 起来
cp .env.example .env
pnpm install
pnpm prisma:generate                            # 生成 Client
pnpm prisma:migrate                             # 建 blog_api schema + posts 表

pnpm start:dev                                  # http://localhost:3000
pnpm test:unit                                  # 单测（不连库）
pnpm test:e2e                                   # 集成测（连库）
```

### 加分练习：自己想答案再看

1. **如果 Service 直接注入 `PrismaService`、不要 `PostsRepository` 接口，今天要改几个文件？** 切回内存版又要改几个？体会接口的价值——以及它的成本。
2. **`PrismaModule` 不写 `exports: [PrismaService]` 会怎样？** 加了 `@Global` 还需要 `exports` 吗？亲手删掉试试报什么错。
3. **把 slug 撞名从"先查后写"改成"直接 create 捕 P2002"**——写出 catch 分支。两种写法在高并发下行为差在哪？（提示：Day 26 §lost update）
4. **`onModuleInit` 里不调 `$connect()` 会怎样？** 应用还能跑吗？第一个请求会发生什么？什么时候这个差别会咬你？
5. **集成测试为什么用 `deleteMany()` 而不是 `migrate reset`？** 如果两个测试文件并行跑、连同一个库会怎样？怎么隔离？

### 验收清单

```bash
# 1. 类型与生成
pnpm prisma:generate && pnpm exec tsc --noEmit && echo "OK: 类型干净"

# 2. 单测全绿（不需要 DB）
pnpm test:unit
# 9 个用例覆盖 findOne/create/update/remove 的业务分支

# 3. 集成测全绿（需要 DB）
pnpm test:e2e
# 创建/校验/撞名/404/500脱敏/requestId/分页/tag过滤/更新/删除 全过

# 4. 数据真的落库了
pnpm prisma:studio        # 浏览器打开，能看到 e2e 跑出来的（或手动 POST 的）数据

# 5. 切换零成本验证
#    把 posts.module.ts 的 useClass 临时改回 InMemoryPostsRepository
#    pnpm test:unit 仍然全绿（业务逻辑没动）
```

---

## ⚠️ 常见误区

- **抄老教程的 `this.$on('beforeExit', ...)`**：Prisma 5 已移除该事件，根本不触发。用 `OnModuleDestroy` + `enableShutdownHooks`。
- **每个 module 各 `new PrismaClient()`**：连接池翻倍、事务互不可见。全应用一个 `@Global` 的 `PrismaService`。
- **`@Global` 了就不用 `exports`**：错。`@Global` 管可见性，`exports` 管能不能被注入，两者都要。
- **以为接了 Prisma 就该到处封 Repository**：`PrismaClient` 本身就是仓储。简单 CRUD 直接用，差异大 / 要单测才封。别为"将来换 ORM"封。
- **DB 行当成领域对象直接吐给前端**：`status` 是宽 `string`、`meta` 是没校验的 `JsonValue`。该收窄收窄，关键 JSON 该用 Zod 校验。
- **动态 `orderBy: { [sortBy]: order }` 不做白名单**：直接拼用户输入到排序字段 = 注入面。`sortBy` 必须 DTO `@IsIn` 白名单。
- **count 和 findMany 分开两次查**：并发写入下总数和当页对不上。包进 `$transaction` 数组。
- **集成测指向有数据的库**：`beforeEach` 的 `deleteMany()` 会清表。永远指一次性 schema/库。
- **全写集成测、不写单测**：CI 慢到没人跑。金字塔：多单测、少集成测。
- **给 `PrismaService` 加 `Scope.REQUEST`**：每个请求 new 一套连接池，灾难。保持默认单例。

---

## ✅ 今日产出

- [ ] 能讲清 `PrismaService` 为什么 `extends PrismaClient` 而不是组合
- [ ] 能用 `OnModuleInit` / `OnModuleDestroy` + `enableShutdownHooks` 管好连接生命周期，并知道为什么不用 `beforeExit`
- [ ] `PrismaModule` 用 `@Global` + `exports`，理解 DI 默认单例 = 单连接池
- [ ] 把 blog-api 的 `useClass` 从内存版换成 Prisma 版，Service / Controller / DTO 一行未改
- [ ] 实现 `PrismaPostsRepository`，包含领域实体 ↔ DB 行的映射（`toDomain`）
- [ ] 能说出"要不要再封 Repository"的判断标准，而不是教条
- [ ] 单测（mock）+ 集成测（真 PG）都跑通，理解两者各测什么
- [ ] 提交到 GitHub，commit message 写明 "day 27 nestjs + prisma integration"

---

## 📚 延伸阅读

- [NestJS — Prisma recipe](https://docs.nestjs.com/recipes/prisma)（官方整合指南，含 `PrismaService` 写法）
- [NestJS — Lifecycle Events](https://docs.nestjs.com/fundamentals/lifecycle-events)（`OnModuleInit` / `OnModuleDestroy` / shutdown hooks）
- [Prisma — Connection management](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/connection-management)（为什么单例、何时 `$connect`）
- [Prisma — Error reference](https://www.prisma.io/docs/orm/reference/error-reference)（P2025 / P2002 等错误码全表）
- [Prisma — `migrate dev` vs `db pull`](https://www.prisma.io/docs/orm/prisma-migrate/workflows)（两种 schema 工作流）
- [Martin Fowler — Anti-Corruption Layer / Repository](https://martinfowler.com/eaaCatalog/repository.html)（Repository 模式本源，判断要不要封的理论依据）
- [The Practical Test Pyramid — Martin Fowler](https://martinfowler.com/articles/practical-test-pyramid.html)（单测 / 集成测的比例哲学）

---

[⬅️ Day 26](../day-26/) | [➡️ Day 28](../day-28/)
