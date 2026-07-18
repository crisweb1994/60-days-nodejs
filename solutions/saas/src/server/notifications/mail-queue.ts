import { Queue, type ConnectionOptions } from "bullmq";

import { env } from "@/env";

export const MAIL_QUEUE_NAME = "notification-mail";

export type NotificationMailJob = {
  notificationId: string;
  to: string;
  subject: string;
  body: string;
};

function redisConnection(maxRetriesPerRequest: number | null = null): ConnectionOptions {
  const url = new URL(env.REDIS_URL);
  const database = Number(url.pathname.slice(1) || "0");

  return {
    host: url.hostname,
    port: Number(url.port || "6379"),
    username: url.username || undefined,
    password: url.password || undefined,
    db: database,
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest,
  };
}

const globalForMailQueue = globalThis as unknown as {
  notificationMailQueue?: Queue<NotificationMailJob>;
};

export function getMailQueue(): Queue<NotificationMailJob> {
  if (!globalForMailQueue.notificationMailQueue) {
    const queue = new Queue<NotificationMailJob>(MAIL_QUEUE_NAME, {
      connection: redisConnection(1),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    });
    queue.on("error", (error) => {
      console.error("[mail-queue] Redis error:", error.message);
    });
    globalForMailQueue.notificationMailQueue = queue;
  }

  return globalForMailQueue.notificationMailQueue;
}

export async function enqueueNotificationMail(
  mail: NotificationMailJob,
): Promise<void> {
  const addJob = getMailQueue().add("send-notification", mail, {
    // 同一条通知无论业务层重试多少次，都只保留一个邮件任务。
    jobId: mail.notificationId,
  });
  let timeout: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      addJob,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Mail queue timed out after 2 seconds")),
          2000,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export { redisConnection };
