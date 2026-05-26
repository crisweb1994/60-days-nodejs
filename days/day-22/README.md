# Day 22 — SQL 进阶：JOIN、子查询与聚合

## 📋 今日目标

- 把 INNER / LEFT / RIGHT / FULL JOIN 一次性想清楚，再也不靠"试出来"
- 理解 `ON` 和 `WHERE` 的差异，知道为什么 LEFT JOIN 加错位置就退化成 INNER
- 写顺 `GROUP BY / HAVING / 聚合函数`，能用一条 SQL 出报表
- 学会三种子查询（标量、行、表），分清相关子查询和非相关子查询
- 在 JOIN 和子查询之间做选择，而不是"凭感觉"
- 把这些武器用到 Day 21 的博客 schema 上，把昨天预留的"待 JOIN"场景挨个补齐

---

## 📖 核心知识点

### 1. 关系模型为什么需要 JOIN

Day 21 已经把数据拆成了四张表：`users / posts / tags / post_tags`。拆的代价是查询时要"合回去"——这就是 JOIN 的全部意义。

很多人下意识觉得 JOIN 慢、要避免，于是把数据反范式塞成一张大表。这种直觉一半对一半错：

- **错的部分**：现代数据库的 JOIN 在有合适索引时是 O(N·log M) 级别，并不是性能黑洞。博客这种量级几百万行内根本看不出区别。
- **对的部分**：JOIN **次数**和**结果集膨胀**才是问题。两张表都 1 万行、笛卡尔积是 1 亿行，再过滤来不及。

记住一句话：**JOIN 本身不贵，错误的 JOIN 才贵**。今天的重点是怎么写对。

### 2. JOIN 的心智模型：从笛卡尔积过滤出来

所有 JOIN 都可以这么想：

1. 先把两张表做笛卡尔积（每行配每行）
2. 用 `ON` 条件过滤
3. 根据 JOIN 类型决定要不要补回"没匹配上的那一边"

不同 JOIN 类型的区别只在第 3 步：

| 类型 | 没匹配上的左边 | 没匹配上的右边 |
|------|--------------|--------------|
| `INNER JOIN` | 丢掉 | 丢掉 |
| `LEFT JOIN` | **保留**（右边补 NULL） | 丢掉 |
| `RIGHT JOIN` | 丢掉 | **保留**（左边补 NULL） |
| `FULL JOIN` | **保留** | **保留** |
| `CROSS JOIN` | 不过滤，直接笛卡尔积 |  |

这张表背下来，比记任何 Venn 图都靠谱。Venn 图给的是直觉，不是语义——真正决定结果的是"该补 NULL 还是丢掉"。

### 3. INNER JOIN：默认的"交集"

```sql
SELECT p.id, p.title, u.username
FROM posts p
INNER JOIN users u ON u.id = p.author_id
WHERE p.status = 'published';
```

只想要**两边都有**的行就用 INNER。`JOIN` 不写类型时就是 `INNER JOIN`，但**显式写上 INNER**——给 review 的人一眼看清意图，比省两个字母值得。

INNER JOIN 的两个习惯：

- **永远给表起别名**：`posts p`、`users u`。表名重复或子查询里没别名会让 SQL 越写越乱。
- **JOIN 条件写在 `ON` 里，过滤条件写在 `WHERE` 里**：虽然 INNER JOIN 两者等价（PG 优化器会下推），但语义上一个是"怎么连起来"、一个是"连完之后筛什么"，分开写未来改成 LEFT JOIN 才不用大改。

### 4. LEFT JOIN：博客里用得最多的 JOIN

"查每篇文章和它的标签列表"——这是 LEFT JOIN 的经典场景：**有些文章可能一个标签都没有，也要出现在结果里**。

```sql
SELECT p.id, p.title, t.name AS tag_name
FROM posts p
LEFT JOIN post_tags pt ON pt.post_id = p.id
LEFT JOIN tags t        ON t.id = pt.tag_id
WHERE p.status = 'published';
```

没匹配上的文章在结果里会出现一行，`tag_name` 为 NULL。如果改成 INNER JOIN，没标签的文章会直接消失。

LEFT JOIN 还有一个隐藏技能——**反连接（anti-join）**，专门用来查"在 A 表但不在 B 表"的行：

```sql
-- 查从来没被任何文章引用过的标签
SELECT t.id, t.name
FROM tags t
LEFT JOIN post_tags pt ON pt.tag_id = t.id
WHERE pt.tag_id IS NULL;
```

`WHERE pt.tag_id IS NULL` 这一行是关键：LEFT JOIN 保留了所有 tags，没有引用的右边全是 NULL，过滤一下就拿到了"孤儿标签"。这个套路在所有关系数据库里都通用，必须掌握。

### 5. `ON` 还是 `WHERE`？LEFT JOIN 的最大坑

把过滤条件放错位置，LEFT JOIN 会**悄悄退化成 INNER JOIN**：

```sql
-- ❌ 想查"所有用户 + 他们已发布的文章数"，但 published 用户没文章就消失了
SELECT u.username, count(p.id)
FROM users u
LEFT JOIN posts p ON p.author_id = u.id
WHERE p.status = 'published'    -- ★ 在 WHERE 里
GROUP BY u.username;

-- ✅ 把过滤条件挪到 ON
SELECT u.username, count(p.id)
FROM users u
LEFT JOIN posts p ON p.author_id = u.id AND p.status = 'published'
GROUP BY u.username;
```

为什么？LEFT JOIN 是"先按 ON 连，连完保留所有左边"。`WHERE p.status = 'published'` 是连完之后再过滤——而没匹配上的左边那行，`p.status` 是 NULL，被这个 WHERE 直接淘汰。结果就是：那些没有 published 文章的用户根本不在结果里。

**口诀：要"保留某边"的过滤就写 `ON`，要"全表过滤"才写 `WHERE`**。INNER JOIN 不在乎，但 LEFT/RIGHT/FULL JOIN 必须分清。

### 6. RIGHT JOIN 和 FULL JOIN：能不用就不用

```sql
-- RIGHT JOIN 等价的 LEFT JOIN 写法
SELECT ... FROM posts p RIGHT JOIN users u ON ...;
-- 等价：
SELECT ... FROM users u LEFT JOIN posts p ON ...;
```

RIGHT JOIN 永远能改写成 LEFT JOIN，且 LEFT JOIN 更符合阅读直觉（从左到右扫一遍）。**团队规范上统一用 LEFT JOIN**，能避免 review 时来回脑补。

FULL JOIN 罕见但有用：做两个数据源对账（"哪些只在 A、哪些只在 B、哪些两边都有"）。日常 CRUD 几乎用不到，遇到再说。

### 7. 自连接：同一张表 JOIN 自己

层级数据、关联推荐都靠它。博客场景比如"找出和某篇文章共享标签的其他文章"：

```sql
SELECT DISTINCT p2.id, p2.title
FROM posts p1
INNER JOIN post_tags pt1 ON pt1.post_id = p1.id
INNER JOIN post_tags pt2 ON pt2.tag_id = pt1.tag_id AND pt2.post_id <> p1.id
INNER JOIN posts p2      ON p2.id = pt2.post_id
WHERE p1.slug = 'hello-postgres';
```

自连接的关键是**起两个不同的别名**（`p1` / `p2`），不然引用会歧义。`<>` 是防止把自己也算进相似列表。

### 8. 聚合函数：`COUNT(*)` / `COUNT(col)` / `COUNT(DISTINCT col)`

这三个**结果可能完全不同**：

```sql
SELECT
  count(*)                AS total_rows,        -- 所有行
  count(published_at)     AS published_count,   -- published_at 非 NULL 的行
  count(DISTINCT author_id) AS unique_authors   -- author_id 去重后的个数
FROM posts;
```

- `count(*)`：连 NULL 的行都数。**统计"行数"用这个**。注意 PG 因为 MVCC 必须真的扫一遍（不像 MyISAM 有缓存），大表上别幻想它免费——只要近似值，查 `pg_class.reltuples` 才是 O(1)。
- `count(col)`：跳过 `col IS NULL` 的行。**想统计"某字段有值的数量"用这个**。
- `count(DISTINCT col)`：先去重再数。**注意性能**——大表上去重成本不低，能避免就避免。

其他常用聚合：`sum / avg / min / max / array_agg / string_agg / jsonb_agg`。其中 `array_agg` 在 PG 里非常香：

```sql
-- 每篇文章一行，把标签拼成数组
SELECT p.id, p.title,
       array_agg(t.name ORDER BY t.name) FILTER (WHERE t.id IS NOT NULL) AS tags
FROM posts p
LEFT JOIN post_tags pt ON pt.post_id = p.id
LEFT JOIN tags t        ON t.id = pt.tag_id
GROUP BY p.id;
```

`FILTER (WHERE ...)` 是 SQL 标准的"条件聚合"——避免 LEFT JOIN 后 `array_agg(NULL)` 得到 `{NULL}` 这种垃圾结果。比 `CASE WHEN` 套在聚合里干净得多。

### 9. `GROUP BY`：SQL 标准的硬规则

**SELECT 列要么在 GROUP BY 里，要么被聚合函数包起来**。这条规则在 PG 严格执行——MySQL 默认放宽过，结果就是无数个"为什么我每次查到的值不一样"的坑。

```sql
-- ❌ author_id 没在 GROUP BY 里，没被聚合
SELECT author_id, status, count(*) FROM posts GROUP BY status;

-- ✅ 要么加进 GROUP BY
SELECT author_id, status, count(*) FROM posts GROUP BY author_id, status;

-- ✅ 要么聚合掉
SELECT max(author_id) AS some_author, status, count(*) FROM posts GROUP BY status;
```

PG 14+ 支持 `GROUP BY` 用列序号或表达式，但**别用 `GROUP BY 1, 2`**——加列时一改全错。多写两个字段名换可维护性。

进阶：`GROUP BY GROUPING SETS / ROLLUP / CUBE` 一次性出多个维度的小计。报表场景会非常省事，但理解成本高，第一次见可以放过去。

### 10. `HAVING` vs `WHERE`：分清作用阶段

执行顺序是：

```
FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT（含窗口函数）→ DISTINCT → ORDER BY → LIMIT
```

（窗口函数在 SELECT 阶段计算，所以**能引用 GROUP BY 之后的聚合结果，但不能写进 WHERE/GROUP BY/HAVING**——Day 23 详谈。）

`WHERE` 过滤**原始行**，`HAVING` 过滤**聚合后的组**。

```sql
-- 找出"已发布文章数超过 2 篇"的作者
SELECT author_id, count(*) AS published_count
FROM posts
WHERE status = 'published'          -- 先过滤行
GROUP BY author_id
HAVING count(*) > 2;                -- 再过滤组
```

把 `count(*) > 2` 塞进 WHERE 会报错——WHERE 阶段还没聚合，count 还不存在。**只要条件涉及聚合结果，就必须在 HAVING 里**。

反过来，**能写在 WHERE 里的就不要写在 HAVING 里**——WHERE 阶段过滤掉的行根本不参与聚合，更快。

### 11. 子查询的三种形态

按返回结果分：

**标量子查询**——返回一个值，可以放在 SELECT 列或 WHERE 比较里。

```sql
-- 每篇文章带上"全站平均阅读数"作为对比
SELECT id, title, view_count,
       (SELECT avg(view_count) FROM posts WHERE status = 'published') AS site_avg
FROM posts
WHERE status = 'published';
```

**行子查询**——返回一行多列，配 `=`、`<` 等比较。少见。

```sql
SELECT * FROM posts
WHERE (author_id, status) = (
  SELECT author_id, status FROM posts WHERE slug = 'hello-postgres'
);
```

子查询必须返回**恰好一行**，否则运行时报错。这里靠 `slug` 的 UNIQUE 约束兜底；换成非唯一列就要自己加 `LIMIT 1` 或确保过滤够紧。

**表子查询**——返回结果集，放在 `FROM` 或 `IN / EXISTS` 里。最常用。

```sql
-- 把"每作者文章数"作为派生表，再 JOIN 回 users
SELECT u.username, x.cnt
FROM users u
INNER JOIN (
  SELECT author_id, count(*) AS cnt
  FROM posts WHERE status = 'published'
  GROUP BY author_id
) x ON x.author_id = u.id;
```

派生表**必须起别名**（`AS x`），这是 SQL 语法硬性要求。

### 12. 相关 vs 非相关子查询

非相关子查询：里面不依赖外面，**只算一次**。

```sql
SELECT * FROM posts WHERE view_count > (SELECT avg(view_count) FROM posts);
```

相关子查询：里面引用了外层的列，**外层每行都跑一次**。

```sql
-- 每篇文章的标签数
SELECT p.id, p.title,
       (SELECT count(*) FROM post_tags pt WHERE pt.post_id = p.id) AS tag_count
FROM posts p;
```

相关子查询写起来直观，但容易写出 O(N²)。**能改写成 `LEFT JOIN + GROUP BY` 的就改写**——优化器对 JOIN 更聪明。例：

```sql
SELECT p.id, p.title, count(pt.tag_id) AS tag_count
FROM posts p
LEFT JOIN post_tags pt ON pt.post_id = p.id
GROUP BY p.id;
```

两种写法逻辑一样，但 JOIN 版本一次扫描搞定，相关子查询版要扫文章数次。

### 13. `IN` / `EXISTS` / `NOT EXISTS`：NULL 的最后一个坑

`IN` 和 `EXISTS` 多数情况等价，但**遇到 NULL 行为不同**：

```sql
-- 想查"作者从来没写过任何草稿的 published 文章"
-- ❌ 一旦子查询里出现哪怕一行 author_id IS NULL，整个结果集会空
SELECT * FROM posts
WHERE status = 'published'
  AND author_id NOT IN (
    SELECT author_id FROM posts WHERE status = 'draft'
  );
```

`NOT IN` 遇到子查询里的 NULL 会让整个比较结果变成 NULL（"不等于一个未知的值，结果也是未知"），外层 WHERE 把这些过滤掉，于是返回空。

**安全的写法是 `NOT EXISTS`**：

```sql
SELECT * FROM posts p
WHERE p.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM posts d
    WHERE d.status = 'draft' AND d.author_id = p.author_id
  );
```

`EXISTS` 检查的是"有没有匹配的行"，不参与值比较，NULL 不会污染结果。**记住这条规则**：`NOT IN` 涉及可空列时永远改成 `NOT EXISTS`，没有例外。

附带一个小细节：`EXISTS (SELECT 1 FROM ...)` 里写 `1` 还是 `*` 没区别——优化器看的是有没有行，不读列。习惯写 `1` 更显式。

### 14. CTE（`WITH`）：把复杂查询拆成读得懂的步骤

子查询嵌套两层就开始难读。CTE 让你像写代码一样命名中间结果：

```sql
WITH published_posts AS (
  SELECT * FROM posts WHERE status = 'published' AND deleted_at IS NULL
),
author_stats AS (
  SELECT author_id,
         count(*) AS total,
         sum(view_count) AS views
  FROM published_posts
  GROUP BY author_id
)
SELECT u.username, s.total, s.views
FROM author_stats s
INNER JOIN users u ON u.id = s.author_id
ORDER BY s.views DESC;
```

几个事实需要知道：

- **PG 12 之前 CTE 是"优化栅栏"**，整块物化、不下推谓词，写法不对会慢。PG 12+ 默认会内联，行为接近子查询。生产 PG 16 不用担心。
- CTE 写**递归查询**是独门绝技（评论树、分类树、组织架构）。语法 `WITH RECURSIVE`，今天不展开，知道有这把刀就行。
- CTE 是查询作用域的"局部变量"，**只在当前 SQL 语句存活**，不是临时表。

### 15. JOIN 还是子查询：怎么选

实战经验，按优先级排：

1. **能 JOIN 就 JOIN**：优化器最熟悉的形态，最容易走索引。
2. **存在性判断用 EXISTS**：语义清晰、性能稳定，NULL 不咬人。
3. **派生统计值用 CTE / 派生表**：步骤清楚，未来好改。
4. **标量子查询少用**：放在 SELECT 列里时，外层多少行就跑多少次。能改 LEFT JOIN + GROUP BY 就改。
5. **`IN (子查询)` 没问题，`NOT IN (子查询)` 永远换 NOT EXISTS**。

判断一段 SQL 写得好不好，看一个标准：**未来加一个过滤条件，要不要重构整段**。重构成本越低，写得越好。

### 16. 综合实战：博客常见报表

把上面 15 点拼起来，看看真实查询长什么样。

**作者中心首屏**——一次出"作者信息 + 文章数 + 总阅读 + 最新一篇标题"：

```sql
SELECT
  u.id, u.username,
  count(p.id)             FILTER (WHERE p.status = 'published') AS published_count,
  coalesce(sum(p.view_count) FILTER (WHERE p.status = 'published'), 0) AS total_views,
  (SELECT title FROM posts
   WHERE author_id = u.id AND status = 'published'
   ORDER BY published_at DESC LIMIT 1) AS latest_title
FROM users u
LEFT JOIN posts p ON p.author_id = u.id AND p.deleted_at IS NULL
WHERE u.role IN ('author', 'admin')
GROUP BY u.id
ORDER BY total_views DESC;
```

读这条 SQL 时注意几处：

- `LEFT JOIN ... AND p.deleted_at IS NULL`：过滤条件写在 `ON` 里，保留没文章的作者。
- `FILTER (WHERE ...)`：在 LEFT JOIN 之后做条件聚合，比子查询省一次扫描。
- `latest_title` 用标量子查询：因为要按 `published_at` 排序取第一条，用 JOIN + 窗口函数也可以但更绕。**取"最新一条"这种场景标量子查询合适**。
- `coalesce(sum(...), 0)`：没有任何文章时 `sum` 返回 NULL，前端拿到 NULL 容易出 bug，统一兜底成 0。

**孤儿标签列表**——从来没被任何文章用过的：

```sql
SELECT t.id, t.name, t.slug
FROM tags t
WHERE NOT EXISTS (SELECT 1 FROM post_tags pt WHERE pt.tag_id = t.id);
```

或者 LEFT JOIN 版本（注意 anti-join 模式）：

```sql
SELECT t.id, t.name, t.slug
FROM tags t
LEFT JOIN post_tags pt ON pt.tag_id = t.id
WHERE pt.tag_id IS NULL;
```

两条都对，**NOT EXISTS 版本意图更显式**，推荐。

**TOP N per group**——每个作者最热的一篇：

```sql
SELECT DISTINCT ON (author_id) author_id, id, title, view_count
FROM posts
WHERE status = 'published'
ORDER BY author_id, view_count DESC;
```

`DISTINCT ON` 是 PG 扩展（非标准），但**写"每组取第一条"比窗口函数省事得多**。`ORDER BY` 第一项必须和 `DISTINCT ON` 匹配，第二项决定每组里挑谁。Day 23 会讲窗口函数对比写法。

### 17. 通往 Day 23 的桥

上面所有查询能跑通是一回事，**跑得快**是另一回事。Day 23 的索引会回答这些问题：

- `SELECT ... WHERE author_id = ?` 是不是每次都全表扫？给 `author_id` 建索引能省多少？
- `LEFT JOIN post_tags pt ON pt.post_id = p.id` 为什么 `pt.post_id` 一定要有索引？
- `count(*) FILTER (WHERE status = 'published')` 能不能走部分索引？
- `EXPLAIN` 里的 `Hash Join` / `Nested Loop` / `Merge Join` 是怎么选出来的？

今天**先写对**，明天**再写快**。顺序很重要——见过太多人没把 SQL 写对就上 Redis 缓存兜底，结果是补不完的坑。

---

## 💻 实践练习

### 主练习：把昨天预留的"待 JOIN"场景全部补齐

直接复用 Day 21 的 `blog-db`，今天只新增 `queries/` 下的练习文件：

1. `queries/04_joins.sql` —— 各类 JOIN 演示与对比
2. `queries/05_aggregates.sql` —— GROUP BY / HAVING / 聚合 / FILTER
3. `queries/06_subqueries.sql` —— 标量、相关、EXISTS、CTE

每一条都先在脑子里预测结果集大小（几行？哪些列可能 NULL？），再回车看实际。**预测和实际不一致的地方，就是你今天真正学到的东西**。

### 加分练习：把博客接口需要的 SQL 写一遍

不开 Prisma，纯 SQL 写出后端列表接口需要的查询：

1. **文章列表页**：返回 `id, title, slug, published_at, author_name, tag_names[]`，按 `published_at` 倒序分页（LIMIT/OFFSET）
2. **作者详情**：作者信息 + 已发布文章数 + 累计阅读 + 最近 5 篇文章标题
3. **标签云**：每个标签 + 关联文章数，按文章数倒序，没文章的标签也要在（计数为 0）
4. **热门文章**：阅读数 ≥ 全站平均 2 倍的已发布文章
5. **重复 slug 检测**：找出 `posts` 里 slug 出现超过 1 次的（DB 有 UNIQUE 约束，所以应该 0 行；但要练这个 GROUP BY + HAVING 写法）
6. **打过 'NestJS' 标签的所有文章**（用 `JOIN` 一版，用 `EXISTS` 一版，对比执行计划）

### 验收清单

```bash
# 1. JOIN 全家桶：会依次输出 4.1~4.8 八段结果，逐段对照预测
docker exec -i pg-blog psql -U blog -d blog -f /workspace/queries/04_joins.sql
# 关键几段的预期：
#   4.1 INNER JOIN published 文章 → 5 行（alice 3 + bob 2，admin 没文章）
#   4.2 反例 vs 正解 → 反例少一行（admin 消失），正解 3 行（admin 计数为 0）
#   4.4 array_agg 版每篇文章一行 → 10 行，没标签的 tags 列是 NULL（不是 {NULL}）
#   4.5 孤儿标签 → 当前 seed 全部 tag 都有引用，应为 0 行（见下文 #3）

# 2. 聚合：每作者已发布文章数
docker exec -it pg-blog psql -U blog -d blog -c "
  SELECT u.username, count(p.id) FILTER (WHERE p.status='published') AS n
  FROM users u LEFT JOIN posts p ON p.author_id = u.id
  GROUP BY u.username ORDER BY n DESC;"
# admin 应该是 0，alice / bob 各自统计

# 3. 孤儿标签
docker exec -it pg-blog psql -U blog -d blog -c "
  SELECT t.name FROM tags t
  WHERE NOT EXISTS (SELECT 1 FROM post_tags pt WHERE pt.tag_id=t.id);"
# 当前 seed 里 5 个 tag 全部被引用，应为 0 行——这是正常的。
# 想看到非空结果，自己删几条 post_tags 再跑：
#   DELETE FROM post_tags WHERE tag_id = (SELECT id FROM tags WHERE slug='typescript');
# 再跑上面那条 SELECT，应出现 'TypeScript' 一行。

# 4. NULL 坑验证：NOT IN 遇到 NULL
docker exec -i pg-blog psql -U blog -d blog <<'SQL'
  -- 反直觉：NULL 把整个 NOT IN 结果污染成 0 行
  SELECT 1 WHERE 1 NOT IN (2, 3, NULL);
  -- 同样语义换成 NOT EXISTS：返回 1 行（值 1 确实不在 {2,3,NULL} 里）
  SELECT 1 WHERE NOT EXISTS (
    SELECT v FROM (VALUES (2),(3),(NULL::int)) t(v) WHERE v = 1
  );
SQL
```

---

## ⚠️ 常见误区

- **LEFT JOIN 后过滤条件写到 WHERE**：会让 LEFT JOIN 退化成 INNER。要保留某边的条件就写到 `ON`。
- **`SELECT a, b, count(*) FROM ... GROUP BY a`**：MySQL 宽松模式让人养成的坏习惯，PG 直接报错。SELECT 的非聚合列必须在 GROUP BY 里。
- **WHERE 里写聚合函数**：执行顺序决定 WHERE 阶段聚合还不存在。涉及聚合的过滤一律走 HAVING。
- **`NOT IN (子查询)` 遇到 NULL**：整个结果集会"莫名其妙"变空。可空列上的反向匹配永远用 `NOT EXISTS`。
- **`SELECT *` + JOIN**：列冲突、多张大表 TEXT 列全拉回来，性能和可读性双输。**JOIN 永远显式选列**。
- **相关子查询当锤子用**：放在 SELECT 列里时是 O(N)·子查询，能改 JOIN+GROUP BY 就改。
- **`array_agg` 后看到 `{NULL}`**：LEFT JOIN 没匹配上的右边是 NULL，被聚合进数组了。加 `FILTER (WHERE ... IS NOT NULL)`。
- **GROUP BY 用列序号 `GROUP BY 1, 2`**：加列时一改全错。多敲几个字母换可维护性。
- **JOIN 不起别名**：列名冲突时报错或返回错误的列，review 还看不出来。**永远起别名**。
- **以为 JOIN 慢就反范式**：先用 EXPLAIN 看清楚再决定，多数情况是少了一个索引而已。

---

## ✅ 今日产出

- [ ] 能口述 INNER / LEFT / RIGHT / FULL 在"没匹配上时"各自的行为
- [ ] 能说清 `ON` 和 `WHERE` 在 LEFT JOIN 下的差异，并演示"误写 WHERE 导致退化"
- [ ] `queries/04_joins.sql / 05_aggregates.sql / 06_subqueries.sql` 全部写完并能跑通
- [ ] 完成加分练习里的 6 条业务查询，每条都过一遍 `EXPLAIN`
- [ ] 至少踩一次 `NOT IN` + NULL 的坑，并改写成 `NOT EXISTS`
- [ ] 提交到 GitHub，commit message 写明 "day 22 joins & subqueries"

---

## 📚 延伸阅读

- [PostgreSQL 官方文档 — Queries](https://www.postgresql.org/docs/current/queries.html)（JOIN 与子查询权威参考）
- [PostgreSQL 官方文档 — Aggregate Functions](https://www.postgresql.org/docs/current/functions-aggregate.html)
- [Modern SQL](https://modern-sql.com/)（讲解 SQL:1999 之后的现代特性，`FILTER`、`WITH`、`LATERAL` 都有）
- [Use The Index, Luke! — The Where Clause](https://use-the-index-luke.com/sql/where-clause)（理解 WHERE/JOIN 时索引是怎么用上的）
- [LeetCode Database](https://leetcode.com/problemset/database/)（按难度刷一刷找手感）
- [Don't Do This - PostgreSQL Wiki](https://wiki.postgresql.org/wiki/Don%27t_Do_This)

---

[⬅️ Day 21](../day-21/) | [➡️ Day 23](../day-23/)
