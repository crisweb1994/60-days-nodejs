# Day 28 — 分页、搜索与排序

## 📋 今日目标

- 把 Offset 分页和 Cursor（keyset）分页的**原理、SQL、优劣**讲透，知道什么场景用哪个
- 看懂游标的本质——它就是编码过的"排序值 + id"，以及为什么必须有 id 兜底
- 亲手把复合比较 `(sortKey, id) < (cursor)` 拆成 Prisma 能表达的 `OR`
- 踩一个真实的坑：**时间戳精度**会让游标漏行，知道为什么、怎么修
- 分清模糊搜索（ILIKE）和全文搜索（FTS）：各自怎么写、怎么建索引、什么时候不够用
- 用 PG 的 `to_tsvector` / `websearch_to_tsquery` / `ts_rank` 做带相关度排序的全文搜索
- 想清楚一个工程现实：**表达式索引 Prisma 的 schema 表达不了**，怎么和 `migrate` 共存
- 动态排序的安全底线：`sortBy` 白名单 + 稳定的次级排序键

> 配套代码：`solutions/blog/blog-api/`。Day 27 把它接上了 PG，今天给列表接口加分页、搜索、排序。
> 新增三条访问路径：`GET /posts`（offset，沿用）、`GET /posts/feed`（cursor）、`GET /posts/search`（FTS）。

---

## 📖 核心知识点

### 1. 为什么必须分页：不分页的列表就是 DoS 入口

Day 20 给 `limit` 加上限时就说过：`GET /posts` 不分页，等于把"一次拉全表"的能力开放给任何人。10 万行的表，一个 `SELECT *` 就能打爆内存、打满网络、拖垮序列化。

所以**列表接口必须分页**。问题只是：用哪种分页。两大流派——Offset 和 Cursor，不是谁取代谁，是各有适用场景。

### 2. Offset 分页：直观，但深翻会塌

```sql
SELECT * FROM posts ORDER BY created_at DESC LIMIT 20 OFFSET 40;  -- 第 3 页
```

Prisma 里就是 `skip` + `take`（本项目 `findMany`）：

```typescript
await prisma.post.findMany({
  where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  skip: (page - 1) * limit,
  take: limit,
})
```

**优点**：
- 能**跳任意页**（第 1 页直接跳第 99 页）
- 能配 `count(*)` 显示**总页数 / 总条数**——后台管理表格的刚需

**两个致命缺点**：

1. **深翻越来越慢**。`OFFSET 100000` 不是"直接定位到第 10 万行"——PG 得**先扫出前 100020 行、再丢弃前 100000 行**。OFFSET 越大，白扫越多。深分页的接口耗时随页码线性增长。

2. **并发写入导致漂移（drift）**。你看第 1 页（第 1~20 条）时，有人在最前面插了一条新文章。你翻到第 2 页 `OFFSET 20`——原来的第 20 条被挤到了第 21 位，于是它**在第 2 页又出现一次**（重复）。反过来删一条，会**漏掉**一条。

```
T0  列表: [A B C D E ...]   你看第 1 页 limit=2 → [A B]
T1  有人插入 Z 到最前
T2  你翻第 2 页 OFFSET=2 → 现在列表是 [Z A B C D...]，OFFSET 2 = [B C]
    → B 重复出现！
```

对"能跳页、要总数、数据不频繁变"的后台列表，offset 没问题。对"信息流、无限滚动、数据一直在变"的场景，漂移是硬伤。

### 3. Cursor（keyset）分页：稳，且深翻不掉速

核心思想：不要用"第几行"（位置）定位，要用"上一页最后一条的值"（内容）定位。

```sql
-- 上一页最后一条是 (created_at=X, id=Y)，按 created_at DESC 取下一页：
SELECT * FROM posts
WHERE (created_at, id) < (X, Y)         -- 关键：基于值，不基于偏移量
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

**为什么快**：`WHERE (created_at, id) < (X, Y)` 配合 `(created_at, id)` 上的索引，PG **直接定位到边界，往后扫 20 行就停**——不扫前面的任何一行。第 1 页和第 100 万页一样快。

**为什么稳**：边界是"内容"。前面插入 / 删除多少行都不影响"比 (X,Y) 小的下一批是谁"。**不重不漏**。

**代价（要认）**：
- 只能**顺序翻**（下一页 / 上一页），**不能跳到第 N 页**——因为你没有"第 N 页最后一条的值"
- 不好给**总页数**（要总数还得单独 `count`，但通常 cursor 场景也不显示总数）
- **排序键必须稳定、且最好有索引**；多列排序要把所有列 + id 都纳入游标

### 4. 游标的本质：不透明 token = 编码过的 (排序值, id)

客户端看到的 `nextCursor` 是一串乱码（base64url），它**不该解析**，只负责原样回传。但它内部就是：

```typescript
// solutions/blog/blog-api/src/posts/cursor.ts
export interface CursorPayload {
  v: string;   // 排序字段在那一行的值（日期 → ISO 字符串，title → 原文）
  id: string;  // 次级键，保证全序
}
encodeCursor({ v, id })  // → base64url(JSON)，给客户端
decodeCursor(token)      // → { v, id } 或 null（畸形输入）
```

**为什么要 id**：排序字段（如 `created_at`）可能重复。光靠它无法唯一定位"上一页最后一条到底是哪条"，会漏行 / 重复行。补一个唯一的 id 形成**全序**，游标才稳。所以排序和游标里**都**带 id。

**为什么不透明**：
1. **实现自由**：今天游标是 `(createdAt,id)`，明天改成 `(likeCount,id)`，客户端代码不用动——它从来没解析过。
2. **防滥用**：客户端构造不出 `cursor`，只能用你给的。避免它乱拼出奇怪的查询。

> 不透明 ≠ 加密。base64 谁都能解开。它只是"约定俗成的不透明"——别把敏感信息塞进游标。要防篡改就签名（HMAC），一般场景不必。

### 5. 把复合比较拆成 Prisma 能写的形式

`(created_at, id) < (X, Y)` 是 SQL 的"行值比较"，Prisma 的 `where` 没有这个算子。等价拆成两支 OR：

```
(created_at, id) < (X, Y)
  ⟺  created_at < X                       -- 严格更小
      OR (created_at = X AND id < Y)        -- 打平时看 id
```

本项目 `PrismaPostsRepository.findByCursor` 就是这么写的：

```typescript
const op = order === 'asc' ? 'gt' : 'lt';   // desc 要"更小"，asc 要"更大"
const v = sortBy === 'title' ? cursor.v : new Date(cursor.v);
const keyset = {
  OR: [
    { [sortBy]: { [op]: v } },                       // sortBy <op> v
    { [sortBy]: v, id: { [op]: cursor.id } },         // 打平 → 看 id
  ],
};
// 和 keyword 的 OR 共存：放进 AND，别让两个顶层 OR 互相覆盖
where.AND = [...(Array.isArray(where.AND) ? where.AND : []), keyset];
```

**两个易错点**：
- `orderBy` 的**次级键方向要和主键一致**（`{ [sortBy]: order }, { id: order }`），否则 keyset 比较和排序不自洽，翻页会乱。
- 如果 `where` 里已经有 `keyword` 产生的顶层 `OR`，keyset 的 `OR` 不能再放顶层（会互相覆盖），要包进 `AND`。

### 6. 真实的坑：时间戳精度会让游标漏行

这个坑很隐蔽，值得单独拎出来。

PG 的 `timestamptz` 默认是**微秒**精度（6 位小数）。JS 的 `Date` 只有**毫秒**精度（3 位）。Prisma 把 `timestamptz` 读成 JS `Date` 时，**微秒被截断成毫秒**。

于是：你从某行生成游标 `v = createdAt.toISOString()`（毫秒），再 `WHERE created_at < v`。但 PG 里那行的真实值是带微秒的。考虑降序、每页 2 条：

```
真实数据(降序): A(.200)  B(.123999)  C(.123456)  D(.100)
第 1 页 = [A, B]，游标取自 B → v = .123（B 的毫秒截断！）
第 2 页 WHERE created_at < .123 OR (created_at = .123 AND id < B.id)
  C(.123456): < .123000? 否。 = .123000? 否。  → C 被排除！
  D(.100):    < .123000? 是。                   → D 入选
第 2 页 = [D]   ❌ C 永远拿不到了
```

**C 被静默跳过**。数据量大、写入密集时，丢的就不是一条。

**怎么修**（任选）：
- **排序键用能精确往返的列**：字符串列（如 title，无精度问题）、或单调唯一键（UUIDv7 / bigserial）。
- **把时间列降到毫秒精度**：schema 里 `@db.Timestamptz(3)`，让 PG 存的、JS 拿的、游标编的三者**完全一致**。**本项目就采用了这个修法**——`posts.created_at / updated_at` 都定义成 `@db.Timestamptz(3)`，所以默认按 `createdAt` 的游标分页也不会漏行。
- 别试图把微秒塞进游标——JS Date 根本存不下。

记住这条：**游标的排序值必须能无损往返**（序列化再反序列化等于原值），否则 keyset 边界就是错的。

> 想亲手复现这个 bug：把 schema 改回 `@db.Timestamptz()`（微秒）、重新 migrate，再按默认 `createdAt` 翻页（见加分练习 2）。

### 7. 多取一条判断"还有没有下一页"

怎么知道 `hasMore`？最省事的办法：**多取一条**。

```typescript
const rows = await this.prisma.post.findMany({ where, orderBy, take: limit + 1 });
const hasMore = rows.length > limit;          // 取到第 limit+1 条 → 还有下一页
const page = hasMore ? rows.slice(0, limit) : rows;
const nextCursor = hasMore ? cursorOf(page[page.length - 1]) : null;
```

比"再发一条 `count` 查询"便宜（不用扫全表），也比"假设满页就有下一页"准确（恰好整除时不会多给一个空页）。

### 8. 决策表：offset 还是 cursor

| 你的场景 | 选 | 理由 |
|---|---|---|
| 后台管理表格，要跳页、要总条数 | **Offset** | 能跳任意页 + `count` 给总数 |
| 数据基本不变、量不大（几千行内） | **Offset** | 漂移和深翻都不构成问题，简单直接 |
| 信息流 / 评论 / 无限滚动 | **Cursor** | 数据一直在变，绝不能重复 / 漏 |
| 大表深分页（第几千页） | **Cursor** | offset 深翻线性变慢，cursor 恒定快 |
| 导出全量 / 后台批处理 | **Cursor** | 边导边写也不漏不重 |

本项目两个都给了：`GET /posts`（offset，后台 / 通用）和 `GET /posts/feed`（cursor，信息流）。**不是二选一，是按接口选**。

### 9. 模糊搜索：ILIKE，以及它为什么会慢

最朴素的搜索就是 `LIKE` / `ILIKE`（不区分大小写），本项目 `keyword` 走的就是它：

```typescript
where.OR = [
  { title:   { contains: kw, mode: 'insensitive' } },  // ILIKE '%kw%'
  { content: { contains: kw, mode: 'insensitive' } },
];
```

**它的问题在前导通配符 `%kw%`**：B-Tree 索引只能利用**左前缀**（`kw%` 能走索引，`%kw` 不能）。所以 `%kw%` 默认是**全表扫 + 逐行匹配**。几千行无所谓，上了量就慢。

**救场：pg_trgm 三元组索引**。它把字符串拆成 3 字符片段建 GIN 索引，让"包含匹配"也能走索引：

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX posts_title_trgm_idx ON posts USING gin (title gin_trgm_ops);
-- 现在 title ILIKE '%kw%' 能用上索引
```

**ILIKE 的本质局限**（trigram 也救不了）：
- **没有相关度排序**——匹配就是匹配，给不出"哪条更相关"
- **不分词、不懂词干**——搜 "running" 不会命中 "run"；搜 "the cat" 当成一个子串而不是两个词
- 只是"子串包含"，不是真正的"搜索"

要解决这些，得上全文搜索。

### 10. 全文搜索（FTS）：分词 + 排序 + 索引

PG 内置全文搜索。三个核心概念：

- **`tsvector`**：把文本**分词**后的"词素向量"。`to_tsvector('english', 'The cats are running')` → `'cat':2 'run':4`（去停用词 the/are、词干 cats→cat、running→run）
- **`tsquery`**：查询表达式。`to_tsquery('english', 'cat & run')`
- **`@@`**：匹配算子。`tsvector @@ tsquery`
- **`ts_rank`**：相关度打分，用来排序

```sql
SELECT *, ts_rank(to_tsvector('simple', title||' '||content), q) AS rank
FROM posts, websearch_to_tsquery('simple', '关键词') q
WHERE to_tsvector('simple', title||' '||content) @@ q
ORDER BY rank DESC;
```

**三种构造 tsquery 的函数，别用错**：

| 函数 | 输入 | 特点 |
|---|---|---|
| `to_tsquery` | `'cat & dog'` | 要你自己写 `&`/`|` 算子；用户裸输 `'cat dog'` 会**抛错** |
| `plainto_tsquery` | `'cat dog'` | 自动 AND，但不支持短语 / 排除 |
| **`websearch_to_tsquery`** | `'"cat dog" -bird'` | **像搜索引擎**：支持引号短语、`or`、`-` 排除，且对乱输入**容错不抛错** |

**面向用户输入永远用 `websearch_to_tsquery`**——它不会因为用户输了个孤立的 `&` 就 500。本项目就用它。

**'simple' vs 'english'**：
- `'simple'`：不做词干、不去停用词。结果**可预期**（搜什么词就匹配那个词素），适合做 demo / 测试 / 中英混排
- `'english'`：词干归并（run/running/ran 互相命中）、去停用词（the/is/at）。英文内容体验更好，但行为更"聪明"也更难预测

**FTS 的索引是表达式 GIN 索引**：

```sql
CREATE INDEX posts_fts_idx ON posts
  USING gin (to_tsvector('simple', title || ' ' || content));
```

⚠️ 索引里的表达式必须和查询里的**一模一样**（同 `'simple'`、同 `title||' '||content`），否则规划器认不出来、用不上。

### 11. FTS 在 Prisma 里怎么落地：直接上 $queryRaw

Prisma 对 PG 全文搜索有个 `fullTextSearch` preview feature（`where: { title: { search: 'cat & dog' } }`），但它有坑：用的是 `to_tsquery` 语法（要你处理 `&`）、拿不到 `ts_rank` 做排序、preview 状态不稳。

所以本项目 **`search` 直接用 `$queryRaw`**——把 FTS 这种 PG 专有能力交给 SQL，反而更清楚、更可控：

```typescript
const rows = await this.prisma.$queryRaw<Array<PrismaPost & { total: bigint }>>`
  SELECT id, title, slug, content, tags, status, meta,
         created_at AS "createdAt", updated_at AS "updatedAt",
         count(*) OVER() AS total                          -- 窗口函数：一查拿到总命中数（Day 23）
  FROM posts
  WHERE to_tsvector('simple', title || ' ' || content)
        @@ websearch_to_tsquery('simple', ${query.q})
        ${statusFilter}                                    -- Prisma.sql 条件片段，参数化安全
  ORDER BY ts_rank(to_tsvector('simple', title||' '||content),
                   websearch_to_tsquery('simple', ${query.q})) DESC,
           created_at DESC,
           id DESC                                       -- 唯一兜底键：rank + 时间都打平时仍稳定，offset 翻页不重不漏
  LIMIT ${limit} OFFSET ${offset}
`;
```

四个值得抄走的点：
- **列别名 `created_at AS "createdAt"`**：让 raw 行的形状对齐 Prisma 模型，复用同一个 `toDomain` 映射，不用为 raw 单写一套。
- **`count(*) OVER()`**：窗口函数在每行带上"总命中数"，一条查询拿到分页 + 总数，省一次 `count` 往返。
- **`${query.q}` 是参数**：Prisma 的 tagged template 自动参数化（`$1`），不是字符串拼接，**没有注入风险**。可选的 `status` 用 `Prisma.sql\`AND ...\`` / `Prisma.empty` 拼，同样安全。
- **稳定排序**：`ORDER BY rank, created_at, id`——`id` 兜底，保证相关度 + 时间打平时分页顺序仍确定（和列表 / 游标同一条原则）。

> **一个性能细节**：`to_tsvector(title||content)` 在 `WHERE` 和 `ORDER BY ts_rank` 里各算了一次。`WHERE` 那次能走表达式 GIN 索引（§12），但 `ts_rank` 那次是为每个命中行现算的——FTS 索引只加速"是否匹配（`@@`）"，不加速"打分排序"。命中行很多时这仍是 `O(命中数)` 的开销。生产里的彻底解法是**存一个 `tsvector` 生成列**（`GENERATED ALWAYS AS (...) STORED`）+ GIN 索引，分词只在写入时算一次；本项目为了不引入额外列、保持示例简单，没上生成列。

> `count(*) OVER()` 返回 `bigint`，记得 `Number()` 转一下，否则 JSON 序列化会报 "Do not know how to serialize a BigInt"（Day 26 同款）。

### 12. 工程现实：表达式索引和 `migrate` 打架，怎么办

第 10、11 节的索引（FTS 表达式 GIN、pg_trgm trigram）有个尴尬：**Prisma 的 schema 表达不了它们**（schema 只能声明列索引，不能声明 `to_tsvector(...)` 这种表达式索引）。

本项目的处理：**把这类索引当作"DB 运维层"，独立于 Prisma 迁移流程**，放在 `prisma/sql/001_search_indexes.sql` 手动应用。这条路的代价要说清楚：手动建在库里、不在迁移历史中的对象，会被 `prisma migrate dev` 视作 **drift**，它会提示你 `migrate reset`——而 reset 按迁移重建库，**会连带把这些手动索引 / 扩展一起删掉**，之后得重跑这个 SQL。所以开发期 `reset` 后记得重应用；生产 / CI 用 `prisma migrate deploy`（只应用迁移、不做 drift 重置）更稳。

手动用 psql 应用：

```bash
psql "postgresql://blog:blog_dev_pwd@localhost:5432/blog" \
  -c "SET search_path TO blog_api;" \
  -f prisma/sql/001_search_indexes.sql
```

这些索引是**可选优化**：不建，FTS / 模糊搜索照样能跑（走全表扫）。教学数据量小跑不跑都行；上了量，差距是数量级。

> 这是 ORM 的普遍边界：**ORM 管得了的 schema 是子集**。触发器、物化视图、表达式索引、分区表……这些都得"绕过 ORM"用 SQL 管。承认这一点，比硬把所有东西塞进 ORM 健康。

### 13. 动态排序的安全底线

`sortBy` 来自用户、最终拼进 `ORDER BY`——这是**注入面**（Day 12 / Day 23 反复强调）。底线两条：

1. **白名单**：`sortBy` 必须 `@IsIn(['createdAt','updatedAt','title'])`（见 `QueryPostDto`）。非法值在进 Service 前就被 400 挡掉。**绝不能**把任意字符串拼进 `ORDER BY`。
2. **稳定的次级键**：主排序字段可能有重复值，永远追加 `id` 做次级排序，保证结果**确定、可重现**（也是 cursor 分页的前提）。

有了白名单，`orderBy: { [sortBy]: order }` 这种动态拼 key 才是安全的——因为 `sortBy` 的取值已被收敛到几个常量。

---

## 💻 实践练习

### 主练习：给 blog-api 加分页 / 搜索 / 排序

在 `solutions/blog/blog-api/` 上完成（参考实现已就位，建议先自己写）：

1. `src/posts/cursor.ts`：`encodeCursor` / `decodeCursor`（base64url，畸形输入返回 null）
2. `PostsRepository` 接口加 `findByCursor` 和 `search`，两个实现（Prisma + InMemory）都补上
3. `PrismaPostsRepository.findByCursor`：keyset 分页，多取一条判断 `hasMore`
4. `PrismaPostsRepository.search`：`$queryRaw` + `websearch_to_tsquery` + `ts_rank` + `count(*) OVER()`
5. Service 加 `feed`（解码游标 → 查 → 回 nextCursor）和 `search`
6. Controller 加 `GET /posts/feed`、`GET /posts/search`（**放在 `:id` 前面**）

跑起来：

```bash
cd ../blog-db && docker compose up -d && cd -      # PG
cp .env.example .env
pnpm install && pnpm prisma:generate && pnpm prisma:migrate

# 可选：建搜索索引（数据量大才需要）
psql "postgresql://blog:blog_dev_pwd@localhost:5432/blog" \
  -c "SET search_path TO blog_api;" -f prisma/sql/001_search_indexes.sql

pnpm start:dev
pnpm test:unit      # 不连库
pnpm test:e2e       # 连库
```

手动验证：

```bash
# offset：能跳页、有总数
curl 'http://localhost:3000/posts?page=2&limit=10' | jq '.data.pagination'

# cursor：第一页 → 拿 nextCursor → 翻下一页
C=$(curl -s 'http://localhost:3000/posts/feed?limit=2&sortBy=title&order=asc' | jq -r '.data.pageInfo.nextCursor')
curl -s "http://localhost:3000/posts/feed?limit=2&sortBy=title&order=asc&cursor=$C" | jq '.data'

# 全文搜索：按相关度
curl 'http://localhost:3000/posts/search?q=postgres' | jq '.data.items[].title'
```

### 加分练习：自己想答案再看

1. **offset 漂移复现**：开两个终端，一个翻页一个狂插数据，看 offset 怎么重复 / 漏，cursor 为什么不会。
2. **时间戳精度坑复现**：本项目已用 `@db.Timestamptz(3)` 修掉了。把 schema 改回 `@db.Timestamptz()`（微秒）并重新 migrate，插两条 `created_at` 只差几微秒的数据（`$executeRaw` 手动设），按默认 `createdAt` 游标翻页，看 keyset 怎么漏行；再改回 `(3)` 验证修复。
3. **`websearch_to_tsquery` vs `to_tsquery`**：拿 `q='cat dog'`（中间空格、无算子）分别喂给两个函数，看哪个抛错。
4. **`'simple'` vs `'english'`**：搜 `'running'`，看哪个能命中正文里的 `'run'`。解释词干的作用。
5. **cursor 能不能跳到第 5 页？** 不能的话，产品要"跳页"怎么办？（提示：要么用 offset，要么做"页码→近似游标"的映射，要么干脆不提供跳页）

### 验收清单

```bash
pnpm prisma:generate && pnpm exec tsc --noEmit && echo "OK: 类型干净"

pnpm test:unit
# 15 个：CRUD 业务分支 + 游标编解码 + feed/search 的 Service 映射

pnpm test:e2e
# offset / cursor 翻页不重不漏 / 非法游标 400 / 全文搜索命中 / q 缺失 400 ……全过

# cursor 翻页不重不漏（脚本里断言三页 a/b → c/d → e）
pnpm test:e2e 2>&1 | grep -i feed
```

---

## ⚠️ 常见误区

- **以为 cursor 能取代 offset**：不能。要跳页 / 要总页数的后台表格，offset 才对。按场景选。
- **游标只编 sortBy 值、不带 id**：排序值重复时漏行 / 重复行。永远带 id 形成全序。
- **`orderBy` 次级键方向和主键不一致**：keyset 比较和排序不自洽，翻页错乱。`{sortBy: order}, {id: order}` 同方向。
- **游标排序值不能无损往返**（如毫秒截断的时间戳）：keyset 边界算错、漏行。用 `Timestamptz(3)` 或单调 id。
- **`OFFSET` 大了以为"直接定位"**：PG 要先扫再丢弃，深翻线性变慢。
- **面向用户输入用 `to_tsquery`**：用户裸输空格 / 符号会抛错 → 500。用 `websearch_to_tsquery`。
- **FTS 索引表达式和查询不一致**：用不上索引，照样全表扫。索引和查询里的 `to_tsvector(...)` 必须字字一样。
- **把表达式索引塞进 prisma migrations**：`migrate dev` 判 drift 要删它。表达式索引 / 扩展走 DB 运维层（`prisma/sql/`）。
- **`sortBy` 不做白名单直接拼 ORDER BY**：注入面。`@IsIn` 收敛取值后动态拼 key 才安全。
- **`count(*) OVER()` 的 bigint 直接序列化**：报 BigInt 序列化错误。`Number()` 转一下。
- **ILIKE `%kw%` 不建 trigram 索引还嫌慢**：前导通配符用不上 B-Tree，要 pg_trgm。

---

## ✅ 今日产出

- [ ] 能讲清 offset 的两个缺点（深翻慢、并发漂移）和 cursor 怎么解决
- [ ] 能把 `(sortKey, id) < cursor` 拆成 Prisma 的 `OR`，并正确和 keyword 的 OR 用 AND 合并
- [ ] 理解游标 = 编码的 (排序值, id)，且必须带 id、必须能无损往返
- [ ] 知道时间戳精度坑，能说出至少一种修法
- [ ] 能写 ILIKE 模糊搜索，并说出它的局限和 pg_trgm 索引
- [ ] 能用 `websearch_to_tsquery` + `ts_rank` 写带相关度的全文搜索，知道为什么不用 `to_tsquery`
- [ ] 理解表达式索引 Prisma 表达不了，会用独立 SQL 管理
- [ ] `sortBy` 白名单 + 次级排序键
- [ ] 单测（15）+ 集成测（含 cursor 翻页、FTS）全绿
- [ ] 提交到 GitHub，commit message 写明 "day 28 pagination / search / sorting"

---

## 📚 延伸阅读

- [Prisma — Pagination](https://www.prisma.io/docs/orm/prisma-client/queries/pagination)（offset vs cursor 官方对比）
- [Prisma — Filtering and Sorting](https://www.prisma.io/docs/orm/prisma-client/queries/filtering-and-sorting)
- [Prisma — Full-text search](https://www.prisma.io/docs/orm/prisma-client/queries/full-text-search)（preview feature 现状）
- [Use The Index, Luke — No Offset](https://use-the-index-luke.com/no-offset)（keyset 分页的经典论述，必读）
- [PostgreSQL — Full Text Search](https://www.postgresql.org/docs/current/textsearch.html)（tsvector / tsquery / 配置）
- [PostgreSQL — pg_trgm](https://www.postgresql.org/docs/current/pgtrgm.html)（三元组索引让 LIKE 走索引）
- [Slack Engineering — Evolving API Pagination at Slack](https://slack.engineering/evolving-api-pagination-at-slack/)（真实系统从 offset 迁到 cursor 的取舍）

---

[⬅️ Day 27](../day-27/) | [➡️ Day 29](../day-29/)
