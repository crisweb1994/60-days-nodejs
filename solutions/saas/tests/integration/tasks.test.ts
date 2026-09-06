import { Role, TaskStatus } from "@prisma/client";
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

describe("tasks.create", () => {
  it("任务编号从 1 开始且在同一项目内严格递增", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();

    const first = await createTask(caller, workspaceSlug, projectKey, "A");
    const second = await createTask(caller, workspaceSlug, projectKey, "B");
    const third = await createTask(caller, workspaceSlug, projectKey, "C");

    expect([first.number, second.number, third.number]).toEqual([1, 2, 3]);
    expect(`${projectKey}-${third.number}`).toBe("ENG-3");
  });

  it("VIEWER 不能创建任务", async () => {
    const { workspaceSlug, projectKey } = await seedWorld();
    const anonymous = callerFor(null);
    const { user: viewerUser } = await anonymous.auth.register({
      email: `viewer-${Date.now()}@test.local`,
      password: "password-123456",
    });

    // 种子世界走 OWNER；把新用户以 VIEWER 身份加进来后再尝试写入。
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: workspaceSlug },
    });
    await prisma.membership.create({
      data: {
        userId: viewerUser.id,
        workspaceId: workspace.id,
        role: Role.VIEWER,
      },
    });

    const error = await callerFor(viewerUser)
      .tasks.create({ workspaceSlug, projectKey, title: "should fail" })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("FORBIDDEN");
  });

  it("非成员对不存在的项目写入得到 FORBIDDEN 而不是 NOT_FOUND", async () => {
    const { workspaceSlug } = await seedWorld();
    const outsider = callerFor(null);
    const { user } = await outsider.auth.register({
      email: `outsider-${Date.now()}@test.local`,
      password: "password-123456",
    });

    const error = await callerFor(user)
      .tasks.create({
        workspaceSlug,
        projectKey: "ENG",
        title: "should fail",
      })
      .catch((error: unknown) => error);

    // 会员校验先于项目查找：不泄露“这个工作区里有没有这个项目”。
    expect(trpcCode(error)).toBe("FORBIDDEN");
  });
});

describe("tasks.transition（状态机 + 乐观锁）", () => {
  it("合法路径 BACKLOG -> TODO -> IN_PROGRESS -> IN_REVIEW -> DONE 全程可走", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const task = await createTask(caller, workspaceSlug, projectKey, "Flow");

    const path = [
      TaskStatus.TODO,
      TaskStatus.IN_PROGRESS,
      TaskStatus.IN_REVIEW,
      TaskStatus.DONE,
    ];
    let version = task.version;
    for (const status of path) {
      const result = await caller.tasks.transition({
        workspaceSlug,
        projectKey,
        number: task.number,
        expectedVersion: version,
        status,
      });
      expect(result.task.status).toBe(status);
      version = result.task.version;
    }

    // 完成时间只在进入 DONE 时写入。
    const done = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(done.completedAt).not.toBeNull();
  });

  it("DONE 直接到 TODO 被状态机拒绝", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const task = await createTask(
      caller,
      workspaceSlug,
      projectKey,
      "Done task",
    );

    // BACKLOG -> IN_REVIEW 也是非法路径，先验证不会误放行。
    const skip = await caller.tasks
      .transition({
        workspaceSlug,
        projectKey,
        number: task.number,
        expectedVersion: task.version,
        status: TaskStatus.IN_REVIEW,
      })
      .catch((error: unknown) => error);
    expect(trpcCode(skip)).toBe("BAD_REQUEST");

    // 合法走到 DONE，再尝试直接回 TODO。
    let version = task.version;
    for (const status of [
      TaskStatus.TODO,
      TaskStatus.IN_PROGRESS,
      TaskStatus.IN_REVIEW,
    ]) {
      const step = await caller.tasks.transition({
        workspaceSlug,
        projectKey,
        number: task.number,
        expectedVersion: version,
        status,
      });
      version = step.task.version;
    }
    const done = await caller.tasks.transition({
      workspaceSlug,
      projectKey,
      number: task.number,
      expectedVersion: version,
      status: TaskStatus.DONE,
    });

    const illegal = await caller.tasks
      .transition({
        workspaceSlug,
        projectKey,
        number: task.number,
        expectedVersion: done.task.version,
        status: TaskStatus.TODO,
      })
      .catch((error: unknown) => error);

    expect(trpcCode(illegal)).toBe("BAD_REQUEST");
    const row = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe(TaskStatus.DONE);
  });

  it("expectedVersion 过期时返回 CONFLICT，数据库不被写入", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const task = await createTask(caller, workspaceSlug, projectKey, "Racy");

    // 模拟另一个人的修改推进了 version。
    await caller.tasks.update({
      workspaceSlug,
      projectKey,
      number: task.number,
      expectedVersion: task.version,
      title: "Racy (renamed)",
    });

    const stale = await caller.tasks
      .transition({
        workspaceSlug,
        projectKey,
        number: task.number,
        expectedVersion: task.version,
        status: TaskStatus.TODO,
      })
      .catch((error: unknown) => error);

    expect(trpcCode(stale)).toBe("CONFLICT");

    const current = await prisma.task.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(current.status).toBe(TaskStatus.BACKLOG);
    expect(current.version).toBe(task.version + 1);
  });
});

describe("tasks.reorder（看板拖拽）", () => {
  it("拖到两列之间取中点 order，插到列尾取 max+1000", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const a = await createTask(caller, workspaceSlug, projectKey, "A");
    const b = await createTask(caller, workspaceSlug, projectKey, "B");
    const c = await createTask(caller, workspaceSlug, projectKey, "C");

    // 三张都在 BACKLOG：A(1000) B(2000) C(3000)，把 C 拖到 A 和 B 之间。
    const moved = await caller.tasks.reorder({
      workspaceSlug,
      projectKey,
      number: c.number,
      expectedVersion: c.version,
      status: TaskStatus.BACKLOG,
      beforeNumber: a.number,
      afterNumber: b.number,
    });

    expect(moved.task.order).toBe((a.order + b.order) / 2);

    // 再把 A 拖到列尾（没有锚点）。
    const tail = await caller.tasks.reorder({
      workspaceSlug,
      projectKey,
      number: a.number,
      expectedVersion: (
        await prisma.task.findUniqueOrThrow({ where: { id: a.id } })
      ).version,
      status: TaskStatus.BACKLOG,
    });

    expect(tail.task.order).toBeGreaterThan(moved.task.order);
  });

  it("锚点任务必须在目标列中，跨列锚点被拒绝", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const a = await createTask(caller, workspaceSlug, projectKey, "A");
    const b = await createTask(caller, workspaceSlug, projectKey, "B");
    await caller.tasks.transition({
      workspaceSlug,
      projectKey,
      number: b.number,
      expectedVersion: b.version,
      status: TaskStatus.TODO,
    });

    const error = await caller.tasks
      .reorder({
        workspaceSlug,
        projectKey,
        number: a.number,
        expectedVersion: a.version,
        status: TaskStatus.BACKLOG,
        beforeNumber: b.number, // b 已经不在 BACKLOG 列
      })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("BAD_REQUEST");
  });
});

describe("tasks.delete（软删除与权限）", () => {
  it("普通成员不能删除别人的任务，但可以删除指派给自己的任务", async () => {
    const world = await seedWorld();
    const { workspaceSlug, projectKey } = world;

    const anonymous = callerFor(null);
    const { user: memberUser } = await anonymous.auth.register({
      email: `member-${Date.now()}@test.local`,
      password: "password-123456",
    });
    const workspace = await prisma.workspace.findUniqueOrThrow({
      where: { slug: workspaceSlug },
    });
    await prisma.membership.create({
      data: {
        userId: memberUser.id,
        workspaceId: workspace.id,
        role: Role.MEMBER,
      },
    });
    const memberCaller = callerFor(memberUser);

    // OWNER 建两张任务：一张指派给成员，一张指派给自己。
    const assigned = (
      await world.caller.tasks.create({
        workspaceSlug,
        projectKey,
        title: "Owned by owner, assigned to member",
        assigneeId: memberUser.id,
      })
    ).task;
    const notAssigned = (
      await world.caller.tasks.create({
        workspaceSlug,
        projectKey,
        title: "Owned and assigned to owner",
        assigneeId: world.user.id,
      })
    ).task;

    const forbidden = await memberCaller.tasks
      .delete({ workspaceSlug, projectKey, number: notAssigned.number })
      .catch((error: unknown) => error);
    expect(trpcCode(forbidden)).toBe("FORBIDDEN");

    const ok = await memberCaller.tasks.delete({
      workspaceSlug,
      projectKey,
      number: assigned.number,
    });
    expect(ok.ok).toBe(true);

    // 软删除：行还在，但 deletedAt 已设置，列表查询不可见。
    const row = await prisma.task.findUniqueOrThrow({
      where: { id: assigned.id },
    });
    expect(row.deletedAt).not.toBeNull();
    const list = await memberCaller.tasks.list({
      workspaceSlug,
      projectKey,
    });
    expect(list.tasks.map((task) => task.number)).not.toContain(
      assigned.number,
    );
  });
});

describe("tasks.listView（游标分页）", () => {
  it("按 limit 截断、返回 nextCursor，第二页从游标之后继续且不重复", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const created = [];
    for (let i = 0; i < 7; i += 1) {
      created.push(
        await createTask(caller, workspaceSlug, projectKey, `Task ${i}`),
      );
    }

    const page1 = await caller.tasks.listView({
      workspaceSlug,
      limit: 3,
      sortField: "number",
      sortDirection: "asc",
    });
    expect(page1.tasks).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await caller.tasks.listView({
      workspaceSlug,
      limit: 3,
      sortField: "number",
      sortDirection: "asc",
      cursor: page1.nextCursor!,
    });
    expect(page2.tasks).toHaveLength(3);

    const numbers = [...page1.tasks, ...page2.tasks].map((task) => task.number);
    expect(new Set(numbers).size).toBe(6);
    expect(numbers.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("非法 cursor 返回 BAD_REQUEST，而不是 500", async () => {
    const { caller, workspaceSlug } = await seedWorld();

    const error = await caller.tasks
      .listView({
        workspaceSlug,
        cursor: Buffer.from("garbage").toString("base64url"),
      })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("BAD_REQUEST");
  });
});
