-- ============================================================================
-- 006 索引集合（Day 23）
-- ----------------------------------------------------------------------------
-- 原则：
--   * 主键、UNIQUE 约束自带索引，不重复建
--   * 外键列默认加索引（JOIN 反向查找的入口）
--   * 高频列表查询用部分索引，过滤掉死数据缩小体积
--   * 覆盖索引（INCLUDE）只在确认高频访问时加，避免索引膨胀
-- ============================================================================

-- ----------------------------------------------------------------------------
-- posts: author_id 是外键，几乎所有按作者维度查的接口都要走它
--   合并 status 进联合索引：(author_id, status) 覆盖 "某作者的某状态文章"
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_posts_author_status
  ON posts(author_id, status);

-- ----------------------------------------------------------------------------
-- posts: 首页 / 作者主页都按 published_at DESC 取最新
--   部分索引：只索引 published & 未删除的行，体积小 70%+
--   ORDER BY 用 DESC，匹配真实查询方向
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_posts_published_alive
  ON posts(published_at DESC)
  WHERE status = 'published' AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- posts: 作者主页"该作者最新一篇" / "该作者文章列表分页"
--   联合索引按 (author_id, published_at DESC)，前缀匹配 author_id 等值
--   同样加部分索引条件，复用度高
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_posts_author_published
  ON posts(author_id, published_at DESC)
  WHERE status = 'published' AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- posts: 软删除巡检 / 后台管理需要按 deleted_at 范围查
--   单独建一个轻量索引；列表接口走上面的部分索引就好
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_posts_deleted_at
  ON posts(deleted_at)
  WHERE deleted_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- posts.metadata: JSONB 字段，需要 "包含某 key/value" 查询
--   GIN 索引支持 @> 操作符，B-tree 在这里完全用不上
--   注意：GIN 写入比 B-tree 贵 ~3x，确认有这个查询模式再加
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_posts_metadata_gin
  ON posts USING GIN (metadata);

-- ----------------------------------------------------------------------------
-- tags: slug 已经 UNIQUE 自带索引；name 模糊搜索需要前缀匹配
--   用 text_pattern_ops 让 LIKE 'foo%' 能走索引
--   （默认的 collation 索引在某些 locale 下走不到 LIKE）
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_tags_name_pattern
  ON tags(name text_pattern_ops);

-- ----------------------------------------------------------------------------
-- users: email 在 schema 里是 UNIQUE，自带索引
--   登录场景需要忽略大小写匹配，建表达式索引
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_email_lower
  ON users(lower(email));

-- ----------------------------------------------------------------------------
-- post_tags: 反向 (tag_id, post_id) 在 005 已建 (tag_id)，够用了
--   不再追加，避免和 005 重复
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 强制刷新统计信息，避免刚建完索引优化器还在用旧统计
-- ----------------------------------------------------------------------------
ANALYZE users;
ANALYZE posts;
ANALYZE tags;
ANALYZE post_tags;

COMMENT ON INDEX idx_posts_author_status        IS '按作者 + 状态过滤（联合索引）';
COMMENT ON INDEX idx_posts_published_alive      IS '首页时间线（部分索引，仅 published & alive）';
COMMENT ON INDEX idx_posts_author_published     IS '作者主页时间线（部分索引）';
COMMENT ON INDEX idx_posts_deleted_at           IS '软删除巡检';
COMMENT ON INDEX idx_posts_metadata_gin         IS 'JSONB 包含查询 (@>)';
COMMENT ON INDEX idx_tags_name_pattern          IS '标签名前缀匹配 (LIKE foo%)';
COMMENT ON INDEX idx_users_email_lower          IS '忽略大小写的邮箱查找';
