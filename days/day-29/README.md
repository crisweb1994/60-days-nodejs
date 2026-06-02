# Day 29 — 数据库事务与并发控制

## 📋 今日目标

- 把 ACID 四个字母落到这个 app 上：哪些是事务 API 给的，哪些是约束 / WAL 给的
- 在 blog-api 里写一个**真实的多写事务**（改文章 + 写修订快照，要么都成要么都不成）
- 把"丢失更新（lost update）"这个最常踩的并发 bug 讲透，并掌握三种解法
- **乐观锁**（version 字段）——本项目并发控制的主力，会写、会判冲突、会区分 404 / 409
- **原子自增**（viewCount）——可交换的写为什么根本不需要锁
- **悲观锁**（SELECT FOR UPDATE）和 **Serializable + 重试**——什么时候才轮到它们
- 复习事务边界铁律（呼应 Day 26）：事务里只用 `tx.*`、别塞外部副作用、越短越好

> 配套代码：`solutions/blog/blog-api/`。Day 29 给 Post 加了 `version`（乐观锁）和 `viewCount`
> （原子计数），并新增 `post_revisions` 表 + `GET /posts/:id/revisions`、`POST /posts/:id/view`。
> 事务相关的纯演示在 Day 26 的 `blog-prisma` playground，今天是把它用进真实业务。

---

## 📖 核心知识点

### 1. ACID 落到这个 app

Day 26 讲过 ACID，这里只说它在 blog-api 里**具体由谁负责**：

| 字母 | 含义 | 这个 app 里谁来保证 |
|------|------|--------------------|
| **A** 原子性 | 一组写要么全成要么全不成 | `$transaction`——本项目 `update` 把"改 post + 写修订"包进一个事务 |
| **C** 一致性 | 数据始终满足约束 | DB 约束：`slug` 唯一、`@@unique([postId, version])`、外键、NOT NULL |
| **I** 隔离性 | 并发事务互不看见半成品 | PG 的隔离级别（默认 RC）+ 应用层乐观锁 |
| **D** 持久性 | 提交了就不丢 | PG 的 WAL，应用不用管 |

**记住分工**：A、I 是你用事务 API + 锁策略去争取的；C、D 是 PG 给的。今天的活全在 A 和 I。

### 2. 这个 app 里真正的事务在哪

Day 27/28 的写操作都是**单条语句**（create、update、delete 各一条 SQL），单条语句天然原子，不需要事务。直到 Day 29 引入**修订历史**才出现真正的多写：

> 每次成功 `update`，要同时做两件事：①把 post 改掉、版本号自增；②往 `post_revisions` 插一条快照。这两件事必须**一起成功或一起失败**——否则会出现"文章变了但没留下历史"或"留了历史但文章没变"的脏状态。

```typescript
// PrismaPostsRepository.update —— 交互式事务
return this.prisma.$transaction(async (tx) => {
  // ① 改 post（下面第 5 节讲乐观锁分支）
  await tx.post.update({ where: { id }, data });
  // ② 同一事务里快照修订
  const row = await tx.post.findUniqueOrThrow({ where: { id } });
  await tx.postRevision.create({
    data: { postId: row.id, version: row.version, title: row.title, content: row.content },
  });
  return this.toDomain(row);
});
```

**铁律（Day 26 §callback 事务，这里再强调）**：callback 里只用 `tx.*`，**绝不能**用外层的 `this.prisma.*`——后者不在这个事务里，行为像两个独立请求，原子性当场失效。

**回滚怎么发生**：callback 里任何 `throw` 都会让整个事务 rollback。下面乐观锁冲突时 `throw versionConflict()`，post 的改动和修订插入会**一起被回滚**——不会留下半条修订。

### 3. 丢失更新（lost update）：最常踩的并发 bug

脏读 / 不可重复读 / 幻读 Day 26 讲过；PG 默认 RC 下其实只剩一个最常见的坑——**丢失更新**：

```
T0  A 读到 post (viewCount=10)
T1  B 读到 post (viewCount=10)
T2  A 写 viewCount = 10 + 1 = 11
T3  B 写 viewCount = 10 + 1 = 11   ← B 用的是过期的 10，A 的 +1 被覆盖
结果 11，但其实有两次浏览，应该是 12。A 的更新"丢了"。
```

"读出来 → 在应用里改 → 写回去"这个**读-改-写**模式，只要两个请求交错，后写的就会覆盖先写的。三种解法，按场景选：

| 解法 | 适用 | 这个 app 的例子 |
|------|------|----------------|
| **原子操作** | 写是**可交换**的（+1、追加） | `viewCount`（§6）|
| **乐观锁** | 任意字段读-改-写，**冲突少** | 改 title/content（§5）|
| **悲观锁** | 必须串行、**冲突多** | 见 §7（本 app 用不到，讲清何时用）|

### 4. 乐观锁 vs 悲观锁：一句话的区别

- **乐观锁**：先假设"没人会跟我抢"，正常读、正常改，**写的时候才检查**有没有被人动过（version 对不上就拒绝）。不加任何数据库锁。适合**冲突很少**的场景（绝大多数 Web 写操作）。
- **悲观锁**：先假设"肯定有人抢"，**读的时候就把行锁住**（`SELECT ... FOR UPDATE`），别人只能等。适合**冲突频繁 / 必须严格串行**的场景（抢库存、扣余额）。

口诀：**冲突少用乐观（拦在写时），冲突多用悲观（锁在读时）**。Web 应用 90% 是乐观锁。

### 5. 乐观锁实战：version 字段

给 Post 加一个 `version Int @default(1)`。核心就三步：

```typescript
// 1) 读：客户端拿到 post，包括它的 version（比如 3）
// 2) 改：客户端把改动 + version=3 一起 PATCH 回来
// 3) 写：WHERE id = ? AND version = 3，命中就改、并把 version 自增到 4
const res = await tx.post.updateMany({
  where: { id, version: expectedVersion },   // ← 关键：带上版本条件
  data: { ...patch, version: { increment: 1 } },
});
if (res.count === 0) {
  // 命中 0 行 = 要么记录没了，要么版本已经被别人改过
  const exists = await tx.post.findUnique({ where: { id }, select: { id: true } });
  if (!exists) return null;          // 并发删除 → 交给 Service 当 404
  throw this.versionConflict();      // 版本不匹配 → 409 VERSION_CONFLICT
}
```

**几个关键点**：

- **为什么用 `updateMany` 不是 `update`**：`update({where:{id}})` 只认主键，没法带 `version` 条件；`updateMany` 能带任意 `where`，并返回**命中行数**——`count === 0` 就是冲突信号。
- **命中 0 行要区分两种情况**：记录被并发删了（→ 404）vs 版本被改了（→ 409）。再查一次 `findUnique` 区分。
- **version 必须自增**：`version: { increment: 1 }`，否则下次比较永远用旧值。
- **冲突返回 409，不是自动重试**：乐观锁的哲学是"把冲突暴露给上层"。改文章这种**有语义的写**，自动重试会用旧内容覆盖，应该让用户看到"内容已被他人修改，请刷新"再决定怎么合并。（对比 Serializable 的 40001，那种才适合自动重试，见 §8。）

**HTTP 语义**：这其实就是 `If-Match` / `ETag` 的乐观并发控制。version 相当于弱 ETag；带过期 version 的写，标准语义是返回 `409 Conflict`（或 `412 Precondition Failed`）。本项目用 409 + `VERSION_CONFLICT`。

**向后兼容**：本项目的 `version` 是**可选**的——不带就 last-write-wins（旧客户端不受影响），带了才做乐观检查。生产里对"重要写"应强制要求。

### 6. 原子自增：可交换的写不需要锁

`viewCount` 也是读-改-写，为什么它不用 version？因为**自增是可交换的**：A 加 1、B 加 1，谁先谁后都是 +2，没有"覆盖"问题——只要别在应用里 `read then write`，而是让 DB 一条语句原子地加：

```typescript
// ✅ 原子：UPDATE posts SET view_count = view_count + 1 WHERE id = ?
await this.prisma.post.update({ where: { id }, data: { viewCount: { increment: 1 } } });

// ❌ 读-改-写：会丢更新（§3 的经典场景）
const p = await prisma.post.findUnique({ where: { id } });
await prisma.post.update({ where: { id }, data: { viewCount: p.viewCount + 1 } });
```

**判断标准**：写能表达成"在现值基础上做可交换运算"（`increment` / `decrement` / 数组 `push`）→ 用原子操作，又快又无锁。写依赖"读到的具体值再决定"（改 title、状态机流转）→ 乐观锁或悲观锁。

所以本项目里：**浏览计数走原子自增**（不写修订、不动 version——它不是内容变更）；**改内容走乐观锁**。同一张表，两种策略，按操作性质分。

> **一个 Prisma 细节**：浏览自增本项目用**裸 SQL**（`$queryRaw ... UPDATE ... RETURNING`）而不是 `prisma.post.update`。因为 schema 里 `updatedAt @updatedAt` 会让 **任何** `update` / `updateMany` 都把 `updated_at` 改成 now()——但"被浏览"不该改"最后修改时间"，否则按 `updatedAt` 排序的游标分页会因为别人浏览而漂移（Day 28 §6 的漏行类问题）。要做一次"不碰 updatedAt 的写"，就得绕开 `@updatedAt`，落到裸 SQL。

### 7. 悲观锁（SELECT FOR UPDATE）：本 app 用不到，但要会判

当冲突**很频繁**、或业务**必须严格串行**（典型：扣库存、转账），乐观锁会频繁冲突重试，反而不如直接锁行：

```typescript
await prisma.$transaction(async (tx) => {
  // 读时就加行锁，别的事务想 UPDATE 这行只能等我提交
  const [row] = await tx.$queryRaw`SELECT * FROM posts WHERE id = ${id}::uuid FOR UPDATE`;
  // ... 基于 row 安全地读-改-写，期间没人能改它 ...
  await tx.post.update({ where: { id }, data: { /* ... */ } });
});
```

**乐观 vs 悲观怎么选**：
- 冲突率低（博客改文章、改资料）→ **乐观锁**：无锁开销，偶尔冲突让用户重试。
- 冲突率高 / 强一致（秒杀扣库存、扣余额）→ **悲观锁**：直接串行，不浪费在重试上。
- 悲观锁的代价：持锁期间别人阻塞，**锁要尽快释放**（事务尽量短），否则吞吐塌方、还可能死锁（Day 26 §死锁：PG 自动检测、杀一个、抛 `40P01`，应用重试几次）。

blog-api 改文章是典型低冲突场景，所以**选乐观锁**。这里讲悲观锁是为了让你知道"什么时候不该用乐观锁"。

### 8. 隔离级别 + Serializable + 重试：乐观锁也搞不定的情况

乐观锁守的是**单行**（这一行有没有被改过）。但有些不变量**跨多行**，单行版本号管不了。例子：

> "每个用户最多只能有 3 篇精选文章。"

两个请求并发各自 `count() = 2`，都认为"还能再加一篇"，于是都插入 → 变成 4 篇。每行都没冲突，但**跨行不变量被破坏**。这种要靠 **Serializable** 隔离级别：PG 会检测这种"写偏斜（write skew）"，让其中一个事务失败、抛错码 `40001`，应用**重试**。

```typescript
// Serializable + 自动重试（这种"系统冲突"才适合自动重试，区别于 §5 的业务冲突）
async function runSerializable<T>(fn: (tx) => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (e) {
      // 40001 = serialization_failure，可安全重试；重试上限内继续，超了就抛
      if (e?.code === 'P2034' || /40001/.test(String(e)) ) { if (i < retries) continue; }
      throw e;
    }
  }
}
```

> Prisma 把序列化失败包成 `P2034`（"Transaction failed due to a write conflict or a deadlock"）。

**blog-api 现在没有这种跨行不变量**，所以代码里没放这个 helper（不留没人用的死代码）。但你要知道：**乐观锁守单行，Serializable 守跨行**。两者解决的是不同层次的问题。

回顾隔离级别甜区（Day 26 §3）：**95% 的业务 = 默认 RC + 应用层乐观锁**；钱 / 库存 / 跨行不变量才上 Serializable，并准备好 retry。

### 9. 事务边界铁律（Day 26 复习，接进 app 后更易犯）

- **callback 里只用 `tx.*`**：用了外层 `this.prisma.*` 就脱离事务了。本项目 `update` 严格只用 `tx`。
- **别把外部副作用塞进事务**：`tx.post.update()` 后顺手 `await sendEmail()` / 调 HTTP / 发 MQ——事务会一直开着等这些慢操作，锁持有时间暴涨。副作用挪到事务**提交之后**。
- **事务越短越好**：Day 26 经验值——超过 100ms 就该警惕。本项目的事务只有两条语句，很短。
- **不要嵌套 `$transaction`**：callback 里再开事务行为未定义。
- **单条写不需要事务**：`incrementViewCount` 就是单条原子 UPDATE，没包事务——包了反而是噪音。

### 10. 抽象的漏点：内存版做不到真正的事务

又一个诚实的教学点（对照 Day 28 的全文搜索）：`InMemoryPostsRepository.update` 里"改 post + 记修订"是**两步普通赋值**，不是一个原子单元——中途没有回滚能力。它只是为了满足 `PostsRepository` 接口、让单测能跑，**语义和 Prisma 版的真事务并不等价**。

这再次说明：**有些能力是后端特有的**（真事务 = DB 给的，内存 Map 给不了）。仓储抽象能统一"接口形状"，但统一不了"语义保证"。设计时要清楚哪些保证是你真正依赖的。

---

## 💻 实践练习

### 主练习：给 blog-api 加并发控制

在 `solutions/blog/blog-api/` 上完成（参考实现已就位）：

1. schema 给 `Post` 加 `version Int @default(1)`、`viewCount Int @default(0)`，新增 `PostRevision` 表，跑 `prisma migrate dev`
2. `update` 改成交互式 `$transaction`：乐观锁更新（带 `expectedVersion`）+ 同事务写修订；version 每次自增
3. `incrementViewCount`：单条原子 `{ increment: 1 }`，不写修订、不动 version
4. `listRevisions`：按 version 倒序返回
5. `UpdatePostDto` 加可选 `version`；Service 把它从 patch 摘出来当 `expectedVersion`
6. Controller 加 `POST /posts/:id/view`、`GET /posts/:id/revisions`
7. 加 `VERSION_CONFLICT` 错误码（409）

跑起来：

```bash
cd ../blog-db && docker compose up -d && cd -
cp .env.example .env
pnpm install && pnpm prisma:generate && pnpm prisma:migrate

pnpm start:dev
pnpm test:unit       # 不连库
pnpm test:e2e        # 连库
```

手动验证乐观锁：

```bash
# 创建 → version=1
ID=$(curl -s -X POST localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"t","slug":"ol","content":"long enough content","status":"draft"}' | jq -r .data.id)

# 带 version=1 改 → 成功，version 变 2
curl -s -X PATCH localhost:3000/posts/$ID -H 'Content-Type: application/json' \
  -d '{"title":"v2","version":1}' | jq '.data.version'   # → 2

# 再带过期的 version=1 改 → 409 VERSION_CONFLICT
curl -s -X PATCH localhost:3000/posts/$ID -H 'Content-Type: application/json' \
  -d '{"title":"v3","version":1}' | jq '{code, category}'

# 修订历史
curl -s localhost:3000/posts/$ID/revisions | jq '.data | map(.version)'

# 浏览计数原子自增
curl -s -X POST localhost:3000/posts/$ID/view | jq '.data.viewCount'
```

### 加分练习：自己想答案再看

1. **丢失更新复现**：写个脚本并发对同一篇文章发 N 个"读-改-写"的 PATCH（不带 version），看最终 version / 内容；再都带上 version，看多少个拿到 409。
2. **为什么 viewCount 不用 version？** 如果硬给浏览计数也上乐观锁会怎样（高并发下大量 409 重试）？可交换性在这里起了什么作用？
3. **事务回滚验证**：在 `update` 的修订插入前手动 `throw`，确认 post 的改动也被回滚（version 没变）。
4. **乐观 vs 悲观选型**：把"秒杀扣库存"和"改用户昵称"分别归到乐观 / 悲观，并说明理由。
5. **Serializable 才能防的不变量**：设计一个 blog 里需要 Serializable（而乐观锁守不住）的规则，说明为什么单行 version 不够。

### 验收清单

```bash
pnpm prisma:generate && pnpm exec tsc --noEmit && echo "OK: 类型干净"

pnpm test:unit
# 20 个：CRUD 业务分支 + 游标编解码 + feed/search + 乐观锁/计数/修订 的 Service 映射

pnpm test:e2e
# 含：version 自增 + 修订快照 / 乐观锁正确版本成功 / 过期版本 409 / 浏览原子自增 / 浏览不产生修订
pnpm test:e2e 2>&1 | grep -iE 'version|乐观|浏览'
```

---

## ⚠️ 常见误区

- **以为默认隔离级别就防丢失更新**：不防。RC 下"读-改-写"照样互相覆盖。要原子操作 / 乐观锁 / 悲观锁。
- **可交换的计数也上乐观锁**：浪费。`viewCount` 用 `{ increment: 1 }` 原子自增即可，高并发下还省掉大量 409 重试。
- **乐观锁不自增 version**：版本永远停在旧值，检测形同虚设。`version: { increment: 1 }` 必须有。
- **乐观锁冲突自动重试改内容**：会用旧内容覆盖。业务写应把 409 暴露给用户去合并；自动重试只适合 Serializable 的系统级冲突（40001）。
- **`update` 带 version 条件用 `update()`**：`update` 只认主键。要带 `version` 条件用 `updateMany` 并看 `count`。
- **事务 callback 里用 `this.prisma.*`**：脱离事务，原子性失效。只用 `tx.*`。
- **事务里 await HTTP / 发邮件**：锁 / 连接被长期占用。副作用挪到事务提交后。
- **悲观锁当默认**：低冲突场景白白阻塞、降吞吐。先问"冲突频繁吗"，不频繁就乐观锁。
- **以为内存仓储也有事务**：没有。真事务是 PG 给的，内存 Map 的"多步赋值"不是原子单元。
- **Serializable 包治百病**：性能差、易冲突重试。只在跨行不变量、强一致写才上。

---

## ✅ 今日产出

- [ ] 能说清 ACID 在 app 里各由谁保证（A/I 靠事务+锁，C/D 靠 PG）
- [ ] 写出一个真实的多写 `$transaction`（改 post + 写修订），并理解 throw = 回滚
- [ ] 能描述丢失更新，并说出原子操作 / 乐观锁 / 悲观锁各自的适用场景
- [ ] 实现 version 乐观锁：`updateMany` + `count===0` 判冲突、区分 404 / 409、version 自增
- [ ] 用原子 `increment` 做浏览计数，并能解释它为什么不需要锁
- [ ] 能讲清乐观 vs 悲观的选型，以及 Serializable + 重试守的是"跨行不变量"
- [ ] 复述事务边界铁律（只用 tx、别塞副作用、越短越好）
- [ ] 单测（20）+ 集成测（乐观锁 / 计数 / 修订）全绿
- [ ] 提交到 GitHub，commit message 写明 "day 29 transactions & concurrency"

---

## 📚 延伸阅读

- [PostgreSQL — Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)（四个隔离级别，必读）
- [PostgreSQL — Explicit Locking（FOR UPDATE / FOR SHARE）](https://www.postgresql.org/docs/current/explicit-locking.html)
- [Prisma — Transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)（interactive / sequential / isolationLevel）
- [Prisma — Optimistic concurrency control](https://www.prisma.io/docs/orm/prisma-client/queries/transactions#optimistic-concurrency-control)
- [Martin Kleppmann — DDIA 第 7 章 Transactions](https://dataintensive.com/)（lost update / write skew / 可串行化，理论圣经）
- [2ndQuadrant — PostgreSQL anti-patterns: read-modify-write cycles](https://www.2ndquadrant.com/en/blog/postgresql-anti-patterns-read-modify-write-cycles/)
- [MDN — HTTP 条件请求（ETag / If-Match）](https://developer.mozilla.org/en-US/docs/Web/HTTP/Conditional_requests)（乐观并发的 HTTP 语义）

---

[⬅️ Day 28](../day-28/) | [➡️ Day 30](../day-30/)
