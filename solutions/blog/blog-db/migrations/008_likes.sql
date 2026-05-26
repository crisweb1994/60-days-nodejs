-- ============================================================================
-- 008 点赞表 + posts.like_count 反范式列 + 同步触发器（Day 24）
-- ----------------------------------------------------------------------------
-- 设计取舍：
--   * N:M 中间表，复合主键 (user_id, post_id) 同时充当 UNIQUE 与索引
--     - 不需要独立 id BIGSERIAL 列
--     - 业务上"同一用户重复点赞"应静默成功（幂等），由应用层 ON CONFLICT DO NOTHING
--
--   * ON DELETE CASCADE 两边：
--     - 用户注销 → 他点过的赞全部消失（合规要求）
--     - 文章删除 → 关联点赞无意义
--
--   * posts.like_count 反范式：
--     - 读：列表页/详情页都要"赞数"，每次 count() 撑不住
--     - 写：触发器在 likes INSERT/DELETE 时 +1/-1
--     - 兜底：scripts/recount_likes.sh（定时跑，对账）
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 点赞表
-- ----------------------------------------------------------------------------
CREATE TABLE likes (
  user_id    UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id    UUID         NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- 反向查找：某文章被哪些用户点赞 → 默认通过 PK 走 (user_id, post_id)
--   反向查 (post_id) 单独索引
CREATE INDEX idx_likes_post ON likes(post_id);

COMMENT ON TABLE likes IS '用户点赞文章，N:M 关系；复合主键同时充当 UNIQUE';

-- ----------------------------------------------------------------------------
-- posts 表追加反范式计数列
--   - DEFAULT 0 让既有行自动初始化
--   - 加 CHECK >= 0 防止触发器写错把负数写进去
-- ----------------------------------------------------------------------------
ALTER TABLE posts
  ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0
    CHECK (like_count >= 0);

COMMENT ON COLUMN posts.like_count IS '反范式：缓存赞数，由 trg_likes_count 维护';

-- 既有 posts 行的 like_count 全是 0，跟还没插入的 likes 一致，不需要手动重算

-- ----------------------------------------------------------------------------
-- 同步触发器
--   * AFTER 而不是 BEFORE：likes 行真正落盘后再改计数
--   * 用 PERFORM 而不是 SELECT INTO：不需要返回值
--   * RETURN NULL：AFTER 触发器返回值会被忽略，写 NULL 表意更清楚
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION posts_like_count_sync() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_likes_count
AFTER INSERT OR DELETE ON likes
FOR EACH ROW EXECUTE FUNCTION posts_like_count_sync();

COMMENT ON FUNCTION posts_like_count_sync() IS
  '反范式同步：likes 写入时维护 posts.like_count';

-- ----------------------------------------------------------------------------
-- 对账视图（可选）：发现 like_count 漂移时人工修正
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_like_count_drift AS
SELECT
  p.id,
  p.title,
  p.like_count    AS cached,
  count(l.user_id) AS actual,
  p.like_count - count(l.user_id) AS drift
FROM posts p
LEFT JOIN likes l ON l.post_id = p.id
GROUP BY p.id, p.title, p.like_count
HAVING p.like_count <> count(l.user_id);

COMMENT ON VIEW v_like_count_drift IS
  '点赞计数漂移巡检：返回行说明缓存与真实不一致，跑 recount 修正';
