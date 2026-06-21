import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../cache/redis.service';
import type { AppConfig } from '../config/configuration';
import { MAIL_SENT_PREFIX } from './queue.constants';
import type { MailJobData } from './mail-payload';

/**
 * MailSender —— 队列的「真正执行者」：worker 每消费一个任务，就调一次这里。
 *
 * 两个职责，缺一不可：
 *
 * 1. **幂等（绝不重复发送）**
 *    消息队列默认是【at-least-once】投递：同一条任务可能被处理多次——worker 崩了重启会重放、
 *    网络抖动触发重试、多个 worker 副本并发拉到同一条。如果「发邮件」这种动作没有幂等保护，
 *    重试一次用户就多收一封。所以发送前先用 Redis 的 SET NX「占坑」：
 *      - 占到坑（第一次）→ 真正发送；
 *      - 占不到（已经发过）→ 直接跳过。
 *    这正是 Day 37 分布式锁用过的同一个原语（`SET NX EX`），换个语义：锁是「互斥执行」，这里是「互斥发送」。
 *
 *    ★ 失败要【回退占坑】：如果占了坑、发送却抛错，必须把坑让出来（DEL），否则重试时占坑还在、
 *      被误判成「已发」而永远跳过 → 邮件丢失。坑只有在【发送成功后】才保留（实现 at-least-once→effectively-once）。
 *
 * 2. **可观测的副作用**
 *    真实环境这里接 nodemailer / SES / SendGrid。demo 不接外部 SMTP（不引入网络依赖、不真发信），
 *    只打日志证明「异步、可重试、幂等」。deliveredCount 留给测试和观测用。
 */
@Injectable()
export class MailSender {
  private readonly logger = new Logger(MailSender.name);

  // 真正「发出去」的计数，按幂等键去重。仅观测 / 测试用——证明幂等生效（同一 key 只 +1）。
  readonly deliveredCount = new Map<string, number>();

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** worker 调它。返回是否【真的】发送了（false = 命中幂等被跳过）。失败时抛异常 → 触发 BullMQ 重试。 */
  async send(mail: MailJobData): Promise<boolean> {
    const sentKey = `${MAIL_SENT_PREFIX}${mail.idempotencyKey}`;

    // ① 原子占坑。true = 我是第一个处理这条的；false = 已发过（或 Redis 抖动，见 README 诚实清单）。
    const mine = await this.redis.setNx(sentKey, '1', this.sentTtl);
    if (!mine) {
      this.logger.debug(`幂等命中，跳过重复发送：${mail.kind} → ${mail.to}`);
      return false;
    }

    // ② 真正「发送」。占坑之后、标记成功之前抛错，必须回退占坑——否则重试会被误判已发。
    try {
      this.simulateSmtp(mail); // demo：真实环境换成 await transporter.sendMail(...)
      this.deliveredCount.set(
        mail.idempotencyKey,
        (this.deliveredCount.get(mail.idempotencyKey) ?? 0) + 1,
      );
      this.logger.log(`📧 已发送 [${mail.kind}] → ${mail.to}：${mail.subject}`);
      return true;
    } catch (e) {
      // 失败：让出占坑，好让重试能再次尝试；然后抛出，由 BullMQ 按策略重试 / 进死信。
      await this.redis.del(sentKey);
      throw e;
    }
  }

  /**
   * demo「SMTP」。真实环境把这里换成 nodemailer/SES 的发送调用。
   * 收件人以 `@fail.test` 结尾视为「投递失败」——用来在练习/测试里触发重试与死信，不依赖真实 SMTP 故障。
   */
  private simulateSmtp(mail: MailJobData): void {
    if (mail.to.endsWith('@fail.test')) {
      throw new Error(`模拟 SMTP 投递失败 → ${mail.to}`);
    }
    // 正常情况：demo 不真发，仅靠上面的日志体现「已发送」。
  }

  /** 仅测试用：清空观测计数。 */
  resetCounters(): void {
    this.deliveredCount.clear();
  }

  private get sentTtl(): number {
    // 幂等标记的存活时间：覆盖「最坏一次重试链」的时长即可（默认 1 天）。
    // 太短：标记过期后重试可能造成重复发送；太长：占用内存。邮件类任务给到天级合理。
    return this.config?.get('queue.sentTtlSec', { infer: true }) ?? 86_400;
  }
}
