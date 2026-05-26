-- ============================================================================
-- 练习三：NULL 陷阱与 EXPLAIN 入门
-- ----------------------------------------------------------------------------
-- NULL 不是值是"未知"，所有比较操作返回的也是 NULL（不是 false）。
-- ============================================================================

-- 3.1 错误写法：永远返回空集
SELECT count(*) FROM posts WHERE published_at = NULL;

-- 正确写法
SELECT count(*) FROM posts WHERE published_at IS NULL;
SELECT count(*) FROM posts WHERE published_at IS NOT NULL;

-- 3.2 隐蔽的不等比较：!= 不会匹配 NULL 行
SELECT count(*) AS not_archived_buggy
FROM posts
WHERE status != 'archived';
-- 上面会漏掉 status IS NULL 的行——本表 status NOT NULL 所以没问题；
-- 但如果是 published_at != now() 这种就会丢数据。

-- 3.3 IS DISTINCT FROM：把 NULL 当作普通值参与比较
SELECT count(*) AS deleted_aware
FROM posts
WHERE deleted_at IS DISTINCT FROM NULL;
-- 等价于 deleted_at IS NOT NULL，但语义更显式

-- 3.4 COALESCE 给 NULL 兜底
SELECT slug,
       COALESCE(published_at, created_at) AS effective_time
FROM posts
ORDER BY effective_time DESC
LIMIT 5;

-- ============================================================================
-- 3.5 EXPLAIN：今天先认识两种节点
--     UNIQUE 索引上的等值查询应该走 "Index Scan"
--     全表过滤会走 "Seq Scan"
-- ============================================================================

-- 走 unique 索引（slug 是 UNIQUE）
EXPLAIN SELECT id, title FROM posts WHERE slug = 'hello-postgres';

-- 走顺序扫描（status 没有索引）
EXPLAIN SELECT count(*) FROM posts WHERE status = 'published';

-- 加上 ANALYZE 真实执行，看 actual time
EXPLAIN ANALYZE
SELECT id, title FROM posts WHERE slug = 'hello-postgres';

-- ⚠️ Day 23 会专门讲索引和 EXPLAIN，今天混个眼熟即可。
