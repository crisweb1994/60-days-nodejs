-- ============================================================================
-- 002 用户表
-- ----------------------------------------------------------------------------
-- password 列存的是 hash 值（Day 27 会接 bcrypt/argon2），永远不存明文。
-- role 用 VARCHAR + CHECK 而不是 ENUM，方便未来扩展角色。
-- ============================================================================

CREATE TABLE users (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email       VARCHAR(255) NOT NULL UNIQUE,
  username    VARCHAR(50)  NOT NULL UNIQUE,
  password    VARCHAR(255) NOT NULL,
  role        VARCHAR(20)  NOT NULL DEFAULT 'user'
                CHECK (role IN ('user', 'author', 'admin')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TRIGGER set_users_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

COMMENT ON TABLE users IS '博客系统用户';
COMMENT ON COLUMN users.password IS '密码 hash，永远不存明文';
COMMENT ON COLUMN users.role IS 'user/author/admin，CHECK 约束兜底';
