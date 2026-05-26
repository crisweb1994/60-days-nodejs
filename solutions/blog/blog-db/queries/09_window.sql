-- ============================================================================
-- 练习九：窗口函数
-- ----------------------------------------------------------------------------
-- 窗口 vs 聚合的本质区别：
--   * 聚合（GROUP BY）：把多行折叠成一行
--   * 窗口（OVER）：保留所有行，每行附上"同组的某个统计值"
-- ----------------------------------------------------------------------------
-- 语法骨架：
--   func(...) OVER ([PARTITION BY ...] [ORDER BY ...] [frame])
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 9.1 最小例：每篇文章带上"该作者总文章数"
--   不折叠行：10 篇文章就出 10 行
-- ----------------------------------------------------------------------------
SELECT
  id, title, author_id,
  count(*) OVER (PARTITION BY author_id) AS author_total
FROM posts
WHERE deleted_at IS NULL
ORDER BY author_id;

-- ----------------------------------------------------------------------------
-- 9.2 ROW_NUMBER / RANK / DENSE_RANK 对比
--   构造一组带并列的数据看清三者区别
-- ----------------------------------------------------------------------------
WITH demo AS (
  SELECT * FROM (VALUES
    (100), (100), (80), (60), (60), (40)
  ) AS t(score)
)
SELECT
  score,
  ROW_NUMBER() OVER (ORDER BY score DESC) AS rn,
  RANK()       OVER (ORDER BY score DESC) AS rk,
  DENSE_RANK() OVER (ORDER BY score DESC) AS drk
FROM demo;
-- 预期：
--   100 → rn=1 rk=1 drk=1
--   100 → rn=2 rk=1 drk=1
--    80 → rn=3 rk=3 drk=2  ← RANK 跳号、DENSE_RANK 不跳
--    60 → rn=4 rk=4 drk=3
--    60 → rn=5 rk=4 drk=3
--    40 → rn=6 rk=6 drk=4

-- ----------------------------------------------------------------------------
-- 9.3 经典场景：每作者最热的一篇（TOP 1 per group）
--   外层 WHERE rn = 1 是标准套路
-- ----------------------------------------------------------------------------
SELECT id, title, author_id, view_count
FROM (
  SELECT
    id, title, author_id, view_count,
    ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY view_count DESC) AS rn
  FROM posts
  WHERE status = 'published' AND deleted_at IS NULL
) t
WHERE t.rn = 1;

-- 等价 PG 扩展写法 —— 更简洁但不可移植
SELECT DISTINCT ON (author_id) id, title, author_id, view_count
FROM posts
WHERE status = 'published' AND deleted_at IS NULL
ORDER BY author_id, view_count DESC;

-- ----------------------------------------------------------------------------
-- 9.4 TOP N per group：每作者最热的 3 篇
--   把 WHERE rn = 1 改成 WHERE rn <= 3
-- ----------------------------------------------------------------------------
SELECT id, title, author_id, view_count, rn
FROM (
  SELECT
    id, title, author_id, view_count,
    ROW_NUMBER() OVER (PARTITION BY author_id ORDER BY view_count DESC) AS rn
  FROM posts
  WHERE status = 'published' AND deleted_at IS NULL
) t
WHERE t.rn <= 3
ORDER BY author_id, rn;

-- ----------------------------------------------------------------------------
-- 9.5 LAG / LEAD：取相邻行做对比
--   每篇文章 + 上一篇的阅读数 + 增长量
-- ----------------------------------------------------------------------------
SELECT
  id, title, view_count, published_at,
  LAG(view_count)  OVER (ORDER BY published_at) AS prev_views,
  LEAD(view_count) OVER (ORDER BY published_at) AS next_views,
  view_count - LAG(view_count, 1, 0) OVER (ORDER BY published_at) AS delta_from_prev
FROM posts
WHERE status = 'published'
ORDER BY published_at;
-- ★ LAG(col, n, default)：取前 n 行；没有则 default

-- 按作者分组的 LAG：每个作者内部前后对比
SELECT
  author_id, id, title, view_count, published_at,
  LAG(view_count) OVER (PARTITION BY author_id ORDER BY published_at) AS prev_in_author
FROM posts
WHERE status = 'published'
ORDER BY author_id, published_at;

-- ----------------------------------------------------------------------------
-- 9.6 累计与移动窗口（frame）
-- ----------------------------------------------------------------------------

-- 累计阅读数（按发布时间）
SELECT
  id, title, view_count, published_at,
  SUM(view_count) OVER (
    ORDER BY published_at
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_total
FROM posts
WHERE status = 'published'
ORDER BY published_at;

-- 最近 3 篇文章的移动平均阅读数
SELECT
  id, title, view_count, published_at,
  AVG(view_count) OVER (
    ORDER BY published_at
    ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
  )::int AS moving_avg_3
FROM posts
WHERE status = 'published'
ORDER BY published_at;

-- ★ 不写 frame 时的坑：默认是 RANGE，遇到 ORDER BY 列并列会一起算
-- 下面这个查询：如果两篇文章 published_at 完全相同，cumulative 会把它们当作"同一帧"
SELECT
  id, view_count,
  SUM(view_count) OVER (ORDER BY published_at) AS cum_no_frame  -- 默认 RANGE
FROM posts
WHERE status = 'published';

-- ----------------------------------------------------------------------------
-- 9.7 NTILE：分桶
--   把所有 published 文章按阅读数分 4 桶（四分位）
-- ----------------------------------------------------------------------------
SELECT
  id, title, view_count,
  NTILE(4) OVER (ORDER BY view_count DESC) AS quartile
FROM posts
WHERE status = 'published'
ORDER BY view_count DESC;

-- ----------------------------------------------------------------------------
-- 9.8 FIRST_VALUE / LAST_VALUE / NTH_VALUE
--   每行带上"该作者第一篇文章的标题"
-- ----------------------------------------------------------------------------
SELECT
  author_id, id, title, published_at,
  FIRST_VALUE(title) OVER (
    PARTITION BY author_id ORDER BY published_at
  ) AS first_post_of_author
FROM posts
WHERE status = 'published'
ORDER BY author_id, published_at;

-- ★ LAST_VALUE 的坑：默认 frame 是 RANGE UNBOUNDED PRECEDING AND CURRENT ROW
--   所以 LAST_VALUE 在不显式写 frame 时返回的是 "当前行"！
--   想要真正的"最后一篇"，必须显式扩展 frame
SELECT
  author_id, id, title, published_at,
  LAST_VALUE(title) OVER (
    PARTITION BY author_id ORDER BY published_at
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  ) AS last_post_of_author
FROM posts
WHERE status = 'published'
ORDER BY author_id, published_at;

-- ----------------------------------------------------------------------------
-- 9.9 命名窗口：WINDOW 子句让多个聚合复用同一个窗口定义
-- ----------------------------------------------------------------------------
SELECT
  id, title, author_id, view_count,
  ROW_NUMBER() OVER w AS rn,
  RANK()       OVER w AS rk,
  view_count - AVG(view_count) OVER w AS diff_from_author_avg
FROM posts
WHERE status = 'published'
WINDOW w AS (PARTITION BY author_id ORDER BY view_count DESC)
ORDER BY author_id, rn;

-- ----------------------------------------------------------------------------
-- 9.10 窗口 vs 聚合 vs 子查询：完成同一需求"每篇文章 + 全站平均阅读"
-- ----------------------------------------------------------------------------

-- 子查询版（Day 22 的写法）
EXPLAIN ANALYZE
SELECT
  id, title, view_count,
  (SELECT round(avg(view_count)) FROM posts WHERE status = 'published') AS site_avg
FROM posts
WHERE status = 'published';

-- 窗口函数版：一次扫描搞定
EXPLAIN ANALYZE
SELECT
  id, title, view_count,
  round(AVG(view_count) OVER ())::int AS site_avg
FROM posts
WHERE status = 'published';
-- ★ 数据量大时窗口版可能更快（少一次扫描）
-- ★ 但子查询版在标量缓存命中后也很快——量级差异要看具体场景，自己 EXPLAIN
