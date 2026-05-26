-- ============================================================================
-- 009 通知表（Day 24）
-- ----------------------------------------------------------------------------
-- 设计取舍：
--   * 单表 + type + JSONB payload，不为每种事件建表
--     - 查"用户最近通知"按 (recipient_id, created_at DESC) 一次扫
--     - 加新事件类型 = 加一个 type 字符串，不动 schema
--
--   * 不做强外键：payload 里可能引用 post_id / comment_id / from_user_id
--     - 这些引用的实体可能被删（用户注销、文章下架），通知里指向"已不存在的东西"
--       是正常业务（"alice 给你点过赞，现在她账号删了"）
--     - 真要做外键校验只能拆 type-specific 表，否定了这个设计的初衷
--     - 如果通知里需要展示对方姓名/标题，在 payload 里直接冗余存
--
--   * type 不做 ENUM 也不做 CHECK：
--     - 业务上 type 是开放集合，每加一种通知就要改 schema 不可接受
--     - 应用层 enum + 写入校验已经够了
--
--   * read_at 而不是 is_read：可以排序、做 "X 分钟内已读" 统计
-- ============================================================================

CREATE TABLE notifications (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(40)  NOT NULL,
  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  read_at      TIMESTAMPTZ,                     -- NULL = 未读
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- 索引
--   * 部分索引：未读通知按时间倒序（最常见的查询）
--     用户主页"小铃铛"角标永远查这个
--   * 全量索引：用户的全部通知（已读+未读）历史浏览
-- ----------------------------------------------------------------------------
CREATE INDEX idx_notifications_recipient_unread
  ON notifications(recipient_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX idx_notifications_recipient_all
  ON notifications(recipient_id, created_at DESC);

-- type 上的次级索引：管理后台按类型筛选时用
CREATE INDEX idx_notifications_type ON notifications(type);

COMMENT ON TABLE notifications IS '用户通知，异质事件统一表';
COMMENT ON COLUMN notifications.type IS
  '事件类型字符串：post_liked / comment_replied / followed 等，开放集合';
COMMENT ON COLUMN notifications.payload IS
  'JSONB 异质载荷；做轻度反范式（如 from_user_name）让列表页直出';
COMMENT ON COLUMN notifications.read_at IS
  '已读时间；NULL 表示未读；部分索引专门加速未读查询';
