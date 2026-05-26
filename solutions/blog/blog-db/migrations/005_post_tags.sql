-- ============================================================================
-- 005 文章-标签关联表（多对多）
-- ----------------------------------------------------------------------------
-- 复合主键 (post_id, tag_id) 同时充当 UNIQUE 与索引，
-- 不需要额外的 id BIGSERIAL 列。
--
-- ON DELETE CASCADE 在这里安全：关联记录依附于 post 和 tag 存在，
-- 父行没了关联也没意义。
-- ============================================================================

CREATE TABLE post_tags (
  post_id    UUID         NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id     UUID         NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (post_id, tag_id)
);

-- 反向查询索引：通过 tag 查 post 时走这个索引
CREATE INDEX idx_post_tags_tag_id ON post_tags(tag_id);

COMMENT ON TABLE post_tags IS '文章与标签的多对多关联';
