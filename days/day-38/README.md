# Day 38 — 消息队列与异步任务

> Day 37 讲 Pub/Sub 时留了一句话：**「必须送达」的任务不能交给 Pub/Sub——它发出去就算完，订阅者那一刻不在线，消息就永久丢了。** 这一天就来兑现另一半：用**消息队列**做「注册成功 → 发一封欢迎邮件」这件事。
>
> 邮件是个典型的不讨喜活：慢（SMTP 往返秒级）、脆（对方网关抽风、被限流）、不关键（用户晚 10 秒收到欢迎信不会怎样，但注册失败他一定走人）。把它从注册主流程里**剥出来**、甩进队列异步处理，是后端「异步解耦」最经典的开局。我们用 **BullMQ**（基于 Redis 的队列库）落地，顺带吃透它相对 Pub/Sub 多出来的那一整层可靠性：**持久化、重试、退避、死信队列、幂等**。

## 📋 今日目标

- 理解**异步解耦**：哪些副作用该从主流程里剥出来，剥出来要付什么代价
- 分清**四种「晚点做」的手段**各自的本事与边界：`setTimeout` / Pub/Sub / 队列 / 定时任务
- 学会 **BullMQ** 的三个角色（Queue 生产者 / Worker 消费者 / Job 任务），知道它们在 Redis 上大致长什么样
- 吃透队列相对 Pub/Sub 多出来的三件套：**重试 + 指数退避**、**死信队列**、**幂等（at-least-once 的必修课）**
- 把队列也当成「可选基础设施」做**优雅降级**——它挂了不能拖垮注册本身

> 配套代码：`solutions/blog/blog-api/`。新增 `src/queue/` 目录：`mail-queue.service.ts`（生产者）、`mail.processor.ts`（消费者 + 死信）、`mail-sender.ts`（真正发信 + 幂等）、`mail-payload.ts`（任务数据）、`queue.module.ts`（@Global）、`queue.constants.ts`；
> `AuthService.register` 成功后异步入队一封欢迎邮件；`AppModule` 引入 `QueueModule`；配置新增 `MAIL_ATTEMPTS` / `MAIL_BACKOFF_MS` / `MAIL_CONCURRENCY` / `MAIL_SENT_TTL`；新增 `test/queue.e2e.test.ts`（投递 / 注册触发 / 重试→死信 / 幂等）。

---

## 📖 核心知识点

### 1. 这天在解决什么：把「不讨喜的副作用」剥出主流程

先看「同步发邮件」为什么不行。假设注册接口里这么写：

```ts
async register(dto: RegisterDto) {
  const user = await this.prisma.user.create({ ... });
  await this.sendWelcomeEmail(user.email);   // ← 同步等 SMTP，秒级
  return this.authResponse(user, ...);
}
```

三个问题，每一个都真实存在：

1. **慢传导给用户**：SMTP 往返常常是几百毫秒到数秒。用户点「注册」，明明用户已经建好了，却要多等一个发信的往返才能拿到 token——而他根本不在乎这封信什么时候到。
2. **故障传导给用户**：发信服务那一刻抽风，`sendWelcomeEmail` 抛错 → 整个注册接口 500。用户其实**已经注册成功**，却看到一个错误页，重试又撞上「邮箱已注册」。一个和注册毫不相干的外部依赖，把核心动作搞崩了。
3. **没法重试**：发信失败就失败了，没有谁会再去试一次。邮件就这么丢了。

异步解耦的解法一句话：**用户只等「把任务塞进队列」这一下（毫秒级），真正发信交给后台 worker 慢慢做。** 用户不等 SMTP；邮件系统挂了，注册照常成功；发信失败，队列自动重试。

```ts
// src/auth/auth.service.ts —— 注册成功后
await this.mail?.enqueue({ kind: 'welcome', to: dto.email, ... });
// ★ 我们 await 的是「入队」（往 Redis 塞一条任务，毫秒级），不是「发信」（秒级，由 worker 异步做）
return this.authResponse(user, await this.tokens.issue(user));
```

代价是什么？得接受两件事：**最终一致**（邮件不是注册成功的瞬间就到，而是「稍后」到）和**引入一套新基础设施**（队列 + worker，要运维、要监控、要处理失败）。对「欢迎邮件」这种容忍延迟和偶发丢失的场景，这笔账很划算；对「扣款」「下单」这种必须强一致的，绝不能这么干——它们要么同步、要么用更重的事务性消息。**异步是权衡，不是银弹。**

### 2. 四种「晚点做」的手段：各自的本事与边界

「把一件事推迟/异步做」在 Redis 生态里有好几种工具，容易混。把它们的差别钉死，选型才不踩坑：

| 手段 | 持久化 | 重试 | 多消费者 | 典型用途 | 本 demo 用没 |
|---|---|---|---|---|---|
| `setTimeout`（进程内定时器） | ❌ 进程重启就没 | ❌ | ❌ | 一次性的小延迟（5 秒后清理临时文件） | ✗ |
| **Pub/Sub**（Day 37） | ❌ 没人接就丢 | ❌ | ✅ 广播 | 实时广播：聊天、缓存失效通知 | ✗ |
| **消息队列**（BullMQ） | ✅ 落 Redis | ✅ + 死信 | ✅ 竞争消费 | **必须送达**的异步任务：发邮件、发短信、生成报表 | ✅ 今天的主角 |
| 定时任务（cron / BullMQ repeat） | — | 看实现 | — | 周期触发：每天凌晨统计、每分钟对账 | ✗ |

记住两个分水岭：

- **Pub/Sub vs 队列**：Pub/Sub 是「**广播**，在线才收到、丢了无所谓」；队列是「**投递**，必须送到、送不到就重试、实在不行进死信等人来捞」。注册邮件要的是后者——用户哪怕在 worker 重启的那一秒注册，邮件也不能丢。
- **队列 vs 定时任务**：队列是「**事件触发**」（注册这个事件 → 发一封信）；定时任务是「**时间触发**」（每天 0 点 → 跑统计）。发欢迎邮件是事件触发的，所以用队列。BullMQ 两者都能做（它有 repeat job），今天只用事件触发这一半。

> Day 37 那句「评论通知异步发送」也属于这一类——有新评论这个**事件**触发通知。本项目还没有评论模块，所以今天用「注册 → 欢迎邮件」做同样的演示，机制完全一样。

### 3. BullMQ 的三个角色，以及它们在 Redis 上长什么样

BullMQ 把队列抽象成三个角色，对应代码里三个文件：

- **Queue（生产者）** —— `mail-queue.service.ts`。业务调它 `add()` 一个任务，就是把任务**塞进队列**。
- **Worker（消费者）** —— `mail.processor.ts`。它后台轮询队列，**拉到一个任务就执行**（这里执行 = 调 `MailSender.send`）。
- **Job（任务）** —— 一个带数据载荷（`MailJobData`）和状态（等待 / 处理中 / 完成 / 失败）的单元。它在几个状态间流转。

这三个角色**都落在 Redis 上**，不依赖应用进程的内存——这正是「持久化」的来源：

```
bull:mail:wait        → List：待处理任务排队在这（生产者 LPUSH 进来）
bull:mail:active      → List：正在被某个 worker 处理的
bull:mail:delayed     → Sorted Set：等退避时间到了才重试的（score = 到点时间戳）
bull:mail:completed   → 完成的（可设保留条数，否则自动清）
bull:mail:failed      → 彻底失败的
bull:mail:<jobId>     → Hash：这条任务的全部数据 + 尝试次数 + 错误信息
```

最关键的一步是「**等待 → 处理中**」的转移：worker 用一条**原子**命令（`BRPOPLPUSH` 这类）从 `wait` 弹一个到 `active`。原子意味着**同一时刻只有一个 worker 能拿到这条任务**——这就是「竞争消费」：多个 worker 副本一起干活，谁也不会重复处理同一条。这也是为什么 worker 崩了重启后能**继续**：任务在 `active` 里没被确认完成，会被「stalled job」机制识别出来、重新放回 `wait` 重做。

> 这套设计和 Day 37 的 Redis 数据结构主题一脉相承：**队列的本质，是用 List（FIFO）+ Sorted Set（延迟）+ Hash（载荷），把「调度」这件事下推成一组原子命令。** BullMQ 只是把它们包成了好用的 API。

### 4. 重试与指数退避：瞬时故障自动兜底

发信失败分两种：**瞬时故障**（网关短暂抽风、网络抖动）和**永久故障**（邮箱根本不存在、被拉黑）。前者过一会就好——队列的价值就是「**自动再试一次**」，不用人工介入。

BullMQ 在 `add()` 时配两个旋钮：

```ts
// src/queue/mail-queue.service.ts
await this.getQueue().add(mail.kind, mail, {
  jobId: mail.idempotencyKey,                       // 入队侧去重（见 §6）
  attempts: this.attempts,                          // 含首次在内最多尝试 N 次
  backoff: { type: 'exponential', delay: this.backoffMs },  // 指数退避
  removeOnComplete: 100,                            // 完成的留最近 100 条便于观测
  removeOnFail: false,                              // 失败的不自动删（要转死信）
  ...opts,                                          // 测试可塞小退避加速
});
```

- **`attempts`**：总共试几次。`attempts: 3` = 首次 + 2 次重试。
- **`backoff`**：两次之间等多久。**指数退避**（`exponential`）比固定间隔更优——第 n 次重试约等 `delay × 2^(n-1)`（默认 1s → 2s → 4s）。它给下游**逐步恢复的时间**，也不会一上来就高频重试把对方打得更死。退避的任务会先进 `delayed`（Sorted Set，score=到点时间），时间到了才回到 `wait`。

worker 消费时，`MailSender.send` 抛错 → BullMQ 接住 → 没到 attempts 就排进 `delayed` 等退避 → 到点重试。这整条链路是 BullMQ 内建的，业务代码只管「成功就正常返回、失败就抛」。

```ts
// src/queue/mail.processor.ts
this.worker = new Worker<MailJobData>(MAIL_QUEUE, async (job) => {
  await this.sender.send(job.data);   // 抛错 → BullMQ 自动重试；耗尽 → failed 事件（见 §5）
}, { connection, concurrency: this.concurrency });
```

### 5. 死信队列（DLQ）：重试耗尽后的「安置点」

如果重试到 `attempts` 次还是失败，说明大概率是**永久故障**（邮箱不存在、被拒收），再试也是浪费。这时候任务需要被人「看见」——而不是静悄悄烂在角落里。这就是**死信队列（Dead-Letter Queue, DLQ）**：一条专门收容「彻底失败任务」的队列，和正常待处理任务分开，方便人工排查 / 修复后补偿重放。

我们的实现：worker 监听 `failed` 事件，在**最后一次失败**时把任务转进 DLQ：

```ts
// src/queue/mail.processor.ts
this.worker.on('failed', async (job, err) => {
  if (!job) return;
  const maxAttempts = job.opts.attempts ?? 1;
  if (job.attemptsMade >= maxAttempts) {
    // 转死信：用原 jobId 去重，事件重放也不会在死信里塞重复条目
    await this.dlq?.add(job.name, job.data, { jobId: job.id });
    this.logger.error(`邮件重试 ${maxAttempts} 次仍失败，转入死信队列：${job.data.to}`);
  } else {
    this.logger.warn(`邮件第 ${job.attemptsMade}/${maxAttempts} 次失败，将退避重试`);
  }
});
```

一个细节要想清楚：`failed` 事件在**每次**失败时都触发（不只是最后一次）。所以转死信前必须判断 `attemptsMade >= attempts`，否则每次普通失败都往死信里塞一份，死信会被正常重试的中间态污染。

> BullMQ 自身其实会把彻底失败的任务留在原队列的 `failed` 集合里——那也是个「死信」的去处。我们额外开一条独立的 `mail-dead-letter` 队列，是因为它更符合「死信队列」的惯用形态：**一条干净的、可单独消费/重放的入口**，和正常队列的 failed 杂项分开。两者并存不冲突：failed 集合是 BullMQ 的内部账，DLQ 是你主动圈出来的「待办」。

DLQ 上的任务怎么处理？现实里通常是：接告警 → 人工看错误原因 → 修数据后把任务重投回主队列（「补偿」），或者确认是垃圾邮箱后丢弃。本项目 DLQ 没有消费者，纯粹是个「安置 + 可观测」层。

### 6. 幂等：at-least-once 投递的必修课

这是队列最容易踩、也最容易被忽略的坑。**消息队列默认是 at-least-once（至少一次）投递**——同一条任务可能被处理多次：

- worker 处理到一半崩了，重启后 stalled 机制把任务**重放**；
- 网络抖动触发**重试**；
- 多个 worker 副本在极端时序下都认为「这条归我」（虽有原子 pop 兜底，边界情况仍可能出现）。

对「发邮件」这种有副作用的动作，处理两次 = 用户收两封。所以**消费者必须幂等**：同一条任务处理多少次，效果都等于处理一次。

我们的幂等靠 Redis 的 `SET NX`——**正是 Day 37 分布式锁用过的同一个原语**，换个语义：「锁」是互斥执行，这里是「互斥发送」。`MailSender.send` 发送前先占坑：

```ts
// src/queue/mail-sender.ts
async send(mail: MailJobData): Promise<boolean> {
  const sentKey = `mail:sent:${mail.idempotencyKey}`;
  // ① 原子占坑。true = 我是第一个；false = 已发过 → 跳过
  const mine = await this.redis.setNx(sentKey, '1', this.sentTtl);
  if (!mine) return false;                          // 命中幂等，不重发
  try {
    this.simulateSmtp(mail);                        // 真正「发送」（demo 只打日志）
    this.deliveredCount.set(mail.idempotencyKey, ...);
    return true;
  } catch (e) {
    await this.redis.del(sentKey);                  // ★ 失败要让出占坑
    throw e;                                        // 抛出 → BullMQ 重试
  }
}
```

这里有个**反直觉但关键**的细节：**失败时必须 `del` 掉占坑**。因为占坑是在「发送之前」设的——如果占了坑、发送却抛错，不释放的话，重试时占坑还在，被误判成「已发」而永远跳过，邮件就**丢了**。坑只有在**发送成功后**才保留（实现 at-least-once → effectively-once）。这套「占坑 → 干活 → 失败回退」的形态，和分布式锁的 `acquire → 临界区 → release` 一模一样。

幂等还分两层兜底，各挡一种重复：

- **入队侧（jobId 去重）**：`add()` 时设 `jobId = idempotencyKey`。同一事件并发触发两次入队（比如用户疯狂双击注册），BullMQ 识别到 jobId 重复，第二条被忽略——**任务压根没产生两条**。
- **消费侧（SET NX）**：哪怕产生了两次、或重试/重放导致同一条被处理多次，发送时占坑保证**只发一次**。

两层叠加，才扛得住 at-least-once 下各种「重」的场景。幂等键怎么生成？稳定、可复算的 `<kind>_<实体 id>`，如 `welcome_<userId>`——重放同一个注册事件，得到的是同一个键。

### 7. 优雅降级：队列也是「可选基础设施」

延续 Day 36/37 的哲学——**Redis 是真相源之外的辅助层，挂了只降级、不拖垮主流程**。队列同样如此：邮件系统本来就是「最好能发」，注册能不能成功跟它无关。所以生产者 `enqueue` 做了两层兜底：

```ts
// src/queue/mail-queue.service.ts
async enqueue(mail: MailJobData, opts?: JobsOptions): Promise<void> {
  if (!this.redis.available) {                       // ① Redis 不通：直接跳过，不入队
    this.logger.warn(`Redis 不可用，跳过入队：${mail.kind} → ${mail.to}`);
    return;
  }
  try {
    await this.getQueue().add(mail.kind, mail, { ... });  // ② add 出错：吞掉，不抛
  } catch (e) {
    this.logger.warn(`入队失败（已忽略）${mail.to}：${e.message}`);
  }
}
```

`enqueue` **永不抛错**。它是 fire-and-forget 的一环——Redis 挂了、入队异常，注册照样返回 201。邮件可能晚到或丢，但这不影响「创建用户」这个核心动作的成功。这正是 §1 说的「故障不传导」。

消费者（worker）那边有个**必须做**的事，否则降级反而变灾难：**每个 Queue / Worker 都得接 `error` 事件**。BullMQ 把底层连接的错误**原样转发**到 Queue/Worker 上——没人接的话，Node 会因「未处理的 `error` 事件」**直接崩溃进程**（这正是 Day 36 `RedisService` 里那个「必须接住 error 事件」的同一个坑）：

```ts
// src/queue/mail.processor.ts
this.worker = new Worker<MailJobData>(MAIL_QUEUE, processor, { connection, concurrency });
// ★ 必接：不接，连接错误会让整个进程崩
this.worker.on('error', (e) => this.logger.warn(`邮件 worker 连接错误：${e.message}`));
```

worker 在模块初始化时**无条件启动**：连不上 Redis 时 BullMQ 自己重连（自愈），错误被 handler 接住不崩；Redis 恢复后 worker 自动恢复消费。这样既不踩「启动那一刻 Redis 还没连上」的时序坑（不用在 `onModuleInit` 里 `ping` 探活，避免探活那一刻连接还没就绪的误判），也保证可用性。

### 8. 一个真实踩到的坑：队列名 / jobId 不能含冒号

这是本 demo 开发时**实打实踩到、靠报错才发现**的坑，值得单独记一笔——因为它把「BullMQ 的命名为什么有这条规矩」讲透了。

最初我把死信队列命名成 `mail:dead-letter`、幂等键命名成 `welcome:<userId>`，结果 BullMQ 直接拒绝：

```
Queue name cannot contain :
Custom Id cannot contain :
```

原因正是 §3 讲的 key 结构：队列 `mail` 的任务存成 `bull:mail:<jobId>`，队列名 / jobId 里再有冒号，就和这个 key 命名空间**撞车**——BullMQ 没法区分 `bull:mail:dead-letter` 到底是队列 `mail` 的某条任务、还是队列 `mail-dead-letter` 的元数据。所以库干脆**禁掉**队列名和 jobId 里的冒号（jobId 还禁止纯整数）。

修法是用别的分隔符：死信队列叫 `mail-dead-letter`、幂等键用 `welcome_<userId>`（下划线还能和 UUID 自带的连字符区分开，更清晰）。`mail:sent:<key>` 这种**普通 Redis key**照常用冒号——禁令只针对 BullMQ 的队列名和 jobId。

> 教训：**给库挑标识符前，先看清它的命名规则。** BullMQ 的禁令不是矫情，是「key 拼接」这种实现细节外溢成的约束。这种坑文档里通常一句话带过，实际写错时是「明明配了却一动不动」的静默失败，最容易让人懵。

### 9. 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `src/queue/queue.constants.ts` | **新增**：队列名常量。`mail`（主队列）、`mail-dead-letter`（死信）、`mail:sent:`（幂等标记前缀） |
| `src/queue/mail-payload.ts` | **新增**：`MailJobData` 任务载荷 + 幂等键说明 |
| `src/queue/mail-sender.ts` | **新增**：真正发信者。`SET NX` 幂等占坑、失败回退、`@fail.test` 模拟故障、`deliveredCount` 观测 |
| `src/queue/mail-queue.service.ts` | **新增**：生产者。懒建 Queue、`enqueue` 永不抛错（`available` 预检 + try/catch）、`jobId` 去重、重试 + 指数退避 |
| `src/queue/mail.processor.ts` | **新增**：消费者。`Worker` 轮询、并发、`failed`→死信、`error` handler 接住防崩、无条件启动自愈 |
| `src/queue/queue.module.ts` | **新增**：`@Global` 模块，只导出 `MailQueueService`（worker/sender 是内部细节） |
| `src/auth/auth.service.ts` | `register` 成功后 `await this.mail?.enqueue(welcome)`；新增 `@Optional() mail` 形参 |
| `src/app.module.ts` | 引入 `QueueModule` |
| `src/config/{configuration,config.validation}.ts` | 新增 `queue` 配置块：`MAIL_ATTEMPTS` / `MAIL_BACKOFF_MS` / `MAIL_CONCURRENCY` / `MAIL_SENT_TTL`，都有默认值 |
| `.env.example` | 文档化四个新环境变量 |
| `test/queue.e2e.test.ts` | **新增**：正常投递 / 注册触发 / 重试→死信 / 幂等四个用例 |

### 10. 一份诚实清单

✅ **今天到位的：**
- 异步解耦：注册主流程不再被发信阻塞 / 连累，`enqueue` 永不抛错
- BullMQ 三角色落地（Queue / Worker / Job），复用缓存同一个 Redis
- 重试 + 指数退避（`attempts` + `backoff`），瞬时故障自动兜底
- 死信队列：重试耗尽转 `mail-dead-letter`，只转最后一次（`attemptsMade` 判断）
- 幂等：入队侧 `jobId` 去重 + 消费侧 `SET NX` 占坑（失败回退），扛 at-least-once
- 优雅降级：队列挂了不影响注册；`error` 事件全接住防崩

⚠️/❌ **还没做、明确知道的缺口：**
- **真发信**：`MailSender` 只是打日志（`@fail.test` 模拟故障），没接 nodemailer / SES / SendGrid
- **DLQ 没有消费者 / 没有告警**：死信队列只是「安置点」，没有自动补偿、没有超出阈值就告警的机制
- **SET NX 的歧义**：`RedisService.setNx` 出错时也返回 `false`，和「已存在」混在一起——演示够用，严格幂等要换成能区分「已存在」和「出错」的方式（或落一张幂等表 + 唯一约束）
- **没有延迟任务 / 定时任务**：BullMQ 的 `repeat` job（每天统计、下单 30 分钟未付款自动取消）今天没碰
- **背压 / 限流没做**：入队不限速，突发流量会把队列灌爆、下游 SMTP 被打挂；生产该配 `rateLimit` 或在 worker 侧限速
- **优先级 / 分流**：所有邮件一条队列、一个优先级；真实场景里「密码重置」该比「营销邮件」优先，要用 BullMQ 的优先级或分多队列
- **可观测性停在日志**：没有接队列长度、处理时延、失败率的指标（Prometheus）和看板

---

## 💻 实践练习

1. **看一次正常投递**：起服务，注册一个用户，看日志里 worker 打出 `📧 已发送 [welcome] → ...`。`docker exec redis-blog redis-cli KEYS 'mail:sent:*'` 亲眼看幂等标记，`redis-cli KEYS 'bull:mail:*'` 看队列在 Redis 上的 key 结构。
2. **触发重试 → 死信**：直接调 `MailQueueService.enqueue`，把 `to` 设成 `broken@fail.test`、`attempts: 3`、`backoff: { type: 'fixed', delay: 50 }`（小退避加速）。观察日志：先打两次「将退避重试」，再打「重试 3 次仍失败，转入死信队列」。然后 `processor.deadLetterCount()` 应 ≥ 1。
3. **验证幂等**：对同一个 `idempotencyKey` 连续调两次 `MailSender.send`——第一次返回 `true`（真发了），第二次返回 `false`（命中幂等跳过）；`mail:sent:<key>` 只被写一次。
4. **验证降级**：停掉 Redis 容器，再注册一个用户——注册应照常返回 201（日志里是「Redis 不可用，跳过入队」），证明队列故障不传导。重启 Redis 后 worker 自愈恢复消费。
5. **思考题**：如果 `MailSender.send` 在「占坑成功、发送成功、但还没来得及写日志」之间进程被 `kill -9`，下次 worker 重放这条任务会发生什么？邮件会不会重发？为什么？（提示：占坑已经设上、TTL 还在 → 重放时 `SET NX` 返回 `false` → 跳过 → **不重发**。这正是「占坑在发送前设、成功后保留」的用意——它把「发送成功但进程没记账」也纳入了幂等保护。代价是：万一发送其实失败但占坑已设，这条会被误判「已发」而不再重试。这就是 at-least-once 下「宁可漏发不可重发」与「宁可重发不可漏发」的取舍——选哪种，取决于业务对「重复」和「丢失」哪个更敏感。）

---

## ✅ 今日产出

- [ ] 完成核心知识点学习（异步解耦 / 四种手段对比 / BullMQ 三角色 / 重试·退避 / 死信 / 幂等 / 降级）
- [ ] 跑通 `queue.e2e.test.ts`，用 `redis-cli` 亲眼看 `bull:mail:*` 的 key 结构和 `mail:sent:*` 幂等标记
- [ ] 在笔记里写下「我的项目里哪些副作用该剥进队列、哪些该用 Pub/Sub、哪些该用定时任务」
- [ ] 提交代码到 GitHub

---

[⬅️ Day 37](../day-37/) | [➡️ Day 39](../day-39/)
