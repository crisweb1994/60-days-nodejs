import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  callerFor,
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
    data: { userId: user.id, workspaceId: workspace.id, role: "MEMBER" },
  });

  return { user, caller: callerFor(user) };
}

describe("notifications.list / markRead", () => {
  it("收件人只看到自己的通知，标记已读后从未读列表消失", async () => {
    const world = await seedWorld();
    const { workspaceSlug, projectKey } = world;
    const member = await inviteMember(workspaceSlug);

    // 两条指派 + 一条评论。
    const first = await world.caller.tasks.create({
      workspaceSlug,
      projectKey,
      title: "First",
      assigneeId: member.user.id,
    });
    await world.caller.tasks.create({
      workspaceSlug,
      projectKey,
      title: "Second",
      assigneeId: member.user.id,
    });
    await world.caller.tasks.addComment({
      workspaceSlug,
      projectKey,
      number: first.task.number,
      body: "A comment",
    });

    const inbox = await member.caller.notifications.list({ workspaceSlug });
    expect(inbox.notifications).toHaveLength(3);
    // 按创建时间倒序：最新的（评论）在前。
    expect(inbox.notifications[0].type).toBe("TASK_COMMENTED");

    const unreadBefore = await member.caller.notifications.unreadCount({
      workspaceSlug,
    });
    expect(unreadBefore.count).toBe(3);

    await member.caller.notifications.markRead({
      workspaceSlug,
      notificationId: inbox.notifications[0].id,
    });

    const unreadOnly = await member.caller.notifications.list({
      workspaceSlug,
      unreadOnly: true,
    });
    expect(unreadOnly.notifications).toHaveLength(2);
    expect(
      unreadOnly.notifications.map((notification) => notification.id),
    ).not.toContain(inbox.notifications[0].id);

    await member.caller.notifications.markAllRead({ workspaceSlug });
    const unreadFinal = await member.caller.notifications.unreadCount({
      workspaceSlug,
    });
    expect(unreadFinal.count).toBe(0);
  });

  it("不能标记不属于收件人的通知", async () => {
    const world = await seedWorld();
    const { workspaceSlug, projectKey } = world;
    const member = await inviteMember(workspaceSlug);

    await world.caller.tasks.create({
      workspaceSlug,
      projectKey,
      title: "Assigned to member",
      assigneeId: member.user.id,
    });
    const memberInbox = await member.caller.notifications.list({ workspaceSlug });
    expect(memberInbox.notifications).toHaveLength(1);

    // OWNER 不是这条通知的收件人，updateMany 命中 0 行 -> NOT_FOUND。
    const error = await world.caller.notifications
      .markRead({
        workspaceSlug,
        notificationId: memberInbox.notifications[0].id,
      })
      .catch((error: unknown) => error);

    expect(trpcCode(error)).toBe("NOT_FOUND");
    const row = await prisma.notification.findUniqueOrThrow({
      where: { id: memberInbox.notifications[0].id },
    });
    expect(row.readAt).toBeNull();
  });
});
