-- ============================================================================
-- 练习十一：点赞操作 + 反范式计数列同步
-- ----------------------------------------------------------------------------
-- 重点观察 trg_likes_count 触发器的工作：
--   INSERT likes → posts.like_count + 1
--   DELETE likes → posts.like_count - 1
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 11.1 当前状态：每篇文章 + 缓存赞数 + 真实赞数
-- ----------------------------------------------------------------------------
SELECT
  p.id, p.slug, p.like_count AS cached,
  count(l.user_id)            AS actual
FROM posts p
LEFT JOIN likes l ON l.post_id = p.id
GROUP BY p.id, p.slug, p.like_count
ORDER BY actual DESC;
-- ★ cached 和 actual 应完全一致

-- 或者直接用 008 创建的对账视图（漂移行才会出现）
SELECT * FROM v_like_count_drift;
-- ★ 期望：0 行

-- ----------------------------------------------------------------------------
-- 11.2 INSERT 触发器：bob 点赞 alice 的 ts-utility-types
-- ----------------------------------------------------------------------------
BEGIN;

-- 操作前
SELECT id, slug, like_count
FROM posts WHERE slug = 'ts-utility-types';

INSERT INTO likes (user_id, post_id) VALUES (
  '33333333-3333-3333-3333-333333333333',
  'b0000000-0000-0000-0000-000000000003'
);

-- 操作后：like_count 应该 +1
SELECT id, slug, like_count
FROM posts WHERE slug = 'ts-utility-types';

ROLLBACK;
-- ★ 触发器在事务内生效；ROLLBACK 会把 likes 和 like_count 一起回滚

-- ----------------------------------------------------------------------------
-- 11.3 幂等：重复点赞要静默成功而不是报错
--      用 ON CONFLICT DO NOTHING；触发器不会重复触发（因为没真插入）
-- ----------------------------------------------------------------------------
BEGIN;

SELECT count(*) AS likes_before FROM likes WHERE post_id = 'b0000000-0000-0000-0000-000000000001';
SELECT like_count AS cached_before FROM posts WHERE id = 'b0000000-0000-0000-0000-000000000001';

-- bob 已经点赞过 hello-postgres（见 seed），再点一次
INSERT INTO likes (user_id, post_id) VALUES (
  '33333333-3333-3333-3333-333333333333',
  'b0000000-0000-0000-0000-000000000001'
)
ON CONFLICT (user_id, post_id) DO NOTHING;

-- 应该没变化
SELECT count(*) AS likes_after  FROM likes WHERE post_id = 'b0000000-0000-0000-0000-000000000001';
SELECT like_count AS cached_after  FROM posts WHERE id = 'b0000000-0000-0000-0000-000000000001';

ROLLBACK;

-- ----------------------------------------------------------------------------
-- 11.4 DELETE 触发器：取消点赞
-- ----------------------------------------------------------------------------
BEGIN;

SELECT id, slug, like_count
FROM posts WHERE slug = 'hello-postgres';

DELETE FROM likes
WHERE user_id = '33333333-3333-3333-3333-333333333333'
  AND post_id = 'b0000000-0000-0000-0000-000000000001';

-- 应该 -1
SELECT id, slug, like_count
FROM posts WHERE slug = 'hello-postgres';

ROLLBACK;

-- ----------------------------------------------------------------------------
-- 11.5 触发器和事务的关系：ROLLBACK 后整个状态回滚
--      触发器是在同一个事务里跑的，rollback 一起回滚
-- ----------------------------------------------------------------------------
SELECT id, slug, like_count
FROM posts WHERE slug IN ('hello-postgres', 'ts-utility-types')
ORDER BY slug;
-- ★ 应该和最开始一样

-- ----------------------------------------------------------------------------
-- 11.6 故意制造漂移 —— 然后用对账修复
--      演示触发器不可靠时的兜底（实际只在历史数据迁移场景出现）
-- ----------------------------------------------------------------------------
BEGIN;

-- 故意手改一个 like_count（模拟某次写入路径绕过触发器）
UPDATE posts SET like_count = like_count + 999 WHERE slug = 'hello-postgres';

-- 对账视图应该报这一行
SELECT * FROM v_like_count_drift;

-- 修正：从 likes 重新计算
UPDATE posts p SET like_count = sub.cnt
FROM (SELECT post_id, count(*) AS cnt FROM likes GROUP BY post_id) sub
WHERE p.id = sub.post_id AND p.like_count <> sub.cnt;

-- 修正后对账视图应空
SELECT * FROM v_like_count_drift;

ROLLBACK;

-- ----------------------------------------------------------------------------
-- 11.7 谁点了谁的文章 —— N:M 查询的标准 JOIN
--      这是触发器解决不了的查询，必须 JOIN likes 表
-- ----------------------------------------------------------------------------
SELECT
  liker.username AS liker,
  author.username AS author,
  p.title,
  l.created_at AS liked_at
FROM likes l
INNER JOIN users liker  ON liker.id  = l.user_id
INNER JOIN posts p      ON p.id      = l.post_id
INNER JOIN users author ON author.id = p.author_id
ORDER BY l.created_at DESC;

-- ----------------------------------------------------------------------------
-- 11.8 用户的"我点过赞的文章"
-- ----------------------------------------------------------------------------
SELECT
  p.id, p.title, p.like_count, l.created_at AS liked_at
FROM likes l
INNER JOIN posts p ON p.id = l.post_id
WHERE l.user_id = '33333333-3333-3333-3333-333333333333'
  AND p.deleted_at IS NULL
ORDER BY l.created_at DESC;
