import { TaskStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  callerFor,
  createTask,
  prisma,
  resetDatabase,
  seedWorld,
  trpcCode,
} from "./test-utils";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("analytics 趋势与负载", () => {
  it("completionTrend 把今天完成的任务计入最后一天，并给出累计值", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const task = await createTask(caller, workspaceSlug, projectKey, "Will finish");

    let version = task.version;
    for (const status of [
      TaskStatus.TODO,
      TaskStatus.IN_PROGRESS,
      TaskStatus.IN_REVIEW,
      TaskStatus.DONE,
    ]) {
      version = (
        await caller.tasks.transition({
          workspaceSlug,
          projectKey,
          number: task.number,
          expectedVersion: version,
          status,
        })
      ).task.version;
    }

    const trend = await caller.analytics.completionTrend({
      workspaceSlug,
      days: 7,
    });
    expect(trend.days).toHaveLength(7);
    const today = trend.days.at(-1);
    expect(today?.completed).toBe(1);
    expect(today?.cumulative).toBe(1);
  });

  it("workload 返回全部成员，没有任务时计数为零", async () => {
    const { caller, workspaceSlug } = await seedWorld();

    const workload = await caller.analytics.workload({ workspaceSlug });
    expect(workload.members).toHaveLength(1);
    expect(workload.members[0]).toMatchObject({
      total: 0,
      done: 0,
      inProgress: 0,
      overdue: 0,
    });
  });
});

describe("projects 生命周期", () => {
  it("创建第二个项目后列表包含两者，删除后不可见但数据仍在", async () => {
    const { caller, workspaceSlug } = await seedWorld();

    await caller.projects.create({
      workspaceSlug,
      key: "OPS",
      name: "Operations",
    });

    const list = await caller.projects.list({ workspaceSlug });
    expect(list.projects.map((project) => project.key).sort()).toEqual([
      "ENG",
      "OPS",
    ]);

    await caller.projects.delete({ workspaceSlug, key: "OPS" });

    const afterDelete = await caller.projects.list({ workspaceSlug });
    expect(afterDelete.projects.map((project) => project.key)).toEqual(["ENG"]);

    const row = await prisma.project.findFirst({
      where: { key: "OPS" },
      select: { deletedAt: true },
    });
    expect(row?.deletedAt).not.toBeNull();
  });

  it("MEMBER 不能创建项目（需要 ADMIN）", async () => {
    const { workspaceSlug } = await seedWorld();
    const anonymous = callerFor(null);
    const { user } = await anonymous.auth.register({
      email: `proj-${Date.now()}@test.local`,
      password: "password-123456",
    });
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: workspaceSlug },
    });
    await prisma.membership.create({
      data: { userId: user.id, workspaceId: workspace.id, role: "MEMBER" },
    });

    const error = await callerFor(user)
      .projects.create({
        workspaceSlug,
        key: "MEM",
        name: "Member Project",
      })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("FORBIDDEN");
  });
});

describe("health", () => {
  it("health.ping 返回 ok 并确认数据库可连", async () => {
    const result = await callerFor(null).health.ping();

    expect(result.ok).toBe(true);
    expect(result.database).toBe("up");
  });
});
