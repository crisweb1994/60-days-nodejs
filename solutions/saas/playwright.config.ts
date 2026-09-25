import { defineConfig, devices } from "@playwright/test";

// E2E 只保留关键用户旅程：注册 -> 建工作区 -> 建项目 -> 看板上建任务。
// 数量少、真浏览器、真后端，是对单元/集成测试的最后兜底，不是主要回归手段。
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3210",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "pnpm exec next dev -p 3210",
    url: "http://localhost:3210",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // 本地默认指向独立的 saas_e2e 库，避免污染开发数据；
      // CI 中沿用 job 提供的 DATABASE_URL / REDIS_URL。
      DATABASE_URL:
        process.env.DATABASE_URL ??
        "postgresql://saas:saas@localhost:5547/saas_e2e?schema=public",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6547/14",
      SESSION_SECRET:
        process.env.SESSION_SECRET ?? "e2e-session-secret-at-least-32-bytes",
    },
  },
});
