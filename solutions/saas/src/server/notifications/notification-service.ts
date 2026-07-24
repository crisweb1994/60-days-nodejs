import {
  EmailDeliveryStatus,
  NotificationType,
  type PrismaClient,
} from "@prisma/client";

import { enqueueNotificationMail } from "@/server/notifications/mail-queue";

type NotificationPrisma = Pick<
  PrismaClient,
  "notification" | "notificationPreference" | "user"
>;

type TaskNotificationInput = {
  prisma: NotificationPrisma;
  workspaceId: string;
  actorId: string;
  recipientIds: Array<string | null | undefined>;
  type: NotificationType;
  title: string;
  body?: string;
  data: {
    taskId: string;
    taskNumber: number;
    projectKey: string;
    [key: string]: string | number;
  };
};

function preferenceField(type: NotificationType) {
  switch (type) {
    case NotificationType.TASK_ASSIGNED:
      return "taskAssigned" as const;
    case NotificationType.TASK_COMMENTED:
      return "taskCommented" as const;
    case NotificationType.TASK_STATUS_CHANGED:
      return "taskStatusChanged" as const;
  }
}

function defaultEventEnabled(type: NotificationType): boolean {
  return type !== NotificationType.TASK_STATUS_CHANGED;
}

export async function createTaskNotifications(
  input: TaskNotificationInput,
): Promise<void> {
  const recipientIds = [
    ...new Set(
      input.recipientIds.filter(
        (id): id is string => Boolean(id) && id !== input.actorId,
      ),
    ),
  ];
  if (recipientIds.length === 0) {
    return;
  }

  const [recipients, preferences] = await Promise.all([
    input.prisma.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, email: true },
    }),
    input.prisma.notificationPreference.findMany({
      where: {
        workspaceId: input.workspaceId,
        userId: { in: recipientIds },
      },
    }),
  ]);
  const preferencesByUser = new Map(
    preferences.map((preference) => [preference.userId, preference]),
  );
  const eventField = preferenceField(input.type);

  for (const recipient of recipients) {
    const preference = preferencesByUser.get(recipient.id);
    const eventEnabled =
      preference?.[eventField] ?? defaultEventEnabled(input.type);
    const visibleInApp = eventEnabled && (preference?.inAppEnabled ?? true);
    const emailEnabled = eventEnabled && (preference?.emailEnabled ?? true);
    if (!visibleInApp && !emailEnabled) {
      continue;
    }

    const notification = await input.prisma.notification.create({
      data: {
        workspaceId: input.workspaceId,
        recipientId: recipient.id,
        actorId: input.actorId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
        visibleInApp,
        emailStatus: emailEnabled
          ? EmailDeliveryStatus.PENDING
          : EmailDeliveryStatus.SKIPPED,
      },
      select: { id: true },
    });

    if (!emailEnabled) {
      continue;
    }

    try {
      await enqueueNotificationMail({
        notificationId: notification.id,
        to: recipient.email,
        subject: input.title,
        body: input.body ?? input.title,
      });
      await input.prisma.notification.updateMany({
        where: {
          id: notification.id,
          emailStatus: EmailDeliveryStatus.PENDING,
        },
        data: {
          emailStatus: EmailDeliveryStatus.QUEUED,
          emailQueuedAt: new Date(),
          emailError: null,
        },
      });
    } catch (error) {
      await input.prisma.notification.update({
        where: { id: notification.id },
        data: {
          emailStatus: EmailDeliveryStatus.FAILED,
          emailError:
            error instanceof Error ? error.message.slice(0, 500) : "Queue error",
        },
      });
    }
  }
}

export async function notifyWithoutBreakingMutation(
  input: TaskNotificationInput,
): Promise<void> {
  try {
    await createTaskNotifications(input);
  } catch (error) {
    // 主业务已经提交后，通知故障不能把成功的任务 mutation 伪装成失败。
    console.error("[notifications] Failed to create notification:", error);
  }
}
