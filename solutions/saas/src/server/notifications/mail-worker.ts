import { EmailDeliveryStatus } from "@prisma/client";
import { Worker } from "bullmq";

import { prisma } from "@/server/db";
import {
  MAIL_QUEUE_NAME,
  redisConnection,
  type NotificationMailJob,
} from "@/server/notifications/mail-queue";

const worker = new Worker<NotificationMailJob>(
  MAIL_QUEUE_NAME,
  async (job) => {
    // Day 52 使用本地发送适配器。生产环境只需把这一段替换为 SMTP/邮件供应商调用。
    console.log(
      "[mail] to=" + job.data.to + " subject=" + JSON.stringify(job.data.subject),
    );
    await prisma.notification.update({
      where: { id: job.data.notificationId },
      data: {
        emailStatus: EmailDeliveryStatus.SENT,
        emailSentAt: new Date(),
        emailError: null,
      },
    });
  },
  {
    connection: redisConnection(),
    concurrency: 4,
  },
);

worker.on("completed", (job) => {
  console.log("[mail-worker] completed job=" + job.id);
});

worker.on("failed", async (job, error) => {
  if (!job) {
    return;
  }
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= maxAttempts) {
    await prisma.notification
      .update({
        where: { id: job.data.notificationId },
        data: {
          emailStatus: EmailDeliveryStatus.FAILED,
          emailError: error.message.slice(0, 500),
        },
      })
      .catch(() => undefined);
  }
  console.error(
    "[mail-worker] failed job=" +
      job.id +
      " attempt=" +
      job.attemptsMade +
      "/" +
      maxAttempts +
      ": " +
      error.message,
  );
});

worker.on("error", (error) => {
  console.error("[mail-worker] Redis error:", error.message);
});

async function shutdown(signal: string) {
  console.log("[mail-worker] " + signal + ", shutting down");
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log("[mail-worker] listening queue=" + MAIL_QUEUE_NAME);
