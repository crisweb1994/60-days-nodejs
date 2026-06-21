import { Global, Module } from '@nestjs/common';
import { MailProcessor } from './mail.processor';
import { MailQueueService } from './mail-queue.service';
import { MailSender } from './mail-sender';

// @Global：和 CacheModule 同级——队列是全应用基础设施，任何模块都能直接注入 MailQueueService
// （注册流程在 AuthModule 里，发帖流程在 PostsModule 里，都不用各自 import）。
//
// 三个 provider 的分工，正好是消息队列的三个角色：
//   MailQueueService —— 生产者（业务调它入队）
//   MailProcessor    —— 消费者（起 worker，拉任务、重试、转死信）
//   MailSender       —— 真正执行者（worker 消费时调它发信，含幂等保护）
// 只导出 MailQueueService：业务只需要「入队」这一个入口；worker/sender 是内部实现细节，不外露。
@Global()
@Module({
  providers: [MailQueueService, MailProcessor, MailSender],
  exports: [MailQueueService],
})
export class QueueModule {}
