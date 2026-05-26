-- ============================================================================
-- 练习十：评论树的递归 CTE
-- ----------------------------------------------------------------------------
-- comments 表是邻接表（parent_id 指向父评论）。
-- 查"某文章的全部评论树"必须递归——SQL 标准的 WITH RECURSIVE。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 10.1 最朴素：平铺所有评论（含被软删的，但展示 [已删除] 占位）
--      不递归，先看看原始数据长啥样
-- ----------------------------------------------------------------------------
SELECT
  id, parent_id, author_id,
  CASE WHEN deleted_at IS NULL THEN content ELSE '[已删除]' END AS content,
  created_at
FROM comments
WHERE post_id = 'b0000000-0000-0000-0000-000000000001'
ORDER BY created_at;

-- ----------------------------------------------------------------------------
-- 10.2 递归 CTE：构造完整评论树，附带深度
--      锚成员：所有顶层评论（parent_id IS NULL）
--      递归成员：每次找上一层的所有子节点
-- ----------------------------------------------------------------------------
WITH RECURSIVE tree AS (
  -- 锚：顶层评论
  SELECT
    c.id, c.parent_id, c.author_id, c.content, c.deleted_at, c.created_at,
    0 AS depth,
    c.created_at::text AS sort_key,         -- 用文本拼前缀做整树排序键
    ARRAY[c.id]        AS path              -- 路径数组，便于后续展示祖先链
  FROM comments c
  WHERE c.post_id = 'b0000000-0000-0000-0000-000000000001'
    AND c.parent_id IS NULL

  UNION ALL

  -- 递归：找子
  SELECT
    c.id, c.parent_id, c.author_id, c.content, c.deleted_at, c.created_at,
    t.depth + 1,
    t.sort_key || '|' || c.created_at::text,  -- 子节点排序键 = 父排序键 + 自己时间
    t.path || c.id
  FROM comments c
  INNER JOIN tree t ON c.parent_id = t.id
  WHERE c.post_id = 'b0000000-0000-0000-0000-000000000001'
)
SELECT
  repeat('  ', depth) ||
  CASE WHEN deleted_at IS NULL THEN content ELSE '[已删除]' END AS thread,
  author_id,
  depth,
  array_length(path, 1) AS depth_check
FROM tree
ORDER BY sort_key;
-- ★ depth 列方便前端缩进
-- ★ sort_key 保证子节点紧跟在父节点之后，整棵树按时间嵌套展开
-- ★ path 数组可以拿来做"全祖先链"展示（"A → B → C → 当前"）

-- ----------------------------------------------------------------------------
-- 10.3 只取顶层 + 一层回复：评论区"折叠模式"
--      不递归，只查 depth 0 和 1，再多就"展开更多"按钮去加载
-- ----------------------------------------------------------------------------
SELECT
  c.id, c.parent_id, c.content, c.author_id, c.created_at,
  CASE WHEN c.parent_id IS NULL THEN 0 ELSE 1 END AS depth
FROM comments c
WHERE c.post_id = 'b0000000-0000-0000-0000-000000000001'
  AND c.deleted_at IS NULL
  AND (c.parent_id IS NULL
       OR c.parent_id IN (
         SELECT id FROM comments
         WHERE post_id = 'b0000000-0000-0000-0000-000000000001'
           AND parent_id IS NULL
       ))
ORDER BY
  COALESCE(c.parent_id, c.id),   -- 同一顶层评论聚拢
  c.created_at;

-- ----------------------------------------------------------------------------
-- 10.4 每条顶层评论的"回复数"
--      不只是直接回复，是整个子树（包括回复的回复）
--      用同样的递归 CTE 模板
-- ----------------------------------------------------------------------------
WITH RECURSIVE descendants AS (
  -- 锚：所有顶层评论自身（作为子树根）
  SELECT id AS root_id, id, parent_id
  FROM comments
  WHERE post_id = 'b0000000-0000-0000-0000-000000000001'
    AND parent_id IS NULL

  UNION ALL

  -- 递归找后代
  SELECT d.root_id, c.id, c.parent_id
  FROM comments c
  INNER JOIN descendants d ON c.parent_id = d.id
  WHERE c.post_id = 'b0000000-0000-0000-0000-000000000001'
)
SELECT
  c.id, c.content,
  -- -1 是减掉根自己
  count(d.id) - 1 AS descendant_count
FROM comments c
LEFT JOIN descendants d ON d.root_id = c.id
WHERE c.post_id = 'b0000000-0000-0000-0000-000000000001'
  AND c.parent_id IS NULL
GROUP BY c.id, c.content;

-- ----------------------------------------------------------------------------
-- 10.5 SET NULL 行为验证：删一条父评论，看子评论变化
-- ----------------------------------------------------------------------------

-- 删 c0...001（顶层），它的子 c0...002 应该 parent_id 变 NULL（升为顶层）
BEGIN;

SELECT id, parent_id, content
FROM comments
WHERE id IN ('c0000000-0000-0000-0000-000000000001',
             'c0000000-0000-0000-0000-000000000002');

DELETE FROM comments WHERE id = 'c0000000-0000-0000-0000-000000000001';

-- c0...002 的 parent_id 应该变 NULL
SELECT id, parent_id, content
FROM comments
WHERE id = 'c0000000-0000-0000-0000-000000000002';

ROLLBACK;
-- ★ ROLLBACK 让这次演示不污染数据，便于反复跑

-- ----------------------------------------------------------------------------
-- 10.6 EXPLAIN：递归 CTE 的执行计划
-- ----------------------------------------------------------------------------
EXPLAIN ANALYZE
WITH RECURSIVE tree AS (
  SELECT id, parent_id, content, 0 AS depth
  FROM comments
  WHERE post_id = 'b0000000-0000-0000-0000-000000000001'
    AND parent_id IS NULL
  UNION ALL
  SELECT c.id, c.parent_id, c.content, t.depth + 1
  FROM comments c
  INNER JOIN tree t ON c.parent_id = t.id
  WHERE c.post_id = 'b0000000-0000-0000-0000-000000000001'
)
SELECT * FROM tree;
-- ★ 关注 CTE Scan 节点；递归层数越多越贵
-- ★ 评论嵌套通常浅（< 5 层），实际 PG 跑得很快
