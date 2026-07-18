# Day 53 — 数据看板与统计

前几天完成了任务、实时协作和通知。数据已经不断写进 PostgreSQL，今天要回答的是另一类问题：

- 团队现在有多少任务，真正完成了多少？
- 最近 30 天的完成趋势是在上升还是下降？
- 工作集中在谁身上，有没有人明显过载？
- 哪个项目推进顺利，哪个项目已经积压？

这些问题看起来只是“数一数”，真正做起来会碰到指标口径、历史时间、空日期、时区、权限和查询性能。统计系统最危险的结果不是报错，而是返回一个看起来合理、实际口径错误的数字。

## 今日目标

- 为任务补充可靠的完成时间语义
- 使用 PostgreSQL 条件聚合完成统计查询
- 使用 `generate_series` 生成连续趋势日期
- 实现团队工作量和项目进度 API
- 处理零任务成员、未分配任务和已离开成员
- 理解统计口径、时区、索引和预聚合的取舍

## 1. 先定义问题，再写 SQL

“完成率”没有唯一答案。下面三种算法都能叫完成率：

```text
DONE / 全部任务
DONE / (全部任务 - CANCELLED)
本周期完成数 / 本周期创建数
```

它们回答的问题不同。本项目采用第二种：

```text
完成率 = DONE / (全部任务 - CANCELLED)
```

取消的任务不再需要完成，因此从分母排除；`BACKLOG` 仍在分母中，因为它只是尚未开始，并没有退出交付范围。

“逾期”也要有明确口径：

```sql
due_date < now()
AND status NOT IN ('DONE', 'CANCELLED')
```

已经完成或取消的任务即使截止时间在过去，也不应继续出现在当前逾期数里。

写统计接口前，最好先做一张指标字典：

| 指标 | 定义 | 是否排除软删除 | 时间口径 |
| --- | --- | --- | --- |
| 总任务数 | 当前范围内全部任务 | 是 | 当前快照 |
| 完成数 | 当前状态为 `DONE` | 是 | 当前快照 |
| 完成趋势 | 每天进入 `DONE` 的任务数 | 是 | UTC 自然日 |
| 逾期数 | 到期且未完成、未取消 | 是 | 查询时刻 |
| 未分配数 | `assigneeId IS NULL` | 是 | 当前快照 |

指标口径应该由后端统一提供。不能让 Web、移动端和导出脚本各自实现一套，否则同一个工作区会出现三个不同的完成率。

## 2. 为什么 updatedAt 不能当完成时间

Day 52 之前，`Task` 只有 `createdAt` 和 `updatedAt`。一个常见但错误的趋势查询是：

```sql
SELECT date_trunc('day', updated_at), count(*)
FROM tasks
WHERE status = 'DONE'
GROUP BY 1;
```

任务周一完成，周三改了标题，`updatedAt` 就变成周三。看板会误以为任务周三才完成。统计历史被一次普通编辑重写了。

因此今天增加：

```prisma
completedAt DateTime? @map("completed_at") @db.Timestamptz(3)
```

维护规则只有三条：

1. 创建时状态就是 `DONE`，立即写完成时间；
2. 从其他状态进入 `DONE`，写当前时间；
3. 从 `DONE` 重新打开，清空完成时间。

```ts
function completedAtForStatusChange(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return undefined;
  if (nextStatus === "DONE") return new Date();
  if (currentStatus === "DONE") return null;
  return undefined;
}
```

这里 `undefined` 和 `null` 的意义不同：

- `undefined`：不修改原值；
- `null`：明确清空原值。

Prisma 更新语句里，这个区别非常重要。

### completedAt 能回答所有历史问题吗

不能。它只能保存“当前这次完成”的时间。任务完成、重开、再次完成后，第一次完成时间会被覆盖。

如果产品要分析每次状态变化、流转耗时、返工次数，就应该增加不可变的事件表：

```prisma
model TaskStatusEvent {
  id         String     @id @default(uuid())
  taskId     String
  fromStatus TaskStatus
  toStatus   TaskStatus
  actorId    String
  createdAt  DateTime   @default(now())
}
```

Day 53 的目标是当前完成趋势，`completedAt` 足够；流程分析属于事件历史模型，不应该强塞进同一个字段。

## 3. OLTP 和统计查询的差别

日常任务接口属于 OLTP：

- 按 ID 查一条任务；
- 更新一条记录；
- 创建评论；
- 要求低延迟和明确事务。

统计查询更接近 OLAP：

- 扫描一批任务；
- 分组、聚合、计算比例；
- 关注时间范围和维度；
- 一次返回用于决策的摘要。

当前数据量不大，可以继续在主 PostgreSQL 上统计。随着数据增长，演进路线通常是：

```text
主库实时聚合
  -> Redis 短缓存
  -> 汇总表 / 物化视图
  -> 只读副本
  -> 数仓与 BI
```

不要一开始就上数仓，也不要等主库被统计查询拖慢才想办法。用 `EXPLAIN ANALYZE` 和真实数据量决定什么时候升级。

## 4. 条件聚合：一次扫描得到整张总览

最直接的写法会发很多条 SQL：

```ts
await prisma.task.count({ where: { status: "DONE" } });
await prisma.task.count({ where: { status: "TODO" } });
await prisma.task.count({ where: { assigneeId: null } });
```

它容易读，但数据库需要重复解析、规划和扫描。PostgreSQL 的 `FILTER` 可以在一次扫描中计算多项指标：

```sql
SELECT
  COUNT(t.id)::int AS total,
  (COUNT(t.id) FILTER (WHERE t.status = 'DONE'))::int AS done,
  (COUNT(t.id) FILTER (WHERE t.status = 'TODO'))::int AS todo,
  (
    COUNT(t.id) FILTER (
      WHERE t.due_date < now()
        AND t.status NOT IN ('DONE', 'CANCELLED')
    )
  )::int AS overdue,
  (COUNT(t.id) FILTER (WHERE t.assignee_id IS NULL))::int AS unassigned
FROM tasks t;
```

`FILTER` 比多层 `SUM(CASE WHEN ...)` 更容易读，含义也更直接。两者通常会得到相近的执行计划。

为什么显式写 `::int`？PostgreSQL 的 `COUNT` 返回 `bigint`。JavaScript 的普通 number 不能安全表示任意 64 位整数，Prisma 也可能把结果映射成 `BigInt`，JSON 序列化会失败。仪表盘计数在 int 范围内时，数据库边界直接转成 `int` 能让 API 类型稳定。

如果业务可能超过 21 亿条，则不该强转，而应在 API 层把 `BigInt` 转成字符串。

## 5. 工作区范围必须写进 SQL

统计查询使用原生 SQL 后，Prisma 不会自动替你补工作区条件。每条查询都必须从工作区范围开始：

```sql
WHERE p.workspace_id = $1::uuid
  AND p.deleted_at IS NULL
  AND t.deleted_at IS NULL
```

调用原生 SQL 前仍要执行成员校验：

```ts
const { workspace } = await requireMembership(
  prisma,
  currentUser.id,
  workspaceSlug,
);
```

项目筛选不能只按 `projectKey`，因为不同工作区允许使用相同 key。正确关系是：

```text
当前用户属于工作区
  -> 项目属于这个工作区
    -> 任务属于这个项目
```

漏掉任意一层，都可能让统计数字跨工作区串数据。

## 6. 参数化 SQL，不拼接字符串

可选项目范围通过 `Prisma.sql` 生成：

```ts
function projectFilter(projectId: string | null) {
  return projectId
    ? Prisma.sql`AND p.id = ${projectId}::uuid`
    : Prisma.empty;
}
```

这里参数会通过数据库驱动绑定，不会作为 SQL 文本执行。不能这样写：

```ts
const sql = "AND p.id = '" + projectId + "'";
```

字符串拼接既有注入风险，也会降低执行计划复用率。

还有一个真实的类型细节：Prisma 原生查询会把 JavaScript 整数参数发送成 `bigint`，而 PostgreSQL 没有 `date - bigint` 运算符。因此日期减动态天数时要显式转型：

```sql
timezone('UTC', now())::date - $1::int
```

这类问题 TypeScript 检查不出来，必须让 SQL 在真实 PostgreSQL 上执行。

## 7. 完成趋势：空白日期也必须返回

只按完成记录分组：

```sql
SELECT completed_at::date, count(*)
FROM tasks
GROUP BY 1;
```

没有任务完成的日期不会出现。前端拿到 `7 月 1 日、7 月 3 日` 两点，可能把折线直接连起来，却不知道 7 月 2 日应该是 0。

正确做法是先生成完整日期轴，再左连接完成记录：

```sql
WITH days AS (
  SELECT generate_series(
    timezone('UTC', now())::date - 6,
    timezone('UTC', now())::date,
    interval '1 day'
  )::date AS day
)
SELECT
  to_char(days.day, 'YYYY-MM-DD') AS date,
  COUNT(tasks.completed_at)::int AS completed
FROM days
LEFT JOIN tasks
  ON tasks.completed_at >= days.day::timestamp AT TIME ZONE 'UTC'
 AND tasks.completed_at < (days.day + 1)::timestamp AT TIME ZONE 'UTC'
GROUP BY days.day
ORDER BY days.day;
```

`generate_series` 负责生成 7、30 或 90 个连续日期，`LEFT JOIN` 保证没有匹配记录时仍保留日期，`COUNT(column)` 对空连接结果返回 0。

### 为什么不用 date(completed_at) 比较

下面的写法容易让索引失效：

```sql
WHERE date(completed_at) = '2026-07-18'
```

它对每一行先调用函数。范围条件更适合普通 B-tree 索引：

```sql
completed_at >= '2026-07-18 00:00:00+00'
AND completed_at <  '2026-07-19 00:00:00+00'
```

“左闭右开”也避免了 `23:59:59.999` 这种精度边界问题。

## 8. 时区：趋势图最容易差一天

数据库字段使用 `timestamptz`，保存的是绝对时刻；“哪一天”却取决于时区。

同一个时间：

```text
2026-07-18 23:30 UTC
2026-07-19 07:30 Asia/Shanghai
```

本次 API 明确以 UTC 自然日统计，并在响应中返回：

```json
{
  "timezone": "UTC",
  "days": [
    { "date": "2026-07-18", "completed": 3, "cumulative": 3 }
  ]
}
```

前端不能把这里的日期再次当瞬时时间做本地时区转换。`YYYY-MM-DD` 是统计分桶标签。

如果产品需要按工作区时区统计，应在 `Workspace` 保存 IANA 时区，例如 `Asia/Shanghai`，并在 SQL 中使用该时区生成边界。不要依赖数据库服务器当前时区，它可能随部署环境变化。

## 9. 团队工作量：从成员表出发

只从任务分组会漏掉任务数为 0 的成员：

```sql
SELECT assignee_id, count(*)
FROM tasks
GROUP BY assignee_id;
```

工作量看板需要同时看到“过载”和“空闲”，所以查询从成员集合出发，左连接任务统计：

```text
members
  LEFT JOIN task_stats
```

并用 `COALESCE` 将空值变成 0：

```sql
COALESCE(task_stats.total, 0)::int AS total
```

另外还有两种特殊行：

- `Unassigned`：`assignee_id IS NULL` 的任务；
- 历史成员：已经不在成员表中，但仍有任务挂在他名下。

如果忽略历史成员，工作量各行求和会小于总览任务数。这种“分项加起来对不上总数”的问题，会直接破坏用户对看板的信任。

本次 API 同时返回：

- `sharePercent`：该成员任务占全部任务的比例；
- `completionRate`：该成员已完成任务占本人任务的比例；
- `inProgress`：`IN_PROGRESS + IN_REVIEW`；
- `overdue`：本人当前逾期任务数。

工作量数字用于发现分配风险，不应该直接用来评价个人绩效。任务大小、难度、协作成本都不相同，单纯比较任务数量很容易制造错误激励。

## 10. 项目进度

项目进度接口按项目返回：

```json
{
  "key": "API",
  "total": 40,
  "backlog": 8,
  "active": 15,
  "done": 12,
  "cancelled": 5,
  "overdue": 3,
  "completionRate": 34.3
}
```

其中：

```text
active = TODO + IN_PROGRESS + IN_REVIEW
completionRate = done / (total - cancelled)
```

`BACKLOG` 单独返回，便于区分“已经开始推进”和“还在需求池里”。归档项目仍会返回 `archivedAt`，前端可以默认折叠，但不应悄悄从历史统计中消失。

## 11. 本次 API

所有接口位于 `analytics` tRPC router：

| Procedure | 参数 | 返回 |
| --- | --- | --- |
| `analytics.overview` | 工作区、可选项目、7-90 天 | 总数、状态分布、完成率、逾期等 |
| `analytics.completionTrend` | 工作区、可选项目、7-90 天 | 连续日期完成趋势 |
| `analytics.workload` | 工作区、可选项目 | 成员和未分配工作量 |
| `analytics.projectProgress` | 工作区、可选项目 | 各项目进度 |

所有接口都支持 `projectKey`。不存在的项目返回 404，而不是返回一组看似正常的 0，避免调用方把输入错误误认为“项目没有数据”。

示例：

```bash
curl -b /tmp/saas-cookie.txt --get +  "http://localhost:3000/api/trpc/analytics.completionTrend" +  --data-urlencode 'input={"json":{"workspaceSlug":"acme-team","days":30}}'
```

只看 `ENG` 项目：

```bash
curl -b /tmp/saas-cookie.txt --get +  "http://localhost:3000/api/trpc/analytics.overview" +  --data-urlencode 'input={"json":{"workspaceSlug":"acme-team","projectKey":"ENG","days":30}}'
```

## 12. 索引与查询计划

今天新增两条任务索引：

```prisma
@@index([projectId, completedAt])
@@index([projectId, dueDate])
```

工作区统计先找到项目，再按项目读取任务，因此联合索引以 `projectId` 开头。完成趋势继续按时间范围筛选，`completedAt` 放第二列。

索引是否有效不能靠猜，使用：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT ...
```

重点看：

- 实际扫描行数和预估是否相差巨大；
- 是 `Index Scan`、`Bitmap Index Scan` 还是 `Seq Scan`；
- 排序有没有落盘；
- 哪个节点耗时最高；
- shared read 表示多少数据真正从磁盘读取。

小表出现顺序扫描是正常的。读取几百行时，扫表可能比走索引更便宜。不要为了让计划里出现 “Index” 而强迫数据库使用索引。

## 13. 什么时候需要缓存或预聚合

实时聚合的优点是数据新鲜、实现简单，缺点是每次打开仪表盘都要扫描任务。

第一步可以给统计响应加 30-60 秒 Redis 缓存。缓存键必须包含：

```text
workspaceId + projectId + days + timezone + metricVersion
```

`metricVersion` 很重要：修改完成率口径后递增版本，旧缓存自然失效。

数据再大时使用日汇总表：

```prisma
model DailyTaskMetric {
  workspaceId String
  projectId   String?
  date        DateTime
  completed   Int
  created     Int
  overdue     Int
}
```

worker 每天或每小时增量更新。仪表盘扫描几十行汇总数据，不再扫描几百万条任务。

预聚合的代价是最终一致性和修正机制。任务被恢复、删除或补录时，历史汇总可能需要重算。因此汇总任务必须可重复执行，不能只会“在原值上加一”。

## 14. 迁移旧数据

新增 `completedAt` 后，历史 `DONE` 任务需要回填。最朴素的迁移是：

```sql
UPDATE tasks
SET completed_at = updated_at
WHERE status = 'DONE'
  AND completed_at IS NULL;
```

这是近似值，因为旧模型没有保存真正的完成时刻。迁移文档要明确这种数据质量限制，不能把估算值描述成精确历史。

大表不要一次更新全部行。应按主键或时间分批执行，观察 WAL、复制延迟和锁等待，再创建索引。生产迁移通常是：

1. 增加可空列；
2. 发布双写代码；
3. 分批回填；
4. 创建索引；
5. 校验空值和统计结果。

## 15. 验收清单

- [ ] 创建 `DONE` 任务时写入 `completedAt`
- [ ] 任务进入 `DONE` 时写入完成时间
- [ ] 从 `DONE` 重新打开时清空完成时间
- [ ] 总览各状态之和等于总任务数
- [ ] 完成率排除 `CANCELLED`，但包含 `BACKLOG`
- [ ] 7 天趋势始终返回 7 个点，空日期为 0
- [ ] 工作量包含零任务成员、未分配任务和历史成员
- [ ] 工作量各行总数与总览任务数一致
- [ ] 项目进度各项目总数之和与工作区总数一致
- [ ] 项目筛选不会跨工作区
- [ ] 非成员无法读取统计数据
- [ ] `pnpm typecheck` 和 `pnpm build` 通过

## 延伸思考

1. 完成后又重开的任务，应该从历史完成趋势中消失，还是保留第一次完成事件？
2. 按成员统计时，子任务、任务权重和协作任务怎样计算更公平？
3. 用户选择本地时区后，夏令时切换日的 23 小时或 25 小时怎样分桶？
4. 统计缓存应该在任务变化时主动失效，还是接受一分钟的最终一致？
5. 汇总表重算时，怎样保证读请求不会看到一半新、一半旧的数据？

统计接口写到最后，最重要的不是 SQL 有多复杂，而是同一个数字在任何时间、任何客户端、任何数据规模下都保持相同含义。口径先于图表，数据事实先于聚合，真实执行计划先于性能猜测。

---

[⬅️ Day 52](../day-52/) | [➡️ Day 54](../day-54/)
