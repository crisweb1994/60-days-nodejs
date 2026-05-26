-- ============================================================================
-- 练习八：索引的各种姿势 —— 建、用、踩坑
-- ----------------------------------------------------------------------------
-- 每个示例的套路都是：
--   1. 没索引时 EXPLAIN 一遍
--   2. 建索引 + ANALYZE 表
--   3. 再 EXPLAIN，对比
--   4. 故意写个走不到的版本，看反例
-- ----------------------------------------------------------------------------
-- 前置：scripts/seed.sh --large 之后效果最明显
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 8.1 联合索引最左匹配 —— 自己感受规则
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS tmp_idx_posts_author_status
  ON posts(author_id, status);
ANALYZE posts;

-- ✅ 走索引：完整最左前缀
EXPLAIN ANALYZE
SELECT * FROM posts
WHERE author_id = (SELECT id FROM users LIMIT 1) AND status = 'published';

-- ✅ 走索引：只用前缀第一列
EXPLAIN ANALYZE
SELECT * FROM posts
WHERE author_id = (SELECT id FROM users LIMIT 1);

-- ❌ 走不到索引：跳过 author_id
--   PG 11+ 有 "skip scan" 的有限场景能走到，但通常表现为 Seq Scan / Bitmap
EXPLAIN ANALYZE
SELECT * FROM posts WHERE status = 'published';

-- ⚠️ 范围之后的列不走索引：author_id 是范围扫，status 退化成 Filter
EXPLAIN ANALYZE
SELECT * FROM posts
WHERE author_id > '00000000-0000-0000-0000-000000000000' AND status = 'published';

DROP INDEX IF EXISTS tmp_idx_posts_author_status;

-- ----------------------------------------------------------------------------
-- 8.2 函数包列废索引 —— 一句话教训
-- ----------------------------------------------------------------------------

-- 假设业务里要 case-insensitive 查 email
-- ❌ 走不到 users(email) 的索引（即使有）
EXPLAIN ANALYZE
SELECT * FROM users WHERE lower(email) = 'alice@example.com';

-- ✅ 建表达式索引
CREATE INDEX IF NOT EXISTS tmp_idx_users_email_lower
  ON users(lower(email));
ANALYZE users;

EXPLAIN ANALYZE
SELECT * FROM users WHERE lower(email) = 'alice@example.com';

DROP INDEX IF EXISTS tmp_idx_users_email_lower;

-- ----------------------------------------------------------------------------
-- 8.3 隐式类型转换也是函数 —— 看 EXPLAIN 才发现
-- ----------------------------------------------------------------------------

-- 假设有个 INT 列，把它当字符串传会触发 cast。
-- view_count 是 INT，下面查询不会用到任何索引（即使有 view_count 索引）
EXPLAIN ANALYZE
SELECT * FROM posts WHERE view_count = '100';
-- ★ Filter: ((view_count)::text = '100'::text)  ← 注意 view_count 被 cast 了
-- 实际项目里更常见：UUID 列传字符串、DATE 列传 TIMESTAMP

-- ----------------------------------------------------------------------------
-- 8.4 LIKE：前缀走 / 后缀不走
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS tmp_idx_posts_title_pattern
  ON posts(title text_pattern_ops);
ANALYZE posts;

-- ✅ 前缀
EXPLAIN ANALYZE SELECT id, title FROM posts WHERE title LIKE 'Hello%';

-- ❌ 后缀 / 中缀：B-tree 无能为力
EXPLAIN ANALYZE SELECT id, title FROM posts WHERE title LIKE '%Postgres%';

-- 想搞中缀匹配，正经方案：pg_trgm + GIN
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX ... USING GIN (title gin_trgm_ops);
-- 此处不演示，自己感兴趣去试

DROP INDEX IF EXISTS tmp_idx_posts_title_pattern;

-- ----------------------------------------------------------------------------
-- 8.5 部分索引 —— 体积小 + 维护便宜
-- ----------------------------------------------------------------------------

-- 全表索引：包含 archived / draft 等几乎不会被时间线查的行
CREATE INDEX IF NOT EXISTS tmp_idx_posts_full
  ON posts(published_at DESC);

-- 部分索引：只包含 published + alive
CREATE INDEX IF NOT EXISTS tmp_idx_posts_partial
  ON posts(published_at DESC)
  WHERE status = 'published' AND deleted_at IS NULL;

-- 对比体积
SELECT pg_size_pretty(pg_relation_size('tmp_idx_posts_full'))    AS full_size,
       pg_size_pretty(pg_relation_size('tmp_idx_posts_partial')) AS partial_size;

-- ★ 关键：查询条件**必须包含**索引定义的 WHERE，PG 才会用部分索引
EXPLAIN ANALYZE
SELECT id, title FROM posts
WHERE status = 'published' AND deleted_at IS NULL
ORDER BY published_at DESC LIMIT 10;

-- ❌ 反例：查询条件不匹配部分索引 → 不走它
EXPLAIN ANALYZE
SELECT id, title FROM posts
ORDER BY published_at DESC LIMIT 10;

DROP INDEX IF EXISTS tmp_idx_posts_full;
DROP INDEX IF EXISTS tmp_idx_posts_partial;

-- ----------------------------------------------------------------------------
-- 8.6 JSONB + GIN：用 @> 包含查询
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS tmp_idx_posts_metadata
  ON posts USING GIN (metadata);
ANALYZE posts;

-- ✅ 包含查询走 GIN
EXPLAIN ANALYZE
SELECT id, title FROM posts
WHERE metadata @> '{"cover_url": "/img/pg.png"}';

-- ❌ 用 ->>+ 等值（不是 @>）走不了 GIN，要走表达式索引才行
EXPLAIN ANALYZE
SELECT id, title FROM posts
WHERE metadata->>'cover_url' = '/img/pg.png';

DROP INDEX IF EXISTS tmp_idx_posts_metadata;

-- ----------------------------------------------------------------------------
-- 8.7 索引体检 —— 找出从来没被用过的索引
-- ----------------------------------------------------------------------------

-- pg_stat_user_indexes 是累计统计，PG 重启或 pg_stat_reset() 后清零
SELECT
  schemaname,
  relname                          AS table_name,
  indexrelname                     AS index_name,
  idx_scan                         AS scans,
  pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE schemaname = 'public'
  AND indexrelname NOT LIKE '%_pkey'        -- 主键不在讨论范围
  AND indexrelname NOT LIKE '%_key'         -- UNIQUE 约束自带索引也保留
ORDER BY idx_scan ASC, pg_relation_size(indexrelid) DESC;

-- ★ idx_scan = 0 且没被业务用的索引可以考虑删
-- ★ 重启后这表会重置；生产判断"没用过"要至少观察 1~2 周

-- ----------------------------------------------------------------------------
-- 8.8 索引膨胀检查 —— 大量 UPDATE/DELETE 之后看
-- ----------------------------------------------------------------------------

SELECT
  pg_size_pretty(pg_relation_size('posts'))           AS table_size,
  pg_size_pretty(pg_indexes_size('posts'))            AS all_indexes_size,
  pg_size_pretty(pg_total_relation_size('posts'))     AS total_size;

-- 单个索引体积
SELECT
  indexrelname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
FROM pg_stat_user_indexes
WHERE relname = 'posts'
ORDER BY pg_relation_size(indexrelid) DESC;

-- 想重建（释放膨胀），生产用 CONCURRENTLY 不锁表：
-- REINDEX INDEX CONCURRENTLY idx_posts_author_status;
-- ★ 本地小数据量看不出效果，记住这个命令就行
