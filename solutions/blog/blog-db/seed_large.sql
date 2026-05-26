-- ============================================================================
-- seed_large.sql — 大数据 seed（Day 23 用）
-- ----------------------------------------------------------------------------
-- 在 seed.sql 已经灌入的小数据基础上，追加：
--   * +47 个虚拟作者（凑到 50 个用户）
--   * +99,990 篇文章（总数到 10w）
--   * +~30 万条 post_tags 关联
--
-- 这个量级才能看清 Seq Scan vs Index Scan 的实际差距。
-- 全部包在事务里，灌完 ANALYZE 一遍刷新统计。
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 补足用户：在已有 3 个的基础上追加到 50 个
-- ----------------------------------------------------------------------------
INSERT INTO users (email, username, password, role)
SELECT
  'user' || i || '@example.com',
  'user' || i,
  '$2b$10$fake.hash.bulk',
  CASE WHEN i % 10 = 0 THEN 'admin' ELSE 'author' END
FROM generate_series(1, 47) AS i;

-- ----------------------------------------------------------------------------
-- 批量插入 posts
--   * 50 个作者按 i % 50 均匀分配（用 ROW_NUMBER 做映射，避免 LATERAL 慢查）
--   * status 按 70% published / 20% draft / 10% archived 分布
--   * published 的 published_at 在过去 1 年内随机
--   * view_count 制造长尾（95% 是冷门 0~500，5% 是爆款 0~50000）
-- ----------------------------------------------------------------------------
WITH author_map AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS rn FROM users
)
INSERT INTO posts (author_id, slug, title, content, status, view_count, metadata, published_at)
SELECT
  a.id,
  'post-' || i,
  'Post #' || i || ' — ' || md5(i::text),
  'Body content for post ' || i || '. ' || repeat('lorem ipsum ', 5),
  CASE
    WHEN i % 10 = 0 THEN 'archived'
    WHEN i % 10 < 3 THEN 'draft'
    ELSE 'published'
  END,
  CASE WHEN random() < 0.95
       THEN (random() * 500)::int
       ELSE (random() * 50000)::int
  END,
  CASE WHEN i % 7 = 0
       THEN jsonb_build_object('cover_url', '/img/cover' || (i % 20) || '.png')
       ELSE '{}'::jsonb
  END,
  CASE
    WHEN i % 10 = 0 OR i % 10 < 3 THEN NULL
    ELSE now() - (random() * interval '365 days')
  END
FROM generate_series(1, 99990) AS i
INNER JOIN author_map a ON a.rn = i % 50;

-- ----------------------------------------------------------------------------
-- post_tags：前 9w 篇文章每篇随机打 1~5 个标签
--   * 剩下 1w 篇故意不打，作为 LEFT JOIN 没匹配的对照
--   * 用 generate_series 展开标签数，避免 LATERAL ORDER BY random() 的多次排序
-- ----------------------------------------------------------------------------
INSERT INTO post_tags (post_id, tag_id)
SELECT DISTINCT p.id, t.id
FROM (
  SELECT id, (1 + (random() * 4)::int) AS tag_count
  FROM posts
  ORDER BY created_at
  LIMIT 90000
) AS p
CROSS JOIN LATERAL (
  SELECT id FROM tags ORDER BY random() LIMIT p.tag_count
) AS t
ON CONFLICT (post_id, tag_id) DO NOTHING;

COMMIT;

-- ----------------------------------------------------------------------------
-- 关键：刷新统计，否则优化器还在用旧的小数据估算
-- ----------------------------------------------------------------------------
ANALYZE users;
ANALYZE posts;
ANALYZE tags;
ANALYZE post_tags;

-- ----------------------------------------------------------------------------
-- 自检
-- ----------------------------------------------------------------------------
SELECT 'users'      AS table_name, count(*) FROM users
UNION ALL SELECT 'posts',     count(*) FROM posts
UNION ALL SELECT 'tags',      count(*) FROM tags
UNION ALL SELECT 'post_tags', count(*) FROM post_tags;
-- 期望：users 50 / posts 100000 / tags 5 / post_tags 在 9w~45w 之间（随机）

-- 表与索引体积
SELECT
  relname,
  pg_size_pretty(pg_relation_size(oid))             AS table_size,
  pg_size_pretty(pg_indexes_size(oid))              AS indexes_size,
  pg_size_pretty(pg_total_relation_size(oid))       AS total_size
FROM pg_class
WHERE relname IN ('users', 'posts', 'tags', 'post_tags')
  AND relkind = 'r'
ORDER BY pg_total_relation_size(oid) DESC;
