-- ============================================================================
-- 练习二：写操作与事务
-- ----------------------------------------------------------------------------
-- 关键点：
--   1. INSERT 一定带 RETURNING，省一次 SELECT
--   2. UPDATE/DELETE 一定带 WHERE，能加状态过滤就加（乐观锁）
--   3. 跨表写一定开事务
-- ============================================================================

-- 2.1 创建一篇带标签的文章（事务示例，最后 ROLLBACK，不污染数据）
BEGIN;

INSERT INTO posts (id, author_id, slug, title, content, status, published_at)
VALUES (
  'c0000000-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222222',
  'tx-demo', '事务里的多表写入',
  '一篇用于演示事务的临时文章。',
  'published',
  now()
)
RETURNING id, created_at;

INSERT INTO post_tags (post_id, tag_id)
SELECT 'c0000000-0000-0000-0000-000000000001', id
FROM tags
WHERE slug IN ('node-js', 'postgresql');

-- 验证插入成功
SELECT count(*) AS tag_count
FROM post_tags
WHERE post_id = 'c0000000-0000-0000-0000-000000000001';

ROLLBACK;  -- ★ 验证：上面所有改动都消失

-- 2.2 乐观锁式发布：只在 draft 状态时才能改成 published
--     返回零行 → 状态已变，应用层应当报 409
UPDATE posts
SET status = 'published', published_at = now()
WHERE slug = 'ts-utility-types'
  AND status = 'draft'
RETURNING id, slug, status, published_at;

-- 跑第二次：拿不到行，因为已经不是 draft 了
UPDATE posts
SET status = 'published', published_at = now()
WHERE slug = 'ts-utility-types'
  AND status = 'draft'
RETURNING id, slug, status;

-- 2.3 软删除：把"删除"改成 deleted_at 置位
UPDATE posts
SET deleted_at = now()
WHERE slug = 'old-rant-2019'
RETURNING id, slug, deleted_at;

-- 验证：列表查询永远要带 deleted_at IS NULL 过滤
SELECT count(*) FILTER (WHERE deleted_at IS NULL)  AS visible,
       count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted,
       count(*) AS total
FROM posts;

-- 2.4 还原（演示触发器是否覆盖 updated_at）
UPDATE posts
SET deleted_at = NULL
WHERE slug = 'old-rant-2019'
RETURNING slug, deleted_at, updated_at;
-- updated_at 应该比 created_at 新

-- 2.5 试着违反约束：观察数据库怎么挡你
--     先打开事务避免污染
BEGIN;
-- 违反 status CHECK
INSERT INTO posts (author_id, slug, title, content, status)
VALUES ('22222222-2222-2222-2222-222222222222', 'bad-status', 't', 'c', 'wtf');
-- 违反 published 必须带 published_at
INSERT INTO posts (author_id, slug, title, content, status)
VALUES ('22222222-2222-2222-2222-222222222222', 'no-time', 't', 'c', 'published');
-- 违反 FK：author 不存在
INSERT INTO posts (author_id, slug, title, content)
VALUES ('00000000-0000-0000-0000-000000000000', 'no-author', 't', 'c');
ROLLBACK;
