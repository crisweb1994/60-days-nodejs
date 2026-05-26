-- ============================================================================
-- 练习五：聚合函数 / GROUP BY / HAVING / FILTER
-- ----------------------------------------------------------------------------
-- 重点：
--   1. count(*) / count(col) / count(DISTINCT col) 三者区别
--   2. SELECT 非聚合列必须在 GROUP BY 里（PG 严格执行）
--   3. WHERE 过滤行、HAVING 过滤组
--   4. FILTER 是条件聚合，比 CASE WHEN 干净
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 5.1 三种 count 的区别 —— 同一份数据出三个不同的数字
-- ----------------------------------------------------------------------------
SELECT
  count(*)                  AS total_rows,        -- 数"行"，跟列里有没有 NULL 无关
  count(published_at)       AS has_published_at,  -- 跳过 published_at IS NULL 的行
  count(DISTINCT author_id) AS unique_authors     -- author_id 去重后再数
FROM posts;

-- ----------------------------------------------------------------------------
-- 5.2 GROUP BY 基础：每种状态下的文章数 + 平均阅读
-- ----------------------------------------------------------------------------
SELECT
  status,
  count(*)              AS total,
  round(avg(view_count)) AS avg_views,  -- round 比 ::int 显式，不靠 cast 截断
  sum(view_count)        AS total_views,
  max(view_count)        AS max_views
FROM posts
WHERE deleted_at IS NULL
GROUP BY status
ORDER BY total DESC;

-- ----------------------------------------------------------------------------
-- 5.3 多列 GROUP BY：作者 × 状态
-- ----------------------------------------------------------------------------
SELECT
  u.username,
  p.status,
  count(*) AS cnt
FROM posts p
INNER JOIN users u ON u.id = p.author_id
WHERE p.deleted_at IS NULL
GROUP BY u.username, p.status
ORDER BY u.username, p.status;

-- ----------------------------------------------------------------------------
-- 5.4 HAVING：只看"已发布数 > 2"的作者
-- ----------------------------------------------------------------------------
SELECT
  u.username,
  count(*) AS published_count
FROM posts p
INNER JOIN users u ON u.id = p.author_id
WHERE p.status = 'published' AND p.deleted_at IS NULL
GROUP BY u.username
HAVING count(*) > 2
ORDER BY published_count DESC;

-- 对比反例：聚合函数不能写在 WHERE 里
-- SELECT u.username, count(*) FROM posts p JOIN users u ON u.id = p.author_id
-- WHERE count(*) > 2 GROUP BY u.username;
-- ERROR: aggregate functions are not allowed in WHERE

-- ----------------------------------------------------------------------------
-- 5.5 FILTER：一次出"总数 / 已发布 / 草稿 / 归档"四列
--     比 CASE WHEN 套在 sum 里干净得多，SQL:2003 标准
-- ----------------------------------------------------------------------------
SELECT
  u.username,
  count(*)                                           AS total,
  count(*) FILTER (WHERE p.status = 'published')     AS published,
  count(*) FILTER (WHERE p.status = 'draft')         AS draft,
  count(*) FILTER (WHERE p.status = 'archived')      AS archived,
  coalesce(sum(p.view_count)
           FILTER (WHERE p.status = 'published'), 0) AS published_views
FROM users u
LEFT JOIN posts p ON p.author_id = u.id AND p.deleted_at IS NULL
GROUP BY u.username
ORDER BY published_views DESC;

-- ----------------------------------------------------------------------------
-- 5.6 array_agg / string_agg：把分组里的多行收成一行
-- ----------------------------------------------------------------------------
SELECT
  u.username,
  count(*)                                            AS post_count,
  array_agg(p.title ORDER BY p.published_at DESC NULLS LAST) AS titles,
  string_agg(p.title, ' | ' ORDER BY p.published_at DESC NULLS LAST) AS titles_joined
FROM users u
INNER JOIN posts p ON p.author_id = u.id AND p.deleted_at IS NULL
GROUP BY u.username
ORDER BY post_count DESC;
-- 注意：INNER JOIN，没有任何文章的用户（admin）不会出现在结果里
-- 想包含 admin 改成 LEFT JOIN，并把 array_agg 加 FILTER (WHERE p.id IS NOT NULL)

-- ----------------------------------------------------------------------------
-- 5.7 jsonb_agg：拼接结构化结果，给 API 直出
-- ----------------------------------------------------------------------------
SELECT
  u.username,
  jsonb_agg(
    jsonb_build_object(
      'id',         p.id,
      'title',      p.title,
      'published_at', p.published_at
    )
    ORDER BY p.published_at DESC NULLS LAST
  ) AS posts
FROM users u
INNER JOIN posts p ON p.author_id = u.id AND p.status = 'published'
GROUP BY u.username;

-- ----------------------------------------------------------------------------
-- 5.8 GROUPING SETS：一次出多个维度的小计
--     等价于把 (GROUP BY status), (GROUP BY author_id), () 三个分组结果 UNION
-- ----------------------------------------------------------------------------
SELECT
  status,
  author_id,
  count(*) AS cnt
FROM posts
WHERE deleted_at IS NULL
GROUP BY GROUPING SETS ((status), (author_id), ())
ORDER BY status NULLS LAST, author_id NULLS LAST;

-- ----------------------------------------------------------------------------
-- 5.9 SQL 标准坑：count(LEFT JOIN 出来的 NULL 列)
--     count(*) 数行数（含没匹配的）；count(p.id) 只数非 NULL
-- ----------------------------------------------------------------------------
SELECT
  u.username,
  count(*)    AS rows_after_join,  -- 没文章的用户也算 1 行
  count(p.id) AS real_post_count   -- 没文章的用户 p.id 为 NULL，不计入
FROM users u
LEFT JOIN posts p ON p.author_id = u.id AND p.deleted_at IS NULL
GROUP BY u.username
ORDER BY u.username;
-- ★ 这是初学者最容易写错的地方。要"实际数量"永远 count(具体列)
