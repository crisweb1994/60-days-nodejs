-- ============================================================================
-- 练习七：EXPLAIN / EXPLAIN ANALYZE 实战
-- ----------------------------------------------------------------------------
-- 重点训练读计划的能力：
--   1. 分清 Seq Scan / Index Scan / Index Only Scan / Bitmap Heap Scan
--   2. 看懂 cost / rows / actual time / loops 各代表什么
--   3. 用 BUFFERS 看清楚谁在打硬盘、谁吃到缓存
--   4. 学会让"统计信息差太多"的查询变好（ANALYZE 表）
-- ----------------------------------------------------------------------------
-- 前置：建议先跑 scripts/seed.sh --large 灌入 10w 行数据，效果才明显
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 7.1 最简单的对比：UNIQUE 索引 vs 没索引
-- ----------------------------------------------------------------------------

-- slug 是 UNIQUE 自带索引 → Index Scan
EXPLAIN ANALYZE
SELECT id, title FROM posts WHERE slug = 'hello-postgres';

-- view_count 没单独索引 → Seq Scan
EXPLAIN ANALYZE
SELECT count(*) FROM posts WHERE view_count > 1000;

-- ----------------------------------------------------------------------------
-- 7.2 BUFFERS 选项：看清缓存命中
-- 同一条查询跑两次，第二次 shared read 应归零
-- ----------------------------------------------------------------------------

-- 第一次跑：可能有 shared read（首次从磁盘读）
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title FROM posts WHERE author_id = (
  SELECT id FROM users WHERE username = 'alice'
);

-- 第二次跑：应该全部 shared hit
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title FROM posts WHERE author_id = (
  SELECT id FROM users WHERE username = 'alice'
);

-- ----------------------------------------------------------------------------
-- 7.3 估算 vs 实际偏差 —— 统计信息过期的症状
-- ----------------------------------------------------------------------------

-- 故意制造统计过期：先删一批数据但不 ANALYZE
DELETE FROM post_tags WHERE post_id IN (
  SELECT id FROM posts ORDER BY created_at LIMIT 100
);

-- 看 estimated rows vs actual rows，差距明显
EXPLAIN ANALYZE
SELECT count(*) FROM post_tags;

-- 手动刷新统计
ANALYZE post_tags;

-- 再看，应趋近一致
EXPLAIN ANALYZE
SELECT count(*) FROM post_tags;

-- ----------------------------------------------------------------------------
-- 7.4 Bitmap Heap Scan：选择性中等时的折衷方案
--   当索引筛出来的行不少不多（占表 1%~20%）时，PG 会用 Bitmap：
--     1. 先扫索引把 ctid 收成 bitmap
--     2. 按 bitmap 顺序回 heap 取数据（顺序 I/O，比 Index Scan 的随机 I/O 友好）
-- ----------------------------------------------------------------------------
EXPLAIN ANALYZE
SELECT id, title FROM posts WHERE status = 'published';

-- ----------------------------------------------------------------------------
-- 7.5 Index Only Scan：完全不回 heap
-- ----------------------------------------------------------------------------

-- 临时建一个覆盖索引：把 title 通过 INCLUDE 塞进叶子节点
CREATE INDEX IF NOT EXISTS tmp_idx_posts_cover
  ON posts(status, published_at DESC) INCLUDE (title)
  WHERE deleted_at IS NULL;

ANALYZE posts;

-- 查询只取索引里的列 → Index Only Scan
EXPLAIN (ANALYZE, BUFFERS)
SELECT title FROM posts
WHERE status = 'published' AND deleted_at IS NULL
ORDER BY published_at DESC
LIMIT 10;
-- ★ 看 Heap Fetches: 应为 0 才是真的没回表
--   如果 Heap Fetches > 0，跑一次 VACUUM posts 后再试

-- ★ 反例：多取一个不在索引里的列 → 退化为 Index Scan
EXPLAIN (ANALYZE, BUFFERS)
SELECT title, content FROM posts
WHERE status = 'published' AND deleted_at IS NULL
ORDER BY published_at DESC
LIMIT 10;

-- 清理掉演示索引
DROP INDEX IF EXISTS tmp_idx_posts_cover;

-- ----------------------------------------------------------------------------
-- 7.6 JOIN 三种算法：手动关掉看效果
--   PG 允许关闭某种 join 类型，强制走另一种来对比
--   注意 set 只在当前 session 生效
-- ----------------------------------------------------------------------------

-- 默认让优化器选
EXPLAIN ANALYZE
SELECT u.username, count(p.id)
FROM users u
LEFT JOIN posts p ON p.author_id = u.id
GROUP BY u.username;

-- 强制 Nested Loop
SET enable_hashjoin = off;
SET enable_mergejoin = off;
EXPLAIN ANALYZE
SELECT u.username, count(p.id)
FROM users u
LEFT JOIN posts p ON p.author_id = u.id
GROUP BY u.username;

-- 恢复 + 强制 Merge Join
RESET enable_hashjoin;
RESET enable_mergejoin;
SET enable_nestloop = off;
SET enable_hashjoin = off;
EXPLAIN ANALYZE
SELECT u.username, count(p.id)
FROM users u
LEFT JOIN posts p ON p.author_id = u.id
GROUP BY u.username;

-- 全部恢复
RESET enable_nestloop;
RESET enable_hashjoin;
RESET enable_mergejoin;

-- ----------------------------------------------------------------------------
-- 7.7 大查询：Day 22 §16 "作者中心首屏"
--   建议先在没建任何 Day 23 索引的状态下跑一次，记下 Execution Time，
--   然后 apply migrations/006_indexes.sql，再跑，对比数量级
-- ----------------------------------------------------------------------------
EXPLAIN (ANALYZE, BUFFERS)
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
