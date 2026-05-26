-- ============================================================================
-- 练习一：CRUD 基本功
-- ----------------------------------------------------------------------------
-- 在 psql 里逐条执行，体会语义。能预测结果再回车，不要"跑了看"。
-- ============================================================================

-- 1.1 已发布文章，按发布时间倒序取前 5
SELECT id, slug, title, view_count, published_at
FROM posts
WHERE status = 'published' AND deleted_at IS NULL
ORDER BY published_at DESC
LIMIT 5;

-- 1.2 view_count 超过 100 的文章数量
SELECT count(*) AS hot_posts
FROM posts
WHERE status = 'published' AND view_count > 100;

-- 1.3 单作者文章统计
SELECT author_id, count(*) AS total, sum(view_count) AS total_views
FROM posts
WHERE status = 'published'
GROUP BY author_id
ORDER BY total_views DESC;

-- 1.4 通过 metadata JSONB 字段过滤：找出带封面的文章
SELECT id, slug, metadata ->> 'cover_url' AS cover_url
FROM posts
WHERE metadata ? 'cover_url';

-- 1.5 关键字搜索（明天会换成全文检索，今天先用 ILIKE）
SELECT id, slug, title
FROM posts
WHERE title ILIKE '%nest%' OR content ILIKE '%nest%';
