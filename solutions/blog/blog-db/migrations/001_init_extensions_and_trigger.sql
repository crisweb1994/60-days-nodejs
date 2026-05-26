-- ============================================================================
-- 001 扩展与公共触发器函数
-- ----------------------------------------------------------------------------
-- gen_random_uuid() 在 PG 13+ 已内置（pgcrypto 提供）。
-- 这里显式 CREATE EXTENSION 是为了在更老的 PG 上也能跑通。
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 通用 updated_at 触发器函数：所有有 updated_at 列的表都复用
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
