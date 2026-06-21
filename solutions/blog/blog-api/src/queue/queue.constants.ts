// 队列名常量。BullMQ 用字符串名字标识一个队列，集中维护避免拼写漂移
// （生产者和消费者必须用【同一个】名字，写错一边就等于两个互不相干的队列）。
export const MAIL_QUEUE = 'mail';

// 死信队列（DLQ, Dead-Letter Queue）：重试耗尽的任务归宿。
// 单独开一条队列放「彻底失败」的邮件，便于人工排查 / 补偿重放，不和正常队列的待处理任务混在一起。
// ★ 用横线不用冒号：BullMQ【禁止队列名含 `:`】——冒号是 Redis key 的命名空间分隔符，
//   队列 `mail` 会产生 `bull:mail:...` 这类 key，队列名里再有冒号会和 key 前缀撞车，所以库直接拒绝。
export const MAIL_DEAD_LETTER = 'mail-dead-letter';

// 幂等标记的 key 前缀：mail:sent:<idempotencyKey>。
// MailSender 用它实现「at-least-once 投递下绝不重复发送」——复用 Day 37 的 SET NX 原语。
export const MAIL_SENT_PREFIX = 'mail:sent:';
