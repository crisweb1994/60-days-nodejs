import path from "node:path";
import { defineConfig } from "vitest/config";

// 子 project 不继承根级 resolve 配置，alias 在每个 project 里声明一次。
const alias = { "@": path.resolve(__dirname, "src") };

export default defineConfig({
  test: {
    // 文件级并行在 3.2 的 projects 配置里按 project 生效不可靠（实测会并发），
    // 根级声明保证集成测试文件串行：它们共享同一个 saas_test 库，
    // 并发时两个文件的 beforeEach 会在同一张表上互相 TRUNCATE，产生死锁。
    fileParallelism: false,
    // 覆盖率只统计 src/server：组件层的逻辑薄，
    // 为了数字去补组件测试会本末倒置（详见 Day 56 README 的讨论）。
    coverage: {
      provider: "v8",
      include: ["src/server/**"],
      exclude: [
        "src/server/routers/_app.ts",
        "src/server/notifications/mail-worker.ts",
      ],
      reporter: ["text", "html"],
    },
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/unit/setup-env.ts"],
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/integration/setup-env.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
