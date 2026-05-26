-- ============================================================================
-- 练习四：JOIN 全家桶
-- ----------------------------------------------------------------------------
-- 在 psql 里逐条执行，先预测结果集大小再回车。
-- 重点体会：INNER vs LEFT 的行数差异、ON vs WHERE 的语义差异。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 4.1 INNER JOIN：文章 + 作者
--     已发布文章 + 作者用户名。author 不存在的文章不会出现（schema 上不会发生）。
-- ----------------------------------------------------------------------------
SELECT p.id, p.title, u.username AS author
FROM posts p
INNER JOIN users u ON u.id = p.author_id
WHERE p.status = 'published' AND p.deleted_at IS NULL
ORDER BY p.published_at DESC;

-- ----------------------------------------------------------------------------
-- 4.2 LEFT JOIN：每个用户和他的"已发布文章数"
--     ★ 关键：admin 没发过文章，但要在结果里出现，count 为 0
-- ----------------------------------------------------------------------------

-- ❌ 反例：过滤条件放 WHERE，LEFT JOIN 退化成 INNER，admin 消失
SELECT u.username, count(p.id) AS published_count
FROM users u
LEFT JOIN posts p ON p.author_id = u.id
WHERE p.status = 'published'      -- 在 WHERE 里
GROUP BY u.username
ORDER BY published_count DESC;

-- ✅ 正解：过滤条件挪到 ON
SELECT u.username, count(p.id) AS published_count
FROM users u
LEFT JOIN posts p ON p.author_id = u.id
                  AND p.status = 'published'
                  AND p.deleted_at IS NULL
GROUP BY u.username
ORDER BY published_count DESC;

-- ----------------------------------------------------------------------------
-- 4.3 LEFT JOIN 多表：文章 + 它的所有标签（行展开版）
--     一篇文章有 N 个标签就出 N 行；没标签的文章出 1 行（tag_name 为 NULL）
-- ----------------------------------------------------------------------------
SELECT p.id, p.title, t.name AS tag_name
FROM posts p
LEFT JOIN post_tags pt ON pt.post_id = p.id
LEFT JOIN tags      t  ON t.id = pt.tag_id
WHERE p.deleted_at IS NULL
ORDER BY p.title, t.name;

-- ----------------------------------------------------------------------------
-- 4.4 LEFT JOIN + array_agg：每篇文章一行，标签收成数组
--     ★ 注意 FILTER (WHERE ... IS NOT NULL)，否则没标签的文章会得到 {NULL}
-- ----------------------------------------------------------------------------
SELECT
  p.id,
  p.title,
  p.status,
  array_agg(t.name ORDER BY t.name)
    FILTER (WHERE t.id IS NOT NULL) AS tags
FROM posts p
LEFT JOIN post_tags pt ON pt.post_id = p.id
LEFT JOIN tags      t  ON t.id = pt.tag_id
WHERE p.deleted_at IS NULL
GROUP BY p.id
ORDER BY p.created_at DESC;

-- ----------------------------------------------------------------------------
-- 4.5 反连接（anti-join）：孤儿标签 —— 从未被任何文章引用过
--     用 LEFT JOIN ... IS NULL 实现；下一节会展示 NOT EXISTS 等价写法
-- ----------------------------------------------------------------------------
SELECT t.id, t.name, t.slug
FROM tags t
LEFT JOIN post_tags pt ON pt.tag_id = t.id
WHERE pt.tag_id IS NULL;

-- ----------------------------------------------------------------------------
-- 4.6 自连接：找出和 'hello-postgres' 共享标签的其他文章
--     起两个别名 p1 / p2，避免引用歧义；p2.id <> p1.id 排除自己
-- ----------------------------------------------------------------------------
SELECT DISTINCT p2.id, p2.title
FROM posts p1
INNER JOIN post_tags pt1 ON pt1.post_id = p1.id
INNER JOIN post_tags pt2 ON pt2.tag_id = pt1.tag_id
                        AND pt2.post_id <> p1.id
INNER JOIN posts p2      ON p2.id = pt2.post_id
WHERE p1.slug = 'hello-postgres';

-- ----------------------------------------------------------------------------
-- 4.7 多 JOIN 综合：文章列表页需要的完整字段
--     文章基本信息 + 作者 + 标签数组，按发布时间倒序分页
-- ----------------------------------------------------------------------------
SELECT
  p.id,
  p.slug,
  p.title,
  p.published_at,
  u.username AS author,
  array_agg(t.name ORDER BY t.name)
    FILTER (WHERE t.id IS NOT NULL) AS tags
FROM posts p
INNER JOIN users u ON u.id = p.author_id
LEFT  JOIN post_tags pt ON pt.post_id = p.id
LEFT  JOIN tags      t  ON t.id = pt.tag_id
WHERE p.status = 'published' AND p.deleted_at IS NULL
GROUP BY p.id, u.username
ORDER BY p.published_at DESC
LIMIT 10 OFFSET 0;
-- 翻第二页改成 LIMIT 10 OFFSET 10；OFFSET 在大表上性能差，未来用 keyset pagination 替换

-- ----------------------------------------------------------------------------
-- 4.8 USING 简写：当两边列名相同
--     PG 支持 JOIN ... USING(col)，列在结果里只出现一次。
--     ★ 实际项目里少用——一旦列名不同步就 silent fail，建议永远写 ON。
-- ----------------------------------------------------------------------------
-- SELECT * FROM post_tags JOIN posts USING (post_id);    -- 反面教材：post_tags 没有叫 post_id 的列与 posts 同名
-- 真要演示请构造同名列，不在此污染。
