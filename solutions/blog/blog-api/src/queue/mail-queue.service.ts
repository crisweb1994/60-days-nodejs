import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions, type JobsOptions } from 'bullmq';
import { RedisService } from '../cache/redis.service';
import type { AppConfig } from '../config/configuration';
import { MAIL_QUEUE } from './queue.constants';
import type { MailJobData } from './mail-payload';

/**
 * MailQueueService —— 队列的「生产者」：业务代码（如注册）调它把邮件任务塞进队列。
 *
 * 和缓存/排行榜同一套哲学：队列是【可选的异步基础设施】，挂了绝不能拖垮主流程。
 *   - Redis 不通 → 入队直接跳过（邮件晚点补发或丢，但注册照样成功）。
 *   - 入队本身出错 → 静默吞掉，不让一次「邮件系统抖动」把用户注册打成 500。
 *
 * 这正是「异步解耦」的全部价值：**邮件发不发得出去，和「创建用户」这个核心动作的成功与否，彻底解绑。**
 * 同步发信会把 SMTP 的延迟（秒级）和故障（可达性）直接传导给用户；甩进队列后，用户只等「入队」这一下（毫秒级）。
 */
@Injectable()
export class MailQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(MailQueueService.name);

  // 懒初始化：第一次入队才建 Queue。没邮件可发时，不白开一条 Redis 连接。
  private queue?: Queue<MailJobData>;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * 入队一封邮件。永不抛错——它是 fire-and-forget 的一环，不能让调用方（注册接口）因为它失败。
   * opts 可覆盖默认的重试/退避（测试里用它塞小退避，快速观察「重试耗尽→死信」）。
   */
  async enqueue(mail: MailJobData, opts?: JobsOptions): Promise<void> {
    // 先看连接：Redis 不通就 BYPASS，省掉一次注定失败的 add。
    if (!this.redis.available) {
      this.logger.warn(`Redis 不可用，跳过入队：${mail.kind} → ${mail.to}`);
      return;
    }
    try {
      await this.getQueue().add(mail.kind, mail, {
        // jobId = 幂等键：BullMQ 据此在「等待/处理中」状态下去重——
        // 同一事件并发触发两次入队，只会产生一条任务（另一条被识别为重复而忽略）。
        jobId: mail.idempotencyKey,
        attempts: this.attempts,
        // 指数退避：第 n 次重试约等 base × 2^(n-1)。比固定间隔更能缓解「下游短暂故障」，
        // 也不会一上来就狂轰。delay 单位毫秒。
        backoff: { type: 'exponential', delay: this.backoffMs },
        // 完成的任务保留最近 N 条便于观测；不无限堆积（每个完成 Job 都占 Redis 内存）。
        removeOnComplete: 100,
        // 失败的任务不自动删——我们靠它们在 worker 的 failed 事件里转进死信队列。
        removeOnFail: false,
        ...opts,
      });
    } catch (e) {
      this.logger.warn(`入队失败（已忽略）${mail.kind} → ${mail.to}：${(e as Error).message}`);
    }
  }

  /** 仅测试用：清空队列里所有任务（obliterate 会连带清掉等待/延迟/完成/失败）。 */
  async obliterate(): Promise<void> {
    await this.queue?.obliterate({ force: true });
  }

  /** 暴露底层 Queue 给测试读取任务计数（正常业务代码不该直接碰它）。 */
  getQueueHandle(): Queue<MailJobData> {
    return this.getQueue();
  }

  private getQueue(): Queue<MailJobData> {
    if (!this.queue) {
      this.queue = new Queue<MailJobData>(MAIL_QUEUE, { connection: this.connection });
      // ★ 必接：BullMQ 把底层连接的 error 事件【原样转发】到 Queue 上。
      //   没人接的话，Node 会因「未处理的 error 事件」直接崩溃（和裸用 ioredis 同一个坑）。
      this.queue.on('error', (e) => this.logger.warn(`邮件队列连接错误：${e.message}`));
    }
    return this.queue;
  }

  private get connection(): ConnectionOptions {
    // 复用缓存/锁同一个 Redis 实例。BullMQ 自行管理连接（生产者一条，消费者一条）。
    return { url: this.config.get('redis.url', { infer: true }) };
  }

  private get attempts(): number {
    return this.config?.get('queue.attempts', { infer: true }) ?? 3;
  }

  private get backoffMs(): number {
    return this.config?.get('queue.backoffMs', { infer: true }) ?? 1000;
  }

  async onModuleDestroy(): Promise<void> {
    // close() 会等在途命令收尾后优雅断开；连不上时可能 reject，与业务无关，吞掉即可。
    await this.queue?.close().catch(() => undefined);
  }
}
