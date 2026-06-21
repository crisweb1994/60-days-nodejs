import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { RedisService } from '../cache/redis.service';
import type { AppConfig } from '../config/configuration';
import { MAIL_DEAD_LETTER, MAIL_QUEUE } from './queue.constants';
import type { MailJobData } from './mail-payload';
import { MailSender } from './mail-sender';

/**
 * MailProcessor —— 队列的「消费者」：起一个 BullMQ Worker，持续从队列拉任务、交给 MailSender 执行。
 *
 * 三件事是它的核心：
 *
 * 1. **重试**：MailSender 抛错 → BullMQ 按入队时配的 attempts + 指数退避自动重试。
 *    重试是队列相对 Pub/Sub 的关键能力之一（Pub/Sub 发出去就算完，崩了没人重发）。
 *
 * 2. **死信队列（DLQ）**：重试到 attempts 次仍失败 → 任务被转进 `mail-dead-letter` 这条单独的队列。
 *    它是「已知坏掉、需要人工介入」的任务的集中安置点——和正常待处理任务分开，便于排查 / 补偿。
 *    （BullMQ 自身会把彻底失败的任务留在原队列的 failed 集合里；我们额外转一份到 DLQ，
 *     是为了给「死信」一个干净、可单独消费/重放的入口，符合业界「死信队列」的通常形态。）
 *
 * 3. **永不让连接错误搞崩进程**：BullMQ 会把底层连接的 error 事件转发到 Worker 上，
 *    必须接住，否则 Node 因「未处理的 error 事件」崩溃（和裸用 ioredis 同一个坑）。
 *
 * Worker 在模块初始化时就【无条件】启动：连不上 Redis 时 BullMQ 会自己重连（自愈），
 * 错误被上面的 handler 接住，不会崩；这样既不踩「启动那一刻 Redis 还没连上」的时序坑，
 * 也保证 Redis 恢复后 worker 自动恢复消费。
 */
@Injectable()
export class MailProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MailProcessor.name);

  private worker?: Worker<MailJobData>;
  // 死信队列：一条普通 Queue，只是没人消费它——专门收容「重试耗尽」的任务，等人工/补偿处理。
  private dlq?: Queue<MailJobData>;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppConfig, true>,
    private readonly sender: MailSender,
  ) {}

  onModuleInit(): void {
    this.dlq = new Queue<MailJobData>(MAIL_DEAD_LETTER, { connection: this.connection });
    this.dlq.on('error', (e) => this.logger.warn(`死信队列连接错误：${e.message}`));

    // Worker 一构造就自动开始轮询队列（BullMQ v5 默认 autoStart）。
    // concurrency：单个 worker 进程内【最多并发】处理几个任务。发信是 IO 密集（等 SMTP），并发能拉高吞吐；
    // 但别太高——下游 SMTP / 数据库扛不住时，并发只会把压力往后推，还可能触发对方的限流。
    this.worker = new Worker<MailJobData>(
      MAIL_QUEUE,
      async (job: Job<MailJobData>) => {
        // 真正干活的一行。抛错会被 BullMQ 接住 → 按策略重试 → 仍失败进死信。
        await this.sender.send(job.data);
      },
      { connection: this.connection, concurrency: this.concurrency },
    );

    this.worker.on('completed', (job) =>
      this.logger.debug(`邮件任务完成：${job.data.kind} → ${job.data.to}`),
    );

    this.worker.on('failed', async (job, err) => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? 1;
      // 每次失败都会触发 failed 事件，但只有「最后一次」（重试耗尽）才转死信。
      if (job.attemptsMade >= maxAttempts) {
        // 转 DLQ：用原 jobId 去重，万一事件重放也不会在死信里塞重复条目。
        await this.dlq?.add(job.name, job.data, { jobId: job.id }).catch((e: Error) =>
          this.logger.error(`转死信失败 ${job?.data.to}：${e.message}`),
        );
        this.logger.error(
          `邮件重试 ${maxAttempts} 次仍失败，转入死信队列：${job.data.to}（${err.message}）`,
        );
      } else {
        this.logger.warn(
          `邮件第 ${job.attemptsMade}/${maxAttempts} 次失败，将退避重试：${job.data.to}（${err.message}）`,
        );
      }
    });

    // ★ 必接：Worker 把连接 error 转发上来，不接会崩进程。生产里这里可挂监控/告警。
    this.worker.on('error', (e) => this.logger.warn(`邮件 worker 连接错误：${e.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    // 先停 worker（不再拉新任务、等当前任务收尾），再关队列连接。close 连不上时可能 reject，吞掉。
    await this.worker?.close().catch(() => undefined);
    await this.dlq?.close().catch(() => undefined);
  }

  /** 仅测试用：死信队列里的任务总数（各状态求和）。 */
  async deadLetterCount(): Promise<number> {
    const counts = await this.dlq?.getJobCounts();
    if (!counts) return 0;
    return Object.values(counts).reduce((a, b) => a + b, 0);
  }

  /** 仅测试用：清空死信队列。 */
  async clearDeadLetters(): Promise<void> {
    await this.dlq?.obliterate({ force: true });
  }

  private get connection(): ConnectionOptions {
    return { url: this.config.get('redis.url', { infer: true }) };
  }

  private get concurrency(): number {
    return this.config?.get('queue.concurrency', { infer: true }) ?? 4;
  }
}
