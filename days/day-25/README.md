# Day 25 — Prisma ORM 入门

## 📋 今日目标

- 想清楚"为什么要用 ORM"，以及 ORM 解决的真问题是什么、解决不了什么
- 读懂 Prisma Schema 语法（model / field / relation / attribute），能从 SQL DDL 推导出 schema.prisma
- 理解 `prisma migrate dev`、`prisma db push`、`prisma db pull` 三套工作流的差别和适用场景
- 用 Prisma Client 写出 CRUD 和关联查询，能区分 `include` / `select` 的语义
- 知道什么时候 Prisma 解决不了问题，要落回 `$queryRaw` 写原生 SQL
- 把 Day 24 留下的 7 张表用 Prisma Client 跑一遍，体会"对象图"和"SQL 行集"两种心智的差距

---

## 📖 核心知识点

### 1. ORM 到底解决什么问题

很多人对 ORM 的第一印象是"让我不用写 SQL"。这个理解只对了一半，而且是次要的那一半。

ORM 真正解决的是**两个世界的阻抗失配**：
- 数据库里数据是**行集**——平铺的 (rows, columns)
- 程序里数据是**对象图**——嵌套的、有方法、有类型

裸 SQL 写 `SELECT u.username, p.title FROM users u JOIN posts p ON ...`，拿回来是一个二维数组。你想用 `user.posts.map(p => p.title)` 这种代码访问？得自己把行集 reshape 成对象图。每次 JOIN 多了一张表，reshape 代码就翻倍——这就是 ORM 帮你做的脏活。

**ORM 不擅长的事情**：

- 复杂报表（多层 GROUP BY、窗口函数、CTE）—— 用 `$queryRaw`
- 批量数据迁移（百万行操作）—— 直接 PG 命令
- 跨库 JOIN、超大事务 —— ORM 抽象会漏

记住一个底层判断：**ORM 是"对象图 ↔ 行集"的翻译层**。翻译不了的就别强求，落回 SQL 比硬塞 ORM 干净得多。

### 2. 为什么是 Prisma

Node 生态的 ORM 选项：

| 工具 | 风格 | 用一句话定位 |
|------|------|------------|
| **Prisma** | Schema-first，自动生成类型化 Client | "把 SQL 隐藏在类型系统后面" |
| **TypeORM** | Decorator + Repository | 仿 Java Hibernate，陷阱多 |
| **Sequelize** | 老牌、命令式 | 类型支持差，新项目不推荐 |
| **Drizzle** | SQL-like DSL，零运行时开销 | 离 SQL 最近，但生态新 |
| **Knex** | Query Builder，不是 ORM | 只帮你拼 SQL，不做对象映射 |

**Prisma 的核心优势**：
- 类型完美——`prisma.user.findUnique({ where: { email } })` 返回的对象类型由 schema 决定，IDE 全程提示
- Migration 工作流成熟——`prisma migrate dev` 命令体验比 TypeORM 顺
- 关联查询 API 设计得很自然——`include: { posts: true }` 一目了然

**Prisma 的缺点**：
- 运行时引擎（早期是 Rust binary，2024 后逐步转纯 Node）会被一些 serverless 环境踩坑
- 复杂查询表达能力不如 Drizzle，逼你早早走 `$queryRaw`
- 历史上对 PG 高级特性（partial index、check constraints、views）支持滞后

**总体结论**：博客这种 CRUD-heavy 项目用 Prisma 是甜区。Drizzle 也行但生态稚嫩。

### 3. Prisma 的两个核心组件

Prisma 就两样东西，搞清楚关系胜过背 API：

```
┌─────────────────┐  prisma generate   ┌─────────────────┐
│ schema.prisma   │ ──────────────────▶│ @prisma/client  │
│  (你写的)        │                    │  (自动生成的)    │
└─────────────────┘                    └─────────────────┘
        │                                       │
        │ prisma migrate / db push              │ 你的应用代码 import
        ▼                                       ▼
┌─────────────────┐                    ┌─────────────────┐
│  PostgreSQL     │ ◀──── SQL ──────── │  你的应用       │
└─────────────────┘                    └─────────────────┘
```

- `schema.prisma`：你手写的声明文件，描述数据库 schema + Client 配置
- `@prisma/client`：根据 schema 自动生成的代码包，类型全部对上你的表

**关键事实**：`@prisma/client` 是**生成出来的**，每次改 `schema.prisma` 都要重新跑 `prisma generate`（`migrate dev` 会顺便跑）。CI/CD 里 `npm install` 之后必须有一步 `prisma generate`，不然类型对不上。

### 4. schema.prisma 语法骨架

最小可工作的 schema：

```prisma
// 1. 生成器配置：要生成什么 client，输出到哪
generator client {
  provider = "prisma-client-js"
}

// 2. 数据源配置：连哪个数据库
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// 3. 一个表 = 一个 model
model User {
  id        String   @id @default(uuid()) @db.Uuid
  email     String   @unique @db.VarChar(255)
  username  String   @unique @db.VarChar(50)
  role      String   @default("user") @db.VarChar(20)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz()

  posts     Post[]                                       // 反向关联

  @@map("users")                                         // 表名映射
}

model Post {
  id        String   @id @default(uuid()) @db.Uuid
  authorId  String   @map("author_id") @db.Uuid
  title     String   @db.VarChar(200)

  author    User     @relation(fields: [authorId], references: [id])

  @@map("posts")
}
```

几条规则要先记住：

- **`@` = 字段级 attribute，`@@` = 模型级 attribute**
- **`@map` / `@@map`**：字段 / 表的数据库实名。Prisma 默认 PascalCase / camelCase，数据库 snake_case，必须显式 map。
- **`@db.Xxx`**：精确的数据库类型。不写 Prisma 用默认（如 String → text）。生产严肃 schema 必须写 `@db.VarChar(255)` / `@db.Uuid` / `@db.Timestamptz()`。
- **关联两边都要声明**：`User.posts` 是反向（不真正存列），`Post.author` 是正向（存外键 `authorId`）。
- **`@relation(fields: [...], references: [...])`**：明确"哪个本表字段引用哪个外表字段"。

### 5. 关联类型在 Prisma 里的写法

| 关系 | SQL 端 | Prisma 端 |
|------|--------|----------|
| 1:1 | UNIQUE 外键 | 一方 `@relation` + 字段 UNIQUE，另一方 `?` 可空 |
| 1:N | 多端有外键 | 多端 `@relation`，一端 `Type[]` 反向 |
| N:M（自管中间表）| 显式中间表 | 中间表也是 model，两侧 `@relation` 各一对 |
| N:M（Prisma 隐式中间表）| Prisma 帮你建表 | 两侧 `Type[]` 互相指 + `@relation("name")` |
| 自引用 | 同表外键 | `@relation(name: "...", fields: [...], references: [...])` |

**重要决定**：**N:M 永远显式建中间表**。Prisma 的"隐式中间表"语法看起来省事，但：
- 表名是 Prisma 决定的，不可控
- 加不了额外字段（比如 `post_tags.created_at`）
- DB 端用裸 SQL 查时不直观

博客的 `post_tags` 已经显式存在，所以写法是：

```prisma
model PostTag {
  postId    String   @map("post_id") @db.Uuid
  tagId     String   @map("tag_id") @db.Uuid
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz()

  post Post @relation(fields: [postId], references: [id], onDelete: Cascade)
  tag  Tag  @relation(fields: [tagId], references: [id], onDelete: Cascade)

  @@id([postId, tagId])
  @@map("post_tags")
}
```

**`onDelete: Cascade` / `SetNull` / `Restrict`** 对应 SQL 的同名行为。Prisma 把这个声明在关联端，不是表定义里——和 SQL 写法刚好相反。

### 6. 三套工作流：migrate / push / pull 该用哪个

每次问"我现在该跑哪个命令"，对照这个决策树：

```
你打算改 schema 吗？
├── 不改，只是新拉项目
│   └── prisma generate   (从 schema.prisma 出 Client)
│
├── 改了 schema.prisma，想立即生效
│   ├── 在开发分支、能丢数据：  prisma db push   (跳过 migration，直接同步)
│   └── 在共享环境、保留历史：  prisma migrate dev   (生成 migration 文件)
│
├── 数据库已经存在（别人/旧系统建好的）
│   └── prisma db pull    (反向生成 schema.prisma)
│
└── 生产部署 migration
    └── prisma migrate deploy   (只应用，不生成、不交互)
```

具体差异：

- **`prisma migrate dev`**：标准开发循环。每次改 schema 自动建一个 `migrations/<timestamp>_<name>/migration.sql`，apply 到 dev DB，重生成 Client。共享代码的团队靠这个对齐。
- **`prisma db push`**：原型期用。直接同步 schema → DB，不留迁移历史。**适合一个人快速试错**，多人协作必崩。
- **`prisma db pull`**：introspect 既有数据库，从 schema 反推出 `schema.prisma`。**接手老项目神器**。注意它会覆盖你的 schema.prisma，所以接手时要做的事：跑一次 pull，然后开始用 migrate dev 接管。
- **`prisma migrate deploy`**：生产环境用，只读 migrations 文件夹按顺序 apply，不会交互式问"要不要重置 DB"。

博客这个项目特殊——`blog-db` 已经用裸 SQL migrations 管 schema 了。Day 25 选择 **`prisma db pull`** 让 Prisma 跟上现状，不动 SQL 管理权。如果是新项目就该 `migrate dev` 一路到底。

### 7. PG 类型 ↔ Prisma 类型映射

写 schema.prisma 时常用对照：

| PG | Prisma 字段类型 | `@db.X` 修饰 |
|----|----------------|-------------|
| `UUID` | `String` | `@db.Uuid` |
| `VARCHAR(n)` | `String` | `@db.VarChar(n)` |
| `TEXT` | `String` | `@db.Text` |
| `INTEGER` | `Int` | （默认）|
| `BIGINT` | `BigInt` | `@db.BigInt` |
| `BOOLEAN` | `Boolean` | （默认）|
| `TIMESTAMPTZ` | `DateTime` | `@db.Timestamptz()` |
| `TIMESTAMP` | `DateTime` | `@db.Timestamp()` |
| `JSONB` | `Json` | `@db.JsonB` |
| `JSON` | `Json` | `@db.Json` |
| `TEXT[]` | `String[]` | `@db.Text` |

**坑提醒**：
- `String` 不写 `@db.X` 默认是 `TEXT`，对应 SQL DDL 出来是 `TEXT NOT NULL`。和你想要的 `VARCHAR(255)` 不一样，会被 `prisma migrate diff` 检测出"漂移"。
- `DateTime` 不写 `@db.Timestamptz()` 默认是 `timestamp(3)`（不带时区），生产几乎一定出错。
- `Json` 字段在 Prisma Client 里类型是 `Prisma.JsonValue`，**没有结构化类型**。想要类型安全得用 Zod 或类似工具二次校验。

### 8. Prisma 不能映射的 PG 特性

`db pull` 会无视/破坏这些东西：

- **`CHECK` 约束**：完全忽略。你的 `view_count >= 0` 约束在 PG 里还在，但 Prisma schema 里看不到、TS 类型也不反映。
- **触发器和函数**：跳过。`updated_at` 自动维护、`like_count` 同步触发器在 Prisma 端是透明的——你 Prisma 写入照常，PG 触发器照常跑。
- **视图（VIEW）**：Prisma 5.0+ 才支持，且要在 schema 里加 `view` 关键字声明，introspect 不会自动识别。
- **部分索引（PARTIAL INDEX）**：Prisma 5.x 开始有 `@@index([col], where: ...)` 但仅 PG。pull 不一定能识别既有的。
- **PG 数组类型**：能映射，但操作 API 弱（不支持 `@>` 包含查询，要走 `$queryRaw`）。
- **JSONB 操作符**：`@>`、`?`、`->` 都要走原生 SQL。
- **复合 UNIQUE 约束**：能识别，映射为 `@@unique([a, b])`。

实战意义：**数据库的硬约束不能依赖 ORM 表达**。该写在 PG 里的约束就写在 PG，Prisma 只是个查询入口。

### 9. Prisma Client：CRUD 的标准姿势

```typescript
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

// CREATE
const post = await prisma.post.create({
  data: { authorId: '...', title: 'Hello', content: '...', slug: 'hello' }
})

// READ - 单条
const one = await prisma.post.findUnique({ where: { slug: 'hello' } })

// READ - 多条 + 过滤 + 排序 + 分页
const list = await prisma.post.findMany({
  where: { status: 'published', deletedAt: null },
  orderBy: { publishedAt: 'desc' },
  take: 10,
  skip: 0,
})

// UPDATE
await prisma.post.update({
  where: { id: post.id },
  data: { viewCount: { increment: 1 } },   // 原子增量
})

// DELETE
await prisma.post.delete({ where: { id: post.id } })

// UPSERT
await prisma.post.upsert({
  where: { slug: 'hello' },
  create: { ... },
  update: { ... },
})
```

**`findUnique` vs `findFirst`**：前者只接受 `@unique` 字段，能在 SQL 层走 unique 索引；后者接受任意 where，但有歧义。**有 unique 索引一律 `findUnique`**——Prisma 会优化、走索引、没结果返回 `null` 而不是抛错。

**`{ increment: 1 }` 等原子操作**：避免"读-改-写"竞态。Prisma 翻译成 `UPDATE ... SET view_count = view_count + 1`。同样还有 `decrement`、`multiply`、`set`、`push`（数组）。

### 10. include vs select：取关联的两种策略

```typescript
// include：返回原对象 + 关联（合集）
const post = await prisma.post.findUnique({
  where: { slug: 'hello' },
  include: { author: true, tags: { include: { tag: true } } }
})
// 返回所有 post 字段 + author 全字段 + tags(post_tags 行 + tag 全字段)

// select：明确指定要哪些字段
const post = await prisma.post.findUnique({
  where: { slug: 'hello' },
  select: {
    id: true, title: true,
    author: { select: { username: true } },
  }
})
// 返回只 (id, title, author.username)
```

**用法分工**：
- **生产代码用 `select`**——只取需要的列，减少 over-fetching；类型也精确
- **临时调试 / 内部工具用 `include`**——更简单

**性能**：两种最终都生成 `JOIN` 或多个 `SELECT`，Prisma 内部决策。**不是"include 会比 select 多扫一遍表"**——都是同一条 SQL（除非启用 `relationLoadStrategy: "query"` 强制改用多次查询）。

### 11. 关联的写入：connect / create / connectOrCreate

```typescript
// 创建 post 同时关联已有 tags
await prisma.post.create({
  data: {
    title: 'New', slug: 'new', content: '...', author: { connect: { id: userId } },
    tags: {
      create: [
        { tag: { connect: { slug: 'nodejs' } } },
        { tag: { connect: { slug: 'pg' } } },
      ]
    }
  }
})

// connectOrCreate：tag 不存在就建
{ tag: { connectOrCreate: { where: { slug: 'newtag' }, create: { name: 'NewTag', slug: 'newtag' } } } }
```

这套 API 一开始反直觉，但记住几条原则：
- `connect` = "用已有的"，传 unique 字段
- `create` = "新建一个并关联"
- `connectOrCreate` = "找不到就建"，幂等场景必备（写入标签、user-on-first-login）

**N:M 通过中间表的写法**：`post.tags.create({ tag: { connect: ... } })`——多嵌套一层是因为 PostTag 是显式中间表。如果用了 Prisma 隐式中间表语法，直接 `post.tags.connect({ id: tagId })`。这就是为什么显式中间表代码更啰嗦但更可控。

### 12. count / groupBy / 聚合

```typescript
// count
const total = await prisma.post.count({ where: { status: 'published' } })

// 关联 count（PG _count 投影）
const userWithPostCount = await prisma.user.findMany({
  include: { _count: { select: { posts: true } } }
})
// userWithPostCount[i]._count.posts === 该用户的文章数

// groupBy
const byStatus = await prisma.post.groupBy({
  by: ['status'],
  _count: { _all: true },
  _avg: { viewCount: true },
  having: { viewCount: { _avg: { gt: 100 } } },
})
```

**`_count.posts` 是 SQL 层的 LATERAL 子查询**——比客户端循环 count 快得多。**永远用这个 API 而不是 N+1 写法**。

### 13. raw SQL 逃生口

复杂查询、性能关键路径、ORM 表达不了的东西——走 `$queryRaw`：

```typescript
// 类型化（推荐）：通过 Prisma.sql 模板字符串避免注入
const result = await prisma.$queryRaw<Array<{ id: string; cnt: bigint }>>`
  SELECT id, count(*) AS cnt
  FROM posts
  WHERE status = ${status}
  GROUP BY id
`

// 命令式（INSERT/UPDATE/DELETE 用 $executeRaw）
await prisma.$executeRaw`UPDATE posts SET view_count = view_count + 1 WHERE id = ${id}::uuid`
```

**铁律**：
- **永远用模板字符串（`` $queryRaw`...` ``）**，让 Prisma 做参数化
- **永远不要用 `$queryRawUnsafe`**——除非你能 100% 保证 SQL 是写死的，否则注入风险
- **PG 类型转换要显式**：`${id}::uuid`，否则 Prisma 把 string 当 text 传，UUID 列不会自动 cast

什么时候必须走 raw：
- 递归 CTE
- 窗口函数（Prisma 5.x 部分支持）
- FULL JOIN
- GIN/GIST 索引上的 `@>`、`@@`
- `INSERT ... ON CONFLICT DO UPDATE` 的复杂分支

### 14. Prisma Client 的运行时

Prisma Client 内部分两层：

- **生成代码**（你 `import { PrismaClient }` 拿到的）：纯 TypeScript，定义所有 API 类型
- **查询引擎**：默认是一个 Rust 二进制（`@prisma/engines`），通过 stdin/stdout 跟 Node 通信

这个架构带来两个实际影响：

1. **冷启动**：第一次 `new PrismaClient()` 会启动子进程，~100ms 级延迟。serverless 环境（Lambda、Edge）会被这个咬，所以 Prisma 出了 Driver Adapters 把引擎换成纯 Node。
2. **连接池**：Prisma 自己管理一个连接池（默认 `num_physical_cpus * 2 + 1`）。生产环境通常需要在前面再放 PgBouncer。

`prisma generate` 做的事就是把你的 schema → 生成代码 + 把对应的引擎 binary 复制到 `node_modules/.prisma/client/`。**新克隆的项目跑 `npm install` 之后必须 `prisma generate`**，否则 import 进来全是 `undefined`。

### 15. 实战：用 Prisma 重写博客查询

把 Day 22~24 写过的几条经典查询，用 Prisma 重新表达一遍——感受心智的差距：

**Day 22 §16 "作者中心首屏"**

```typescript
const authors = await prisma.user.findMany({
  where: { role: { in: ['author', 'admin'] } },
  select: {
    id: true, username: true,
    _count: { select: { posts: { where: { status: 'published', deletedAt: null } } } },
    posts: {
      where: { status: 'published', deletedAt: null },
      orderBy: { publishedAt: 'desc' },
      take: 1,
      select: { title: true }
    }
  },
  orderBy: { /* 难直接按子查询聚合值排序，要 $queryRaw */ }
})
```

——立刻碰到 ORM 的边界：**"按子查询聚合值排序"Prisma 表达不出**。落 `$queryRaw`。

**Day 24 评论树**：递归 CTE 不可绕过，必须 `$queryRaw`。

**Day 24 点赞**：触发器在 PG 端，Prisma 调用 `create({ ... })` 后 `posts.like_count` 自动更新——前端代码不感知，正是反范式的优雅。

详细代码见 `solutions/blog/blog-prisma/src/05_real_queries.ts`。

### 16. 通往 Day 26 的桥

今天把 Prisma 的"读"和"基本写"打通了。Day 26 走深一层：

- **事务**：`$transaction([...])` 顺序事务 vs `$transaction(async tx => ...)` 交互式事务，什么时候用哪个
- **N+1 问题的真相**：什么时候 Prisma 会触发 N+1，怎么用 `include` / `_count` 消除
- **关联查询 vs 多次查询的内部决策**（PG 9.6+ `LATERAL` 子查询）
- **Soft delete 中间件**：用 Prisma extension 自动给所有查询加 `WHERE deleted_at IS NULL`

Day 27 才把这一切接入 NestJS。今天先在独立 playground 里把 Prisma 用顺，避免和框架的依赖注入混在一起增加难度。

---

## 💻 实践练习

### 主练习：在独立 playground 用 Prisma 跑通 7 张表

`solutions/blog/blog-prisma/` 是 Day 25 的 playground，结构：

```
blog-prisma/
├── package.json           # prisma + @prisma/client + tsx
├── tsconfig.json
├── .env.example           # 复用 blog-db 的 DATABASE_URL
├── prisma/
│   └── schema.prisma      # 7 张表的 Prisma 映射（手写，便于读注释）
└── src/
    ├── 01_basics.ts       # findUnique / findMany / create / update / delete
    ├── 02_relations.ts    # include / select / connect / connectOrCreate
    ├── 03_aggregates.ts   # count / _count / groupBy / having
    ├── 04_raw.ts          # $queryRaw / $executeRaw / 类型化
    └── 05_real_queries.ts # Day 22~24 经典查询的 Prisma 版（含落 raw 的判断）
```

启动顺序：

```bash
# 0. 确保 blog-db 已经 up + migrated + seeded
cd ../blog-db && ./scripts/migrate.sh && ./scripts/seed.sh

# 1. 装依赖、生成 Client
cd ../blog-prisma
cp .env.example .env
pnpm install
pnpm prisma generate

# 2. 跑每个 demo
pnpm tsx src/01_basics.ts
pnpm tsx src/02_relations.ts
pnpm tsx src/03_aggregates.ts
pnpm tsx src/04_raw.ts
pnpm tsx src/05_real_queries.ts
```

### 加分练习：自己想答案再看

1. **`prisma db pull` 之后，schema.prisma 里看不到 `posts_published_requires_timestamp` 这个 CHECK 约束**。如果你在应用层用 `prisma.post.create({ data: { status: 'published' } })` 而不传 `publishedAt`，会发生什么？
2. **Prisma Client 调用 `prisma.post.update({ where: { id }, data: { viewCount: { increment: 1 } } })` 生成的 SQL 是什么？** 跟 `data: { viewCount: post.viewCount + 1 }` 有什么本质区别？
3. **`include: { posts: true }` 和 `select: { posts: true }` 实际行为差什么？** 二者生成的 SQL 一样吗？类型呢？
4. **`prisma.$queryRaw\`SELECT count(*) FROM posts\`` 返回的类型是什么？** 为什么 count 返回的是 `bigint` 而 JS 的 `number` 装不下？
5. **如果 PG 端的触发器把 `posts.like_count` 加错了（漂移），Prisma 端怎么发现？** 怎么修？

每题答完再看 `src/05_real_queries.ts` 末尾的"加分题答案"注释。

### 验收清单

```bash
# 1. 客户端生成成功
pnpm prisma generate
ls node_modules/.prisma/client/        # 应有 index.js / index.d.ts

# 2. db pull 不报错（验证 schema.prisma 和 DB 对齐）
pnpm prisma db pull --print            # 打印 introspect 出的 schema，不写文件
# 应输出和 prisma/schema.prisma 几乎相同的内容

# 3. 五个 demo 全部 0 退出码
pnpm tsx src/01_basics.ts && echo OK
pnpm tsx src/02_relations.ts && echo OK
pnpm tsx src/03_aggregates.ts && echo OK
pnpm tsx src/04_raw.ts && echo OK
pnpm tsx src/05_real_queries.ts && echo OK

# 4. 触发器联动验证
pnpm tsx src/02_relations.ts | grep -i 'like_count'
# 应能观察到：通过 Prisma 创建 likes 后，posts.like_count 自动 +1（触发器仍然在 PG 端工作）
```

---

## ⚠️ 常见误区

- **以为 Prisma 能完全替代 SQL 知识**：复杂查询、性能调优、约束设计仍然需要 SQL 功底。Prisma 是工具不是知识替代品。
- **N:M 用 Prisma 隐式中间表**：表名不可控、加字段就崩。**永远显式中间表**。
- **`String` 不加 `@db.VarChar(n)`**：默认是 `TEXT`，migration diff 会一直报"schema drift"。
- **`DateTime` 不加 `@db.Timestamptz()`**：默认 `timestamp(3)` 不带时区，跨时区出错。
- **`prisma migrate dev` 在生产跑**：会试图重置 DB。生产**只用** `prisma migrate deploy`。
- **`$queryRawUnsafe` 拼字符串**：SQL 注入直接登门。永远用模板字符串版本。
- **触发器在 PG 端、应用代码不知情**：Prisma 调 update 之后立即读，可能拿不到触发器写入的最新值——**Prisma 没有 `RETURNING *` 含触发器后状态的概念**，要么显式再 select 一次，要么把触发器逻辑放应用层。
- **`findFirst` 当 `findUnique` 用**：失去 Prisma 对 unique 查询的优化，且找不到时行为不同（Unique 返回 null，First 也返回 null 但语义不一致）。
- **`include` 取出整棵树往前端塞**：over-fetching 经典案例。生产用 `select` 精确取字段。
- **没跑 `prisma generate` 就 import**：types 全 `any` / `undefined`。CI 必加这一步。

---

## ✅ 今日产出

- [ ] 能讲清"ORM 解决什么问题、不解决什么问题"
- [ ] 能从 SQL DDL 推导出 schema.prisma（含 `@db.X` 修饰、关联两端、`@@map`）
- [ ] 能在 `migrate dev` / `db push` / `db pull` / `migrate deploy` 之间正确选用
- [ ] 五个 demo 全部跑通；理解 `include` vs `select`、`connect` vs `create` 的区别
- [ ] 至少落一次 `$queryRaw`（PG 触发器/递归 CTE/窗口函数任选其一）
- [ ] 演示一次"PG 触发器自动维护 `like_count`，Prisma 写入后再 fetch 能看到"
- [ ] 提交到 GitHub，commit message 写明 "day 25 prisma orm intro"

---

## 📚 延伸阅读

- [Prisma 官方文档 — Getting Started](https://www.prisma.io/docs/getting-started)
- [Prisma Schema Reference](https://www.prisma.io/docs/orm/reference/prisma-schema-reference)（手册级文档，写 schema 时常翻）
- [Prisma Client API Reference](https://www.prisma.io/docs/orm/reference/prisma-client-reference)
- [Soft Delete with Prisma Extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions/middleware/soft-delete-middleware)
- [Prisma Caveats](https://www.prisma.io/docs/orm/reference/database-features)（哪些 PG 特性不支持，必读）
- [Drizzle vs Prisma](https://orm.drizzle.team/docs/overview)（对比阅读，理解 Prisma 的取舍）

---

[⬅️ Day 24](../day-24/) | [➡️ Day 26](../day-26/)
