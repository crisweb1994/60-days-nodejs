import { EmailDeliveryStatus, Role } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  callerFor,
  createTask,
  prisma,
  resetDatabase,
  seedWorld,
} from "./test-utils";

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// 把第二个用户以 MEMBER 身份放进种子世界，返回它的 caller。
async function inviteMember(workspaceSlug: string) {
  const anonymous = callerFor(null);
  const { user } = await anonymous.auth.register({
    email: `member-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`,
    password: "password-123456",
  });
  const workspace = await prisma.workspace.findUniqueOrThrow({
    where: { slug: workspaceSlug },
  });
  await prisma.membership.create({
    data: {
      userId: user.id,
      workspaceId: workspace.id,
      role: Role.MEMBER,
    },
  });

  return { user, caller: callerFor(user) };
}

async function notificationsOf(userId: string) {
  return prisma.notification.findMany({
    where: { recipientId: userId },
    orderBy: { createdAt: "asc" },
  });
}

describe("任务指派通知", () => {
  it("指派给成员产生一条通知，邮件任务进入队列", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const member = await inviteMember(workspaceSlug);

    await caller.tasks.create({
      workspaceSlug,
      projectKey,
      title: "Please do this",
      assigneeId: member.user.id,
    });

    const rows = await notificationsOf(member.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain("ENG-1");
    expect(rows[0].emailStatus).toBe(EmailDeliveryStatus.QUEUED);
  });

  it("指派给自己的任务不产生通知（操作者去重）", async () => {
    const { caller, user, workspaceSlug, projectKey } = await seedWorld();

    await createTask(caller, workspaceSlug, projectKey, "My own task");

    expect(await notificationsOf(user.id)).toHaveLength(0);
  });

  it("成员关闭 taskAssigned 偏好后不再收到指派通知", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const member = await inviteMember(workspaceSlug);

    await member.caller.notifications.updatePreferences({
      workspaceSlug,
      taskAssigned: false,
    });

    await caller.tasks.create({
      workspaceSlug,
      projectKey,
      title: "Muted assignment",
      assigneeId: member.user.id,
    });

    expect(await notificationsOf(member.user.id)).toHaveLength(0);
  });

  it("保留站内通知但关闭邮件时，emailStatus 记为 SKIPPED", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const member = await inviteMember(workspaceSlug);

    await member.caller.notifications.updatePreferences({
      workspaceSlug,
      emailEnabled: false,
    });

    await caller.tasks.create({
      workspaceSlug,
      projectKey,
      title: "In-app only",
      assigneeId: member.user.id,
    });

    const rows = await notificationsOf(member.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].visibleInApp).toBe(true);
    expect(rows[0].emailStatus).toBe(EmailDeliveryStatus.SKIPPED);
  });

  it("状态变更通知默认关闭（宁可少打扰）", async () => {
    const { caller, workspaceSlug, projectKey } = await seedWorld();
    const member = await inviteMember(workspaceSlug);
    const task = await createTask(
      caller,
      workspaceSlug,
      projectKey,
      "Will move",
    );

    // 先指派（产生一条），再流转状态（默认不再产生）。
    await caller.tasks.update({
      workspaceSlug,
      projectKey,
      number: task.number,
      expectedVersion: task.version,
      assigneeId: member.user.id,
    });
    const assignedVersion = task.version + 1;

    await caller.tasks.transition({
      workspaceSlug,
      projectKey,
      number: task.number,
      expectedVersion: assignedVersion,
      status: "TODO",
    });

    const rows = await notificationsOf(member.user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("TASK_ASSIGNED");
  });
});
