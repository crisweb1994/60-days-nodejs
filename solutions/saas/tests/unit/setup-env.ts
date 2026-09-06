// unit 项目不连数据库，但 session.ts 经由 env.ts 间接依赖环境变量校验。
// 提供已知取值的假变量：够过校验即可，密钥固定下来让测试可以自己签名令牌。
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unit:unit@localhost:5432/unit_placeholder",
  REDIS_URL: "redis://localhost:6379/15",
  SESSION_SECRET: "unit-test-session-secret-32-bytes!!",
});
