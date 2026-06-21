// 邮件任务的数据载荷。这就是「队列里传的那条消息」。
//
// ★ 关键设计：入队的数据要【小、自包含、可序列化】。
//   - 小：它要写进 Redis、在内存里流转，别把整个领域对象塞进来。
//   - 自包含：worker 拿到它就能干活，最好不用再回查 DB（回查会引入「入队到处理之间数据已变」的一致性问题）。
//     实在需要最新数据，worker 里再查一次，但要接受「查到的是当前快照」。
//   - 可序列化：BullMQ 用 msgpack 序列化，必须是纯 JSON 结构（不能塞 Date / 函数 / 类实例）。
export type MailKind = 'welcome' | 'notification';

export interface MailJobData {
  kind: MailKind;
  to: string;
  subject: string;
  body: string;

  // 幂等键：at-least-once 投递下，「同一条邮件」可能被处理多次（重试 / worker 重启后重放）。
  // 用它告诉 MailSender「这封我已经发过了，别再发」。同时作为 BullMQ 的 jobId，争取在入队侧也去重。
  // 生成建议：`<kind>_<业务实体 id>`，如 `welcome_<userId>`——稳定，重放同一事件得到同一个 key。
  // ★ 不能含 `:`：它会被当 jobId 拼进 Redis key（bull:mail:<jobId>），BullMQ 禁止冒号。
  idempotencyKey: string;
}
