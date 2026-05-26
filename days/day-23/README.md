# Day 23 — SQL 进阶：索引与性能

## 📋 今日目标

- 看懂 `EXPLAIN` 和 `EXPLAIN ANALYZE` 的输出，能从计划里读出"哪里慢"
- 把 B-tree 索引原理想清楚——为什么它能 O(log N)、为什么有些写法走不到
- 掌握联合索引最左匹配、覆盖索引、部分索引、表达式索引四种常见高级用法
- 分清 Nested Loop / Hash Join / Merge Join 三种 JOIN 算法的适用场景
- 入门窗口函数（`OVER` / `PARTITION BY` / `ROW_NUMBER` / `LAG`），用它替代一部分子查询
- 给 Day 22 写的那些查询补上合适的索引，用 EXPLAIN 验证从 Seq Scan 变 Index Scan

---

## 📖 核心知识点

### 1. 没索引的世界是什么样

先回到原始状态：一张没有任何索引的表，你查一行数据，数据库就得**把整张表从头读到尾**。这叫 Sequential Scan（Seq Scan），是一切性能问题的源头。

`posts` 表 10 行的时候，Seq Scan 跑 0.05ms，没人在乎。100 万行的时候同样的查询要 800ms，前端开始转圈。一亿行的时候用户已经走了。

数据库工程师 70% 的性能调优工作，本质都是一件事：**把 Seq Scan 干掉，换成 Index Scan**。今天就讲这件事。

但反过来，索引也不是越多越好。每个索引在每次 `INSERT/UPDATE/DELETE` 时都要同步维护，加错地方比不加还糟。要先理解原理再加，不然你只是把读慢换成写慢。

### 2. B-tree 是怎么实现 O(log N) 的

PG 默认的索引类型是 B-tree（确切说是 B+ 树，只在叶子节点存数据指针，内部节点只存路由 key）。一句话讲明白：**它把数据按顺序组织成一棵平衡多叉树，每次查找走 log N 层就能到目标**。

100 万行的 B-tree 大约 3~4 层。意思是查任意一行只需要 3~4 次磁盘读——而且这几页基本都在内存里。这就是为什么"有索引"和"没索引"的差距能从毫秒变小时。

B-tree 还有一个隐藏属性常被忽略：**叶子节点之间有双向指针串成一条链**。所以范围扫描（`BETWEEN`、`>`、`<`、`ORDER BY ... LIMIT`）也很快——找到起点，沿着叶子链表往下走就行。

这条性质决定了 B-tree 索引天然能加速的查询类型：

- 等值：`WHERE col = ?`
- 范围：`WHERE col BETWEEN ? AND ?`、`>`、`<`、`>=`、`<=`
- 前缀匹配：`WHERE col LIKE 'foo%'`（注意是**前缀**，不是后缀）
- 排序：`ORDER BY col [ASC|DESC]`
- 部分覆盖的 JOIN：等值连接基本都靠这个

反过来，B-tree 加速不了的：

- **函数包列**：`WHERE lower(email) = 'a@b.com'` 走不到 `email` 上的索引——索引存的是原值，不是 `lower()` 之后的值。解法：建表达式索引 `CREATE INDEX ... ON users (lower(email))`。
- **隐式类型转换**：`WHERE id = '123'`（id 是 int），PG 会在列上加 cast，等于函数包列，走不到。解法：传对类型。
- **后缀/中缀 LIKE**：`WHERE title LIKE '%foo%'` 没法走 B-tree。解法：`pg_trgm` + GIN 索引。
- **`OR` 跨多个无索引列**：`WHERE a = 1 OR b = 2`，如果两列没有合适索引会退化成 Seq Scan。

### 3. EXPLAIN 怎么读

`EXPLAIN` 不执行查询，只输出 **计划器估算出来的执行计划**。`EXPLAIN ANALYZE` 真的执行一遍，同时打印估算 vs 实际。生产数据库上跑 `ANALYZE` 要小心——它会真跑，包括 `INSERT/UPDATE/DELETE`。

最小可读单位：

```
EXPLAIN ANALYZE SELECT id, title FROM posts WHERE status = 'published';

Seq Scan on posts  (cost=0.00..1.12 rows=5 width=48) (actual time=0.012..0.018 rows=5 loops=1)
  Filter: ((status)::text = 'published'::text)
  Rows Removed by Filter: 5
Planning Time: 0.123 ms
Execution Time: 0.045 ms
```

字段含义按出现顺序：

- `Seq Scan on posts`：扫描方式（Seq Scan / Index Scan / Index Only Scan / Bitmap Heap Scan...）
- `cost=0.00..1.12`：**估算成本**，前者是返回第一行的成本，后者是返回最后一行的成本。单位是"页 I/O"的抽象单位，绝对值没意义，**只用来对比**。
- `rows=5`：估算返回行数
- `width=48`：估算每行字节数
- `actual time=0.012..0.018`：实际耗时（毫秒），单次执行
- `rows=5 loops=1`：实际返回行数 × 循环次数（Nested Loop 内层会 loops>1）
- `Rows Removed by Filter`：被 Filter 干掉的行数。**这个值大说明索引选择性差或没用上**。

读计划的三个核心问题，按优先级排：

1. **估算 rows 和实际 rows 差多少？** 差一个数量级以上就是统计信息过期，跑 `ANALYZE 表名` 更新。
2. **最大开销的节点是什么？** 通常是树底的某个 Scan 或最外层的某个 Join。
3. **有没有意外的 Seq Scan？** 大表上的 Seq Scan 几乎一定是问题。

### 4. EXPLAIN (ANALYZE, BUFFERS)：看清楚谁在打硬盘

加 `BUFFERS` 选项能看缓存命中情况：

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title FROM posts WHERE slug = 'hello-postgres';

Index Scan using posts_slug_key on posts ... 
  Buffers: shared hit=3
```

- `shared hit`：从 PG 的 shared_buffers 里命中，最快
- `shared read`：从操作系统 page cache 或磁盘读，慢一个量级
- `shared dirtied`：本次执行让多少页变脏（写）

调优时永远开 `BUFFERS`。同一条 SQL 跑两次，第二次的 `read` 应该归零、变成 `hit`——如果没变，说明你的 `shared_buffers` 配置太小或工作集太大。

另一个有用选项：`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT TEXT)`。`SETTINGS` 会把当前影响计划的非默认 GUC 全列出来，定位"为什么这台机器计划不一样"特别管用。

### 5. 给单列加索引：从 Seq Scan 到 Index Scan

最朴素的索引：

```sql
CREATE INDEX idx_posts_status ON posts(status);
```

加完之后，`WHERE status = 'published'` 在小表上 PG 可能**仍然选 Seq Scan**——因为表只有 10 行，扫一遍比走索引（多一次 I/O 跳到 heap）还快。这不是索引坏了，是优化器正确判断。

要看出索引效果，把表灌到至少几万行（本目录 `seed.sh --large` 会灌 10w 行，专门为此准备）。然后对比：

```sql
-- 无索引
EXPLAIN ANALYZE SELECT count(*) FROM posts WHERE status = 'published';
-- Seq Scan，大概 30~80ms

CREATE INDEX idx_posts_status ON posts(status);

-- 有索引（但选择性差，状态只有 3 种，索引收益有限）
EXPLAIN ANALYZE SELECT count(*) FROM posts WHERE status = 'published';
-- 可能走 Bitmap Index Scan + Bitmap Heap Scan，也可能仍是 Seq Scan
```

注意一个常见误解：**索引不是"加上就一定走"**。优化器会算成本，如果走索引比 Seq Scan 还贵（高选择性、低基数列、统计估算偏差），它会拒绝。这通常是对的。

### 6. 联合索引与最左匹配

最让人摔跤的是联合索引（Composite Index）：

```sql
CREATE INDEX idx_posts_author_status ON posts(author_id, status);
```

这个索引等价于按 `(author_id, status)` **字典序**排序的一棵 B-tree。能走索引的查询：

| 查询条件 | 能否走 idx | 解释 |
|---------|-----------|------|
| `WHERE author_id = ?` | ✅ | 最左前缀 |
| `WHERE author_id = ? AND status = ?` | ✅ | 完整前缀 |
| `WHERE author_id = ? AND status = ? AND view_count > 100` | ✅（前两列走索引，view_count 走 Filter） | |
| `WHERE author_id = ? ORDER BY status` | ✅ | 有序遍历 |
| `WHERE status = ?` | ❌ | 跳过了 author_id |
| `WHERE author_id > ? AND status = ?` | ⚠️ | author_id 走索引范围，status 走 Filter（不是索引） |

第 6 行特别坑：**范围之后的列就不走索引了**。原因是 B-tree 一旦在第一列做了范围扫，第二列在结果集里并不是有序的——索引帮不了忙。

实战经验：建联合索引时，**等值过滤的列放前面，范围过滤的列放最后**，按选择性从高到低排（基数大的在前）。

### 7. 覆盖索引：Index Only Scan

如果查询只需要的列**全在索引里**，PG 可以完全不读 heap，叫 Index Only Scan：

```sql
CREATE INDEX idx_posts_cover ON posts(status, published_at) INCLUDE (title);

EXPLAIN ANALYZE
SELECT title FROM posts WHERE status = 'published' ORDER BY published_at DESC LIMIT 10;
-- Index Only Scan using idx_posts_cover on posts ...
```

`INCLUDE (...)` 是 PG 11+ 的语法，把列只放到索引的叶子节点，不参与 B-tree 排序、不影响最左匹配，但能避免回表。比把列加进 key 列更省空间。

要走 Index Only Scan 还有一个**前提**：表的 Visibility Map 是新鲜的。`VACUUM` 之后才会更新，所以"刚批量写完"的表有时候走不了 Index Only。`EXPLAIN ANALYZE` 看 `Heap Fetches:` 那行，0 就是真的没回表。

### 8. 部分索引：只给"热数据"建索引

博客场景：99% 的查询都加 `WHERE deleted_at IS NULL`。给整个表建索引是浪费——索引里塞了一堆永远不被查的死数据。**部分索引**只索引满足条件的行：

```sql
CREATE INDEX idx_posts_published_alive
  ON posts(published_at DESC)
  WHERE status = 'published' AND deleted_at IS NULL;
```

- 索引体积小 50%~90%（取决于数据分布）
- 写入维护成本也小（不满足条件的行根本不进索引）
- 查询条件**必须包含**索引定义的 WHERE 子句，PG 才会用这个索引

特别适合：软删除标记、状态字段、租户标记、地理范围等大量数据分布不均的场景。

### 9. 表达式索引：函数包列也能走

回到前面那个坑：`WHERE lower(email) = ?` 不走 `email` 上的索引。解法是**直接对表达式建索引**：

```sql
CREATE UNIQUE INDEX idx_users_email_lower ON users (lower(email));

-- 走了
SELECT * FROM users WHERE lower(email) = 'alice@example.com';
```

注意两点：

1. 查询里的表达式必须和索引里**完全一致**，包括函数名、参数顺序、类型转换。`LOWER(email)` 和 `lower(email)` 一样，但 `lower(email::text)` 就可能匹配不上。
2. 表达式索引在写入时会调用函数，纯函数（同输入同输出）才行。`now()` 这种不行。

JSONB 字段也常用：

```sql
CREATE INDEX idx_posts_cover_url ON posts ((metadata->>'cover_url'));
```

`(metadata->>'cover_url')` 必须用双层括号，不然语法歧义。

### 10. 其他索引类型一句话总结

PG 的索引不止 B-tree 一种。日常你只需要分得清什么时候用哪个：

| 类型 | 适用场景 | 一句话理由 |
|------|---------|-----------|
| **B-tree** | 等值、范围、排序 | 默认，90% 场景 |
| **Hash** | 仅等值 | 比 B-tree 略快但没排序能力，PG 10+ 才支持 WAL，几乎被淘汰 |
| **GIN** | 数组、JSONB、全文搜索 | 倒排索引，"包含某元素"超快 |
| **GiST** | 地理空间、范围类型 | PostGIS 必备 |
| **BRIN** | 超大表 + 物理顺序与值顺序相关 | 索引只有几 KB，但只能"跳过大块"不能精确定位 |
| **SP-GiST** | 不平衡数据（前缀树、四叉树） | 罕见 |

实战 99% 的索引是 B-tree。剩下的 1% 里，最常用的是 GIN——尤其是 JSONB 列的 `@>` 包含查询：

```sql
CREATE INDEX idx_posts_metadata_gin ON posts USING GIN (metadata);

-- 查所有封面图来自 /img/ 的文章
SELECT * FROM posts WHERE metadata @> '{"cover_url": "/img/pg.png"}';
```

### 11. JOIN 算法：Nested Loop / Hash / Merge

EXPLAIN 里 JOIN 的实现有三种，背景知识级别：

**Nested Loop**：外层每一行，去内层找匹配。
- 适合：外层很小（几行），内层有索引
- 不适合：两边都大且都没索引——`O(N×M)` 直接爆炸

**Hash Join**：先把小表（build side）做成哈希表，再扫大表（probe side）匹配。
- 适合：等值连接、内存够放下小表
- 不适合：内存不够（spill 到磁盘后性能崩盘）

**Merge Join**：两边都按 join key 排序，然后像归并排序一样合并。
- 适合：两边都已经按 join key 有序（比如都有该列的 B-tree 索引）
- 适合：超大表之间的等值 JOIN（不依赖内存）

**怎么影响优化器选择**：基本不用手动管。但要知道两条经验法则：
1. **小表 JOIN 大表，小表上的过滤要尽可能严**——给小表加索引比给大表加索引收益更大。
2. **看到 Nested Loop 但 loops 很大（几万次）**，几乎一定是少了内层索引。

### 12. 该不该加索引：三问

每次想新加索引，先问自己：

1. **这个查询的 SQL 是不是高频的？** 一天跑 1 次的统计任务不值得为它建索引。
2. **现有的索引能不能复用？** 在 `(a, b)` 之上再建 `(a)` 是浪费——前者已经覆盖了对 a 的最左匹配。
3. **加这个索引让写入慢多少？** 写密集表上每多一个索引，`INSERT/UPDATE/DELETE` 都贵一点。一张表索引超过 5~6 个就要警惕。

业内一个粗糙但好用的标准：**外键列默认加索引，主键 + 唯一约束自动有索引，剩下的按真实 query 来加**。永远不要"预测未来"加索引——线上没人查的索引就是负债。

定期跑这个查询能发现没用的索引：

```sql
SELECT schemaname, relname AS table, indexrelname AS index,
       idx_scan AS scans, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE idx_scan = 0 AND indexrelname NOT LIKE '%_pkey'
ORDER BY pg_relation_size(indexrelid) DESC;
```

`idx_scan = 0` 且不是主键的，基本可以删掉。注意先确认统计已收集足够时间（PG 重启后 `idx_scan` 会清零）。

### 13. 索引膨胀与 REINDEX

B-tree 索引在大量 `UPDATE/DELETE` 之后会**膨胀**——已删除的索引项不会立即回收，要等 VACUUM。极端情况索引体积比表还大，扫起来比 Seq Scan 还慢。

判断膨胀程度：

```sql
SELECT pg_size_pretty(pg_relation_size('posts')) AS table_size,
       pg_size_pretty(pg_indexes_size('posts')) AS indexes_size;
```

索引比表大不少倍，就该考虑：

```sql
REINDEX INDEX CONCURRENTLY idx_posts_status;  -- PG 12+
```

`CONCURRENTLY` 不锁表（只在头尾各短暂加锁），生产能在线跑。没这个修饰词的 `REINDEX` 会持有 AccessExclusiveLock，整个表的读写都停——白天千万别跑。

### 14. 窗口函数登场

窗口函数解决一类典型问题："对每一行计算它在某个分组里的某种统计值，但**不要折叠成一行**"。

对比：

```sql
-- 聚合：每作者多少篇文章。结果按作者折叠成一行
SELECT author_id, count(*) FROM posts GROUP BY author_id;

-- 窗口：每篇文章带上"该作者总文章数"。结果保留每一行
SELECT id, title, author_id,
       count(*) OVER (PARTITION BY author_id) AS author_total
FROM posts;
```

关键就一个 `OVER (...)`。`PARTITION BY` 像 GROUP BY，但不折叠行，而是在每行上贴个"同组的聚合值"。

### 15. 排名三兄弟：ROW_NUMBER / RANK / DENSE_RANK

最常考也最常用：

```sql
SELECT id, title, view_count, author_id,
       ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY view_count DESC) AS rn,
       RANK()       OVER (PARTITION BY author_id ORDER BY view_count DESC) AS rk,
       DENSE_RANK() OVER (PARTITION BY author_id ORDER BY view_count DESC) AS drk
FROM posts;
```

三者区别看名字记不住，看一个例子就懂：阅读数 `100, 100, 80, 60`

- `ROW_NUMBER`: `1, 2, 3, 4`（无脑递增）
- `RANK`: `1, 1, 3, 4`（并列后跳号）
- `DENSE_RANK`: `1, 1, 2, 3`（并列后不跳）

最常用的是 `ROW_NUMBER` —— 配合外层 `WHERE rn = 1` 就是"每组取第一条"的标准写法：

```sql
-- 每个作者最热的一篇
SELECT * FROM (
  SELECT id, title, author_id, view_count,
         ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY view_count DESC) AS rn
  FROM posts WHERE status = 'published'
) t WHERE t.rn = 1;
```

Day 22 提过 `DISTINCT ON` 是 PG 扩展，效果等价但更简洁；窗口函数版本是 SQL 标准，跨数据库可移植。**库内自己用 DISTINCT ON，跨库或团队不熟 PG 用窗口函数**，这是务实的选择。

### 16. LAG / LEAD：访问相邻行

不用自连接就能拿到"上一行"或"下一行"：

```sql
-- 每篇文章和上一篇文章的阅读数差距
SELECT id, title, view_count,
       LAG(view_count) OVER (ORDER BY published_at) AS prev_views,
       view_count - LAG(view_count) OVER (ORDER BY published_at) AS diff
FROM posts WHERE status = 'published';
```

`LAG(col, n, default)` 取前 n 行，没有就用 default。`LEAD` 是后 n 行。这两个在做"环比"、"同比"、"前后对比"时极其顺手——以前要写自连接的场景，现在一行搞定。

### 17. 累计与移动窗口

`SUM / AVG / COUNT` 加 `OVER (...)` 就是窗口聚合：

```sql
-- 累计阅读数（按发布顺序）
SELECT id, title, view_count, published_at,
       SUM(view_count) OVER (ORDER BY published_at
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM posts WHERE status = 'published';
```

`ROWS BETWEEN ... AND ...` 是窗口帧（frame）的定义：

- `UNBOUNDED PRECEDING AND CURRENT ROW`：从开始到当前行（累计）
- `6 PRECEDING AND CURRENT ROW`：最近 7 行（移动平均）
- `CURRENT ROW AND UNBOUNDED FOLLOWING`：当前到结尾

不写 frame 时的默认行为有坑：**有 ORDER BY 但没写 frame，默认是 `RANGE UNBOUNDED PRECEDING`**——意思和 ROWS 略不同，遇到并列值会把它们一起算进来。生产代码建议**永远显式写 frame**。

### 18. 实战：给 Day 22 的查询补索引

回顾 Day 22 §16 的"作者中心首屏"查询。看起来漂亮，但没有索引下场会很难看。该建哪些索引？

```sql
-- 1. posts(author_id, deleted_at, status)：覆盖 author 的 LEFT JOIN 与状态过滤
CREATE INDEX idx_posts_author_alive_status
  ON posts(author_id, status)
  WHERE deleted_at IS NULL;

-- 2. posts(author_id, published_at DESC)：latest_title 子查询用
CREATE INDEX idx_posts_author_published
  ON posts(author_id, published_at DESC)
  WHERE status = 'published';

-- 3. post_tags(post_id) 已经在 PK 里；(tag_id) 单列索引已建
-- 4. users(id) 是 PK，自动有索引
```

建完之后跑 `EXPLAIN ANALYZE`：原来的 Seq Scan + Hash Join 应该变成 Index Scan + Nested Loop（小数据量）或 Merge Join（大数据量）。Buffers 数也会显著下降。

**注意**：上面是"教学版"。生产环境是否真要这么建，取决于这条 SQL 的真实 QPS。如果只是个偶尔点开的页面，加一个 `(author_id)` 索引就够了——剩下的过度优化。

### 19. 通往 Day 24 的桥

Day 21 ~ 23 把"查"练到了——schema、JOIN/聚合/子查询、索引和 EXPLAIN。但博客系统还缺两块业务实体：**评论**和**点赞**。

这两个东西看起来简单，建模一上来就有坑：

- 评论要不要支持楼中楼？支持的话用哪种树形存储？查"某文章的全部评论树"怎么写不爆栈？
- 点赞是 N:M，但每个文章实时显示"赞数"——是每次都 `count()` 还是维护一个计数列？计数列怎么保证不漂移？
- 通知（"你的文章被点赞了"）是异质事件，要不要每种事件一张表？

Day 24 就讲这些。回到建模视角——**范式与反范式的权衡**、ER 设计的真正用处、几种典型业务关系（嵌套树、N:M+计数、异质事件）的标准答案。把 schema 扩展到真实可用的程度，Day 25 才能用 Prisma 接上去。

---

## 💻 实践练习

### 主练习：把所有查询都过一遍 EXPLAIN

直接用 Day 22 留下的 `solutions/blog/blog-db`，今天追加：

1. `migrations/006_indexes.sql` — Day 23 要建的索引集合（已写好，直接 apply）
2. `queries/07_explain.sql` — EXPLAIN 各种节点类型对照
3. `queries/08_indexes.sql` — 建/删索引前后对比执行计划
4. `queries/09_window.sql` — 窗口函数完整练习

**核心训练**：每一条 SQL 都先在 `\timing on` 下记录耗时，然后建索引、再跑、再记。把 "数量级变化" 记在小本本上——这种直觉只有亲手做过才有。

### 加分练习：灌大数据看真效果

10 行的 `seed.sql` 看不出索引效果。本目录 `scripts/seed.sh --large` 会调用 `seed_large.sql` 生成 **10 万篇文章 + 30 万标签关联**，跑完之后所有 EXPLAIN 才有意义。

跑完大数据之后建议练习：

1. 不加索引跑一遍 Day 22 §16 "作者中心首屏"，记下耗时
2. 按本文 §18 建索引，再跑一遍，对比
3. 故意写一个**走不到索引**的查询（比如 `WHERE lower(slug) = ?`），看 EXPLAIN 怎么打脸
4. 把 `JOIN` 改成 `Nested Loop` / `Hash Join` 各跑一次（用 `SET enable_hashjoin = off` 等强制），对比 actual time
5. 跑一次 `EXPLAIN (ANALYZE, BUFFERS)`，找出最大的 Heap Fetches 节点
6. 用窗口函数重写"每作者最热文章"，对比 `DISTINCT ON` 版本的 EXPLAIN

### 验收清单

```bash
# 1. 应用 006 索引迁移
docker exec -i pg-blog psql -U blog -d blog -f /workspace/migrations/006_indexes.sql

# 2. 大数据 seed
./scripts/seed.sh --large
# 10 万 posts + 30 万 post_tags，耗时 ~30 秒

# 3. 看索引列表
docker exec -it pg-blog psql -U blog -d blog -c "\di"
# 应能看到 idx_posts_* 系列

# 4. 关键查询 EXPLAIN 应走 Index
docker exec -it pg-blog psql -U blog -d blog -c "
  EXPLAIN ANALYZE SELECT * FROM posts
  WHERE author_id = (SELECT id FROM users LIMIT 1) AND status='published'
  ORDER BY published_at DESC LIMIT 10;"
# 应该看到 Index Scan using idx_posts_author_published
# Execution Time 应 < 5ms（10w 行规模）

# 5. 全文 EXPLAIN 演示
docker exec -i pg-blog psql -U blog -d blog -f /workspace/queries/07_explain.sql

# 6. 窗口函数练习
docker exec -i pg-blog psql -U blog -d blog -f /workspace/queries/09_window.sql
```

---

## ⚠️ 常见误区

- **以为加了索引一定走索引**：优化器算成本。小表、低选择性列、统计过期都可能让它选 Seq Scan，这通常是对的。
- **函数包列还期待走索引**：`lower(email)`、`date(created_at)`、`id::text` 全部废索引。要么不包，要么建表达式索引。
- **联合索引顺序拍脑袋**：等值列在前、范围列在后；选择性高的在前。错了顺序整个索引可能用不上。
- **范围条件之后还指望第二列走索引**：B-tree 一旦在某列做了范围扫，后续列就只能 Filter，不走索引。
- **`SELECT *` + 覆盖索引**：覆盖索引的前提是"只取索引里的列"，`*` 直接把这个优化干掉。
- **盲信 EXPLAIN 不带 ANALYZE 的估算**：估算只是估算，统计过期时能离谱到差 100 倍。怀疑性能问题先看 actual time。
- **跑 `REINDEX` 不加 CONCURRENTLY**：会锁表。生产**永远加** `CONCURRENTLY`。
- **窗口函数当聚合用**：能 GROUP BY 就别窗口——窗口要排序、要扫全分区，比聚合贵得多。
- **窗口函数不写 frame**：`ROWS` 和 `RANGE` 默认行为不同，有并列值时累计结果会不一样。永远显式写。
- **新加索引立刻看效果**：PG 的统计信息可能没更新。建完索引手动跑 `ANALYZE posts` 再看。

---

## ✅ 今日产出

- [ ] 能解释 B-tree 为什么 O(log N)，以及为什么范围扫描也能快
- [ ] 能读懂 `EXPLAIN ANALYZE (BUFFERS)` 输出的每一段
- [ ] 给 Day 22 的查询补完所有合理的索引（migration 006）
- [ ] 走完 `queries/07_explain.sql` / `08_indexes.sql` / `09_window.sql`
- [ ] 至少演示一次"加索引前 vs 加索引后" Execution Time 的数量级差距
- [ ] 用窗口函数重写一次 Day 22 §16 的"每作者最热文章"，对比 `DISTINCT ON`
- [ ] 提交到 GitHub，commit message 写明 "day 23 indexes & explain & window"

---

## 📚 延伸阅读

- [Use The Index, Luke!](https://use-the-index-luke.com/)（最好的 SQL 索引入门，免费在线）
- [PostgreSQL 官方文档 — Index Types](https://www.postgresql.org/docs/current/indexes-types.html)
- [PostgreSQL 官方文档 — Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html)（必读，把执行计划讲透了）
- [PostgreSQL 官方文档 — Window Functions](https://www.postgresql.org/docs/current/tutorial-window.html)
- [Depesz 的 EXPLAIN 可视化](https://explain.depesz.com/)（粘 EXPLAIN 输出，自动彩色高亮慢节点）
- [pgMustard](https://www.pgmustard.com/)（付费但有免费额度的 EXPLAIN 分析工具）
- [Postgres Wiki — Slow Query Questions](https://wiki.postgresql.org/wiki/Slow_Query_Questions)（提问模板，自己排查时也按这个清单走）

---

[⬅️ Day 22](../day-22/) | [➡️ Day 24](../day-24/)
