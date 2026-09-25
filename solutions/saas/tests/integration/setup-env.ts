import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// env.ts 在模块加载时就校验 DATABASE_URL 等变量，晚于测试文件的 import 链设置就来不及了。
// 这个 setup 文件由 vitest 在集成测试开始前执行，把 .env.test 注入 process.env。
// setup 文件在 tests/integration/ 下，env 文件在项目根：向上退两级。
const envFile = fileURLToPath(new URL("../../.env.test", import.meta.url));

if (existsSync(envFile)) {
  const raw = readFileSync(envFile, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals === -1) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // 已存在的环境变量优先（CI 的 service container 变量不应被文件覆盖）。
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
} else if (!process.env.DATABASE_URL) {
  throw new Error(
    "集成测试需要数据库配置：先执行 `cp .env.test.example .env.test`，" +
      "或者在 CI 中直接提供 DATABASE_URL / REDIS_URL / SESSION_SECRET 环境变量。",
  );
}

// @types/node 把 NODE_ENV 标记为只读，绕过它只影响本次测试进程。
Object.assign(process.env, { NODE_ENV: "test" });
