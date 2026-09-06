import { PrismaClient } from "@prisma/client";
import { TRPCError } from "@trpc/server";

import { appRouter } from "@/server/routers/_app";

// 集成测试直接用 createCaller 在进程内调用路由，绕过 HTTP 和 Next.js。
// 代价是 Cookie、CORS、fetch adapter 这些 HTTP 层行为不在覆盖范围内——
// 它们由 E2E 负责。换来的是每个用例毫秒级的执行和普通函数式的断言。
type TestUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export const prisma = new PrismaClient();

export function callerFor(user: TestUser | null) {
  return appRouter.createCaller({
    prisma,
    req: new Request("http://test.local"),
    resHeaders: new Headers(),
    user,
  });
}

// 断言错误码时统一从 TRPCError 取 code；把 error 当普通对象读属性在
// 重构成自定义 Error 类时会静默变成 undefined。
export function trpcCode(error: unknown): string | undefined {
  if (error instanceof TRPCError) {
    return error.code;
  }
  return undefined;
}

let sequence = 0;
export function uniqueEmail(prefix = "user"): string {
  sequence += 1;
  return `${prefix}-${Date.now()}-${sequence}@test.local`;
}

export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "_prisma_migrations");

  if (names.length === 0) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${names.map((name) => `"${name}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}

// 每个用例从一个干净的世界开始：注册用户 → 建工作区 → 建项目。
// 走真实路由而不是直接插库，这样测试同时也在验证“一个新用户能不能走通最小上手脚”。
export async function seedWorld(options?: {
  workspaceSlug?: string;
  projectKey?: string;
}) {
  const email = uniqueEmail();
  const anonymous = callerFor(null);
  const { user } = await anonymous.auth.register({
    email,
    password: "password-123456",
    name: "Seed Owner",
  });

  const caller = callerFor(user);
  const slug =
    options?.workspaceSlug ??
    `ws-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { workspace } = await caller.workspaces.create({
    name: "Seed Workspace",
    slug,
  });

  const projectKey = options?.projectKey ?? "ENG";
  await caller.projects.create({
    workspaceSlug: slug,
    key: projectKey,
    name: "Engineering",
  });

  return { user, caller, workspaceSlug: slug, projectKey, email };
}

export async function createTask(
  caller: ReturnType<typeof callerFor>,
  workspaceSlug: string,
  projectKey: string,
  title: string,
) {
  const { task } = await caller.tasks.create({
    workspaceSlug,
    projectKey,
    title,
  });
  return task;
}
