-- ============================================================================
-- 007 评论表（Day 24）
-- ----------------------------------------------------------------------------
-- 设计取舍：
--   * 邻接表（parent_id 指向父评论），日常默认方案
--     - 路径枚举：深度 > 3 路径太长；
--     - 嵌套集合：写性能差，每条新回复都要更新整棵子树
--
--   * 冗余 post_id 不靠 parent_id 递归找：
--     - 查"某文章的全部评论"只要 WHERE post_id = ?，O(1) 索引命中
--     - 递归推 post_id 要逐层 JOIN，性能差且代码复杂
--     - 代价：移动评论到别的文章要同步更新（业务上不该出现）
--
--   * ON DELETE 行为：
--     - post_id → CASCADE：文章删了评论也没意义，跟着删
--     - parent_id → SET NULL：父评论被删时，子回复变成顶层评论
--       （比 CASCADE 友好——不会把一整条对话连带炸掉）
--       (要 RESTRICT 的话，得先递归删完所有子才能删父，业务上太烦)
--     - author_id → RESTRICT：用户被删要先处理评论（合规要求）
--
--   * 软删除：deleted_at 标记，UI 展示 "[已删除]" 占位但保留树结构
--     - 物理删除会让子评论无父可挂；保留树结构是评论区基本要求
-- ============================================================================

CREATE TABLE comments (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID         NOT NULL REFERENCES posts(id)    ON DELETE CASCADE,
  parent_id   UUID                  REFERENCES comments(id) ON DELETE SET NULL,
  author_id   UUID         NOT NULL REFERENCES users(id)    ON DELETE RESTRICT,
  content     TEXT         NOT NULL,
  deleted_at  TIMESTAMPTZ,                 -- 软删：保留占位但内容不可见
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- 业务规则：不能回复自己（数据库层兜底，应用层应该早就拦了）
  CONSTRAINT comments_no_self_parent CHECK (id <> parent_id),

  -- 业务规则：未删除的评论 content 不能为空字符串
  --   软删后允许 content 仍保留原值，UI 自己判断 deleted_at 决定显示
  CONSTRAINT comments_content_non_empty
    CHECK (deleted_at IS NOT NULL OR length(trim(content)) > 0)
);

-- ----------------------------------------------------------------------------
-- 索引
--   * (post_id, created_at)：文章详情页按时间序拉评论
--   * (parent_id)：查"某评论的所有回复"
--   * (author_id, created_at DESC)：用户主页"我评论过的"
-- ----------------------------------------------------------------------------
CREATE INDEX idx_comments_post_created
  ON comments(post_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_comments_parent
  ON comments(parent_id)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX idx_comments_author_created
  ON comments(author_id, created_at DESC)
  WHERE deleted_at IS NULL;

-- updated_at 自动维护
CREATE TRIGGER set_comments_updated_at
BEFORE UPDATE ON comments
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMENT ON TABLE comments IS '文章评论，邻接表支持楼中楼';
COMMENT ON COLUMN comments.parent_id IS '父评论 id，NULL 表示顶层评论；父删后变 NULL（升为顶层）';
COMMENT ON COLUMN comments.deleted_at IS '软删除：UI 显示 [已删除] 但保留树结构';
