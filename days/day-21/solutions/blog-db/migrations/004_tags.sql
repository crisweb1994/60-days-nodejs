-- ============================================================================
-- 004 标签表
-- ----------------------------------------------------------------------------
-- 标签是弱实体，没有 updated_at；用户重命名标签的需求很少，
-- 真要做也是删旧建新。
-- ============================================================================

CREATE TABLE tags (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(50)  NOT NULL UNIQUE,
  slug        VARCHAR(50)  NOT NULL UNIQUE,
  description VARCHAR(200),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE tags IS '文章标签字典';
COMMENT ON COLUMN tags.slug IS 'URL 友好的标识符，例如 "node-js"';
