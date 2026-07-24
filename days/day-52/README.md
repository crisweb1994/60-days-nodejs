# Day 52 — 通知系统与异步任务

Day 51 做完实时协作后，任务变化已经可以通过 SSE 立刻推到浏览器。但“实时看到”不等于“通知送达”：用户不在线时收不到 SSE，页面刷新后也无法查询历史事件；而邮件发送速度慢、可能失败，更不应该堵住保存任务的请求。

今天把这三件事拆开：

- SSE 负责让在线页面立即更新；
- PostgreSQL 保存用户稍后仍能看到的站内通知；
- BullMQ 负责可重试的邮件投递。

## 今日目标

- 设计可查询、可标记已读的通知模型
- 提供通知列表、未读数、批量已读和偏好设置 API
- 在任务指派、评论、状态变化时创建通知
- 使用 BullMQ 将邮件投递移出请求链路
- 理解幂等、重试、退避、故障窗口和批量摘要

## 1. 三种机制解决三类问题

| 机制 | 主要目的 | 是否持久化 | 失败后重试 | 典型场景 |
| --- | --- | --- | --- | --- |
| SSE | 让在线页面立刻变化 | 否 | 通常不重试 | 看板刷新、在线状态 |
| 站内通知 | 让用户稍后仍能看到 | 是 | 不需要投递重试 | 通知中心、未读角标 |
| BullMQ | 可靠执行耗时任务 | Redis 保存 | 是 | 邮件、导出、图片处理 |

任务从 `TODO` 移到 `IN_PROGRESS` 时，SSE 先更新在线用户的看板；如果负责人需要关注，数据库增加一条通知；如果负责人开启邮件提醒，BullMQ 再增加一条邮件任务。API 返回后，worker 独立消费任务。

不是所有实时事件都应该变成通知。拖动排序、修改错别字等高频操作如果全部提醒，通知中心很快就会失去价值。通知应该对应“接收者需要知道或采取行动”的事件。

## 2. 通知是一条业务记录

本次实现的核心模型是 `Notification`：

```prisma
model Notification {
  id            String              @id @default(uuid()) @db.Uuid
  workspaceId   String              @db.Uuid
  recipientId   String              @db.Uuid
  actorId       String?             @db.Uuid
  type          NotificationType
  title         String
  body          String?
  data          Json
  visibleInApp  Boolean             @default(true)
  readAt        DateTime?
  emailStatus   EmailDeliveryStatus @default(SKIPPED)
  emailQueuedAt DateTime?
  emailSentAt   DateTime?
  emailError    String?
  createdAt     DateTime             @default(now())
}
```

- `recipientId`：谁接收通知；
- `actorId`：谁触发事件，例如评论作者；
- `type`：稳定的机器语义，前端据此选择图标和跳转；
- `title`、`body`：创建时生成的展示快照；
- `data`：任务 ID、项目 key、任务编号等结构化上下文；
- `readAt`：站内通知是否已读；
- `emailStatus`：邮件通道当前处于什么状态。

### 为什么既存文案，又存 data

只存文案，前端无法可靠跳到对应任务；只存任务 ID，历史展示又会依赖可能已删除或改名的数据。因此同时保存展示快照和结构化上下文：

```json
{
  "title": "You were assigned ENG-42",
  "body": "Fix payment callback",
  "data": {
    "taskId": "…",
    "taskNumber": 42,
    "projectKey": "ENG"
  }
}
```

文案保证历史可读，`data` 负责导航和扩展。生产项目中应为每种 `type` 定义明确的 TypeScript 数据类型，不能把 `data` 当作随意堆字段的地方。

### 为什么用 readAt，而不是 isRead

布尔值只能表达读过或没读过，时间字段还能回答用户何时阅读、某次推送是否发生在已读之后。`readAt IS NULL` 仍可高效查询未读记录，所以不必再维护一个容易不一致的 `isRead`。

### 邮件状态为什么不能复用 readAt

站内已读与邮件送达是两个维度。用户可能在邮件发送前已经看过站内通知，也可能从邮件直接打开任务。这里明确记录：

```text
SKIPPED -> 用户未开启邮件通道
PENDING -> 通知已落库，准备入队
QUEUED  -> BullMQ 已接收任务
SENT    -> worker 完成发送
FAILED  -> 入队或多次执行失败
```

## 3. 工作区边界与索引

通知直接保存 `workspaceId` 和 `recipientId`。这样通知中心不必跨任务、项目反查工作区，API 也能先验证当前用户仍是该工作区成员。

最热查询是某个用户的未读通知：

```sql
SELECT *
FROM notifications
WHERE recipient_id = $1
  AND visible_in_app = true
  AND read_at IS NULL
ORDER BY created_at DESC, id DESC
LIMIT 30;
```

对应索引将等值过滤字段放前面：

```prisma
@@index([recipientId, visibleInApp, readAt, createdAt])
```

列表使用 `(createdAt, id)` 复合游标。两条通知可能在同一毫秒创建，仅使用时间会漏行或重复，`id` 用来稳定打破平局。

## 4. 偏好属于“用户 × 工作区”

同一个用户在工作区 A 可能负责紧急项目，在工作区 B 只是旁观者。把偏好放在 `User` 上，会迫使所有团队使用同一套设置。因此使用复合主键：

```prisma
model NotificationPreference {
  userId            String
  workspaceId       String
  inAppEnabled      Boolean @default(true)
  emailEnabled      Boolean @default(true)
  taskAssigned      Boolean @default(true)
  taskCommented     Boolean @default(true)
  taskStatusChanged Boolean @default(false)

  @@id([userId, workspaceId])
}
```

偏好分为两层：

- 通道开关：`inAppEnabled`、`emailEnabled`；
- 事件开关：`taskAssigned`、`taskCommented`、`taskStatusChanged`。

是否发送邮件是两层条件的交集。没有偏好记录时采用产品默认值：指派和评论默认开启，频率更高的状态变化默认关闭。Prisma 默认值、偏好查询的缺省值和通知服务中的缺省行为必须一致。

## 5. 接收者计算与权限

| 事件 | 接收者 |
| --- | --- |
| 新建任务并指派 | 负责人 |
| 修改负责人 | 新负责人 |
| 新评论 | 负责人和报告人 |
| 状态变化 | 负责人（默认关闭） |

创建通知前要排除操作者本人，并用 `Set` 去重。负责人和报告人是同一个人时，只创建一条：

```ts
const recipientIds = [
  ...new Set(ids.filter((id) => id && id !== actorId)),
];
```

标记已读不能相信客户端提交的接收者，而要把对象级权限放进最终更新条件：

```ts
await prisma.notification.updateMany({
  where: {
    id: notificationId,
    workspaceId,
    recipientId: currentUser.id,
    visibleInApp: true,
  },
  data: { readAt: new Date() },
});
```

即使用户猜到别人的 UUID，也无法修改别人的通知。

## 6. 为什么邮件必须离开 HTTP 请求

如果 API 在保存任务后直接等待邮件服务：

```ts
await updateTask();
await mailProvider.send(message);
return task;
```

邮件供应商的延迟和故障就会传给用户。供应商超时，用户会误以为任务保存失败；用户再次点击，还可能产生重复操作。

队列模式中，请求只登记工作：

```ts
await queue.add("send-notification", payload, {
  jobId: notification.id,
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
});
```

worker 使用独立进程消费：

```bash
pnpm worker:mail
```

API 和 worker 可以分别扩容。请求多就扩 API，邮件积压就扩 worker。

## 7. BullMQ 的几个关键参数

### jobId：幂等的第一道防线

同一条通知使用 `notification.id` 作为 `jobId`。业务层重复入队时，BullMQ 不会再创建同 ID 的活动任务。

但队列去重不等于邮件绝不会重复。worker 可能调用邮件供应商成功，却在更新数据库前崩溃；任务重试后可能再发一次。更强的方案是把同一幂等键传给支持幂等的供应商，或记录供应商返回的 message ID。

### attempts 与指数退避

网络超时、HTTP 503 等短暂故障适合重试；邮箱格式非法、模板不存在则不该重试。项目最多执行三次，并使用指数退避：

```text
第 1 次失败 -> 等约 1 秒
第 2 次失败 -> 等约 2 秒
第 3 次失败 -> 最终失败
```

退避是为了让下游恢复。故障时高频固定重试，只会继续给下游施压。

### concurrency：并发并非越大越好

worker 的 `concurrency: 4` 表示单进程最多同时处理四封邮件。发送邮件是 I/O 密集操作，适当并发能提高吞吐，但上限仍受供应商限流、Redis 连接数和数据库连接池约束。

```text
吞吐量 ≈ worker 数量 × concurrency / 单封平均耗时
```

### Redis 不是永久审计库

完成任务仅保留最近 100 条，失败任务保留 500 条。业务审计由 PostgreSQL 的 `emailStatus` 承担，Redis 负责调度，不能无限保存历史任务。

## 8. 双写一致性与 Outbox

当前链路是：

```text
写任务 -> 写通知(PENDING) -> BullMQ 入队 -> 更新为 QUEUED
```

如果进程恰好在“写通知”后、“入队”前崩溃，数据库里会有 `PENDING`，Redis 中却没有任务。这是典型的双写问题。

小项目可定时扫描超过一分钟的 `PENDING` 通知并重新入队。由于 `jobId = notification.id`，重复入队是安全的。

要求更高时采用 Transactional Outbox：

1. 在业务数据的同一数据库事务中写入 `outbox_events`；
2. relay 进程读取未发布事件；
3. 发布到 BullMQ 后标记 `published_at`；
4. relay 崩溃后继续扫描，依赖幂等键处理重复发布。

PostgreSQL 和 Redis 无法靠一个普通数据库事务实现原子提交。Outbox 把“业务变化”和“待发布事实”放进同一个本地事务，再通过补偿实现最终一致。

## 9. 死信与可观测性

重试耗尽后，生产系统通常把任务送入死信队列（DLQ），供人工检查或补偿程序重放。记录至少应包含原 `jobId`、通知 ID、收件人、任务类型、执行次数、最后错误和失败时间。

应关注的指标包括：

- waiting 数量是否持续增长；
- 最老任务等待了多久；
- 每分钟完成数、失败数和重试率；
- `PENDING`、`FAILED` 通知是否积压；
- worker 是否仍有心跳。

队列长度短暂增加不一定异常，长时间只增不减才说明消费能力不足或 worker 已停止。

## 10. 批量发送与摘要

五分钟内几十条评论如果逐条发邮件，技术上成功了，用户体验却失败了。常见优化有：

- 时间窗口合并：按“接收者 + 任务”延迟两分钟，合成“ENG-42 有 5 条新评论”；
- 定时摘要：每天或每周聚合尚未汇总的通知；
- 供应商批量 API：减少连接开销，但仍要逐封记录部分失败。

摘要任务应保存已经处理到哪个事件或时间点，保证任务重跑时不漏发、不重复。优化的第一步是减少不必要邮件，然后才是更快地发送。

## 11. 本次 API

| Procedure | 类型 | 作用 |
| --- | --- | --- |
| `notifications.list` | query | 游标分页查询通知 |
| `notifications.unreadCount` | query | 查询未读数 |
| `notifications.markRead` | mutation | 标记单条已读 |
| `notifications.markAllRead` | mutation | 标记工作区全部已读 |
| `notifications.preferences` | query | 读取偏好及默认值 |
| `notifications.updatePreferences` | mutation | 局部更新偏好 |

所有接口先验证工作区成员身份。列表只返回当前用户自己的通知，写操作也在数据库条件中限制 `recipientId`。

## 12. 本地运行

```bash
cd solutions/saas
docker compose up -d
pnpm prisma:push
pnpm dev
```

另开终端启动 worker：

```bash
cd solutions/saas
pnpm worker:mail
```

当前 worker 使用开发发送适配器：打印收件人和标题，并将数据库状态更新为 `SENT`，不会向真实邮箱发送测试邮件。接入 SMTP 或邮件供应商时，只替换 worker 的发送部分，生产者和业务代码无需修改。

## 13. 验收清单

- [ ] 用户 A 创建任务并指派给 B，B 出现 `TASK_ASSIGNED`
- [ ] A 不会收到自己触发的通知
- [ ] B 的未读数增加，标记已读后减少
- [ ] A 评论任务时，负责人和报告人收到通知，重复身份只生成一条
- [ ] B 关闭评论通知后，新评论不再创建对应通知
- [ ] 邮件状态经过 `PENDING -> QUEUED -> SENT`
- [ ] Redis 暂时不可用时，任务本身仍能保存
- [ ] 非成员不能查询工作区通知
- [ ] 用户不能标记别人的通知为已读
- [ ] `pnpm typecheck` 和 `pnpm build` 通过

## 延伸思考

1. 用户退出工作区后，历史通知应该删除、隐藏，还是保留？
2. 评论删除后，通知快照是否继续展示原文？
3. 如何为“每十分钟最多一封同任务邮件”设计幂等键？
4. worker 发信成功、更新 `SENT` 前崩溃，如何降低重复邮件概率？
5. 通知达到亿级后，怎样做按月分区、归档和冷热分层？

通知系统的难点不在做一个小铃铛，而在决定哪些事件值得打扰用户，并把数据库、队列和外部服务之间的失败处理清楚。状态含义明确、接收者计算可靠、异步任务可重试且可观测后，接 Web Push、短信或移动端推送都只是增加新的投递通道。

---

[⬅️ Day 51](../day-51/) | [➡️ Day 53](../day-53/)
