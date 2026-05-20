-- ============================================================================
-- 003 文章表
-- ----------------------------------------------------------------------------
-- author_id ON DELETE RESTRICT：用户被删时强制要求先处理其文章，
--   不用 CASCADE 是为了避免"删一个用户瞬间消失几千篇文章"的事故。
-- published_at 单独一列且可空：为未来"定时发布"留出空间。
-- metadata 用 JSONB：放尚未结构化的扩展字段（封面、SEO 等）。
-- ============================================================================

CREATE TABLE posts (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id    UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slug         VARCHAR(120) NOT NULL UNIQUE,
  title        VARCHAR(200) NOT NULL,
  content      TEXT         NOT NULL,
  status       VARCHAR(20)  NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft', 'published', 'archived')),
  view_count   INTEGER      NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  metadata     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,
  deleted_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  -- 业务规则下沉：published 状态必须有 published_at
  CONSTRAINT posts_published_requires_timestamp
    CHECK (status <> 'published' OR published_at IS NOT NULL)
);

CREATE TRIGGER set_posts_updated_at
BEFORE UPDATE ON posts
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMENT ON TABLE posts IS '博客文章';
COMMENT ON COLUMN posts.deleted_at IS '软删除时间，NULL 代表未删除';
COMMENT ON COLUMN posts.metadata IS 'JSONB 扩展字段：cover_url、seo_description 等';
