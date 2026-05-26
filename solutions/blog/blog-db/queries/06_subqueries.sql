-- ============================================================================
-- 练习六：子查询、EXISTS、CTE
-- ----------------------------------------------------------------------------
-- 核心选择优先级：
--   能 JOIN 就 JOIN > 存在性判断用 EXISTS > 派生统计用 CTE > 标量子查询少用
--   NOT IN 涉及可空列永远改 NOT EXISTS
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 6.1 标量子查询：每篇文章带上"全站平均阅读数"作参照
--     ★ 子查询只跑一次（非相关），外层多少行都不影响成本
-- ----------------------------------------------------------------------------
SELECT
  p.id,
  p.title,
  p.view_count,
  (SELECT round(avg(view_count))
     FROM posts
     WHERE status = 'published' AND deleted_at IS NULL) AS site_avg
FROM posts p
WHERE p.status = 'published' AND p.deleted_at IS NULL
ORDER BY p.view_count DESC;

-- ----------------------------------------------------------------------------
-- 6.2 阅读数 ≥ 全站均值的文章
-- ----------------------------------------------------------------------------
SELECT id, title, view_count
FROM posts
WHERE status = 'published'
  AND deleted_at IS NULL
  AND view_count >= (
    SELECT avg(view_count) FROM posts
    WHERE status = 'published' AND deleted_at IS NULL
  )
ORDER BY view_count DESC;

-- ----------------------------------------------------------------------------
-- 6.3 表子查询：把"每作者文章数"派生出来，再 JOIN 回 users
--     ★ 派生表必须起别名（AS x）
-- ----------------------------------------------------------------------------
SELECT u.username, x.cnt, x.views
FROM users u
INNER JOIN (
  SELECT author_id, count(*) AS cnt, sum(view_count) AS views
  FROM posts
  WHERE status = 'published' AND deleted_at IS NULL
  GROUP BY author_id
) x ON x.author_id = u.id
ORDER BY x.views DESC;

-- ----------------------------------------------------------------------------
-- 6.4 IN (子查询)：所有打过 'Node.js' 标签的文章
-- ----------------------------------------------------------------------------
SELECT id, title
FROM posts
WHERE id IN (
  SELECT pt.post_id
  FROM post_tags pt
  JOIN tags t ON t.id = pt.tag_id
  WHERE t.slug = 'node-js'
);

-- 等价 JOIN 写法（多数情况优化器会等价处理）
SELECT DISTINCT p.id, p.title
FROM posts p
INNER JOIN post_tags pt ON pt.post_id = p.id
INNER JOIN tags      t  ON t.id = pt.tag_id
WHERE t.slug = 'node-js';

-- ----------------------------------------------------------------------------
-- 6.5 EXISTS：从来没被任何文章引用过的标签（孤儿标签）
--     和 04 节的 LEFT JOIN ... IS NULL 等价，但意图更显式
-- ----------------------------------------------------------------------------
SELECT t.id, t.name, t.slug
FROM tags t
WHERE NOT EXISTS (
  SELECT 1 FROM post_tags pt WHERE pt.tag_id = t.id
);

-- ----------------------------------------------------------------------------
-- 6.6 NOT IN 的 NULL 陷阱演示
-- ----------------------------------------------------------------------------
-- 直觉上应该返回 1 行（因为 1 不等于 2、3、NULL）
SELECT 1 AS hit WHERE 1 NOT IN (2, 3, NULL);
-- 实际：返回 0 行。
-- 原因：1 != NULL 的结果是 NULL（不是 TRUE），整个 NOT IN 短路成 NULL
-- WHERE 过滤掉 NULL，结果为空

-- 改写成 NOT EXISTS 就符合直觉
SELECT 1 AS hit
WHERE NOT EXISTS (
  SELECT 1 FROM (VALUES (2), (3), (NULL::int)) AS v(x) WHERE v.x = 1
);

-- ----------------------------------------------------------------------------
-- 6.7 相关子查询：每篇文章的标签数（外层每行跑一次）
-- ----------------------------------------------------------------------------
SELECT
  p.id,
  p.title,
  (SELECT count(*) FROM post_tags pt WHERE pt.post_id = p.id) AS tag_count
FROM posts p
WHERE p.deleted_at IS NULL
ORDER BY tag_count DESC;

-- ★ 等价改写：LEFT JOIN + GROUP BY，一次扫描搞定，建议用这个
SELECT
  p.id,
  p.title,
  count(pt.tag_id) AS tag_count
FROM posts p
LEFT JOIN post_tags pt ON pt.post_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id
ORDER BY tag_count DESC;

-- ----------------------------------------------------------------------------
-- 6.8 CTE（WITH）：复杂查询拆步骤，可读性翻倍
--     作者中心：username + 已发布数 + 累计阅读 + 最新一篇标题
-- ----------------------------------------------------------------------------
WITH published AS (
  SELECT * FROM posts
  WHERE status = 'published' AND deleted_at IS NULL
),
author_stats AS (
  SELECT
    author_id,
    count(*)         AS total,
    sum(view_count)  AS views
  FROM published
  GROUP BY author_id
)
SELECT
  u.username,
  s.total,
  s.views,
  (SELECT title FROM published
     WHERE author_id = u.id
     ORDER BY published_at DESC LIMIT 1) AS latest_title
FROM author_stats s
INNER JOIN users u ON u.id = s.author_id
ORDER BY s.views DESC;

-- ----------------------------------------------------------------------------
-- 6.9 DISTINCT ON：每作者最热的一篇（PG 扩展，非标准）
--     ORDER BY 第一列必须和 DISTINCT ON 一致，第二列决定每组挑谁
-- ----------------------------------------------------------------------------
SELECT DISTINCT ON (author_id)
  author_id, id, title, view_count
FROM posts
WHERE status = 'published' AND deleted_at IS NULL
ORDER BY author_id, view_count DESC;

-- ----------------------------------------------------------------------------
-- 6.10 重复 slug 检测（HAVING 经典用法）
--     posts.slug 上有 UNIQUE 约束，正常应该返回 0 行
--     这条 SQL 是数据完整性巡检的模板：HAVING count(*) > 1 找重复
-- ----------------------------------------------------------------------------
SELECT slug, count(*) AS dup_count
FROM posts
GROUP BY slug
HAVING count(*) > 1;
