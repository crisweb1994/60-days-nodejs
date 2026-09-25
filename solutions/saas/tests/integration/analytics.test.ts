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

describe("analytics.overview", () => {
  it("统计口径：取消的任务不计入完成率的分母", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();

    // 三张任务：一张完成、一张取消、一张留在待整理。
    const done = await createTask(caller, workspaceSlug, projectKey, "Done");
    const cancelled = await createTask(caller, workspaceSlug, projectKey, "Cancelled");
    await createTask(caller, workspaceSlug, projectKey, "Still backlog");

    let version = done.version;
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
          number: done.number,
          expectedVersion: version,
          status,
        })
      ).task.version;
    }
    await caller.tasks.transition({
      workspaceSlug,
      projectKey,
      number: cancelled.number,
      expectedVersion: cancelled.version,
      status: TaskStatus.CANCELLED,
    });

    const overview = await caller.analytics.overview({ workspaceSlug });

    expect(overview.total).toBe(3);
    expect(overview.done).toBe(1);
    expect(overview.cancelled).toBe(1);
    expect(overview.backlog).toBe(1);
    // actionable = total - cancelled = 2，done 1 -> 50%
    expect(overview.completionRate).toBe(50);
  });

  it("非成员读取统计被拒绝", async () => {
    const { workspaceSlug } = await seedWorld();
    const anonymous = callerFor(null);
    const { user } = await anonymous.auth.register({
      email: `stats-${Date.now()}@test.local`,
      password: "password-123456",
    });

    const error = await callerFor(user)
      .analytics.overview({ workspaceSlug })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("FORBIDDEN");
  });

  it("projectProgress 按项目聚合，未指派的截止日期计入逾期", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();

    // 一张已过期未完成的任务 + 一张普通任务。
    const overdue = await createTask(caller, workspaceSlug, projectKey, "Overdue");
    await prisma.task.update({
      where: { id: overdue.id },
      data: { dueDate: new Date(Date.now() - 86_400_000) },
    });
    await createTask(caller, workspaceSlug, projectKey, "Normal");

    const progress = await caller.analytics.projectProgress({ workspaceSlug });

    expect(progress.projects).toHaveLength(1);
    expect(progress.projects[0]).toMatchObject({
      key: "ENG",
      total: 2,
      backlog: 2,
      overdue: 1,
      completionRate: 0,
    });
  });
});
