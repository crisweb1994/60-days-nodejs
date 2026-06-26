# Day 45 — 日志、监控与健康检查

> Day 44 把应用推上了公网：Fly/Railway 跑着同一个镜像，托管 PG/Redis 接好了，域名 HTTPS 也有了。但那天收尾时我留了一句实话——**「今天只有平台级健康检查和重启，结构化日志、错误上报、指标告警，是明天的主题。」** 这一天就是来兑现这句话的。
>
> 把「可观测性」想成给系统装仪表盘：之前你能 `curl /health` 知道「它活着」，但一次 500 报上来，你面对的是**文本日志里的一行散文**——既没法按字段过滤，也没法跨请求串起来，更不会主动告诉你「这个错误从哪个版本开始、今天发生了多少次、影响了哪些用户」。这一天做三件事：把日志从「写给人看的字符串」变成「写给机器查的结构化字段」，并用 requestId 把一条请求的全程日志串起来；把 Day 42 搭好的健康检查（liveness / readiness）讲透——为什么非得拆成两个；再接上 Sentry，让 5xx 从「你在日志里捞」变成「它主动推到你面前」。

## 📋 今日目标

- 吃透**结构化日志**：为什么 `console.log` / 字符串拼接在生产是反模式，字段式 JSON 解决了什么
- 用 **Pino** 落地结构化日志：开发期人类可读、生产期机器可解析，并配**日志脱敏**
- 用 **requestId + AsyncLocalStorage（CLS）** 把「一条请求的全程日志」自动关联起来——service 拿不到 `req`，日志照样带上它的身份
- 把 Day 42 搭好的 **liveness vs readiness** 健康检查讲死：两种探针的本质、它们在编排器里的不同动作、以及「就绪该不该查 Redis」那个真实权衡
- 接 **Sentry 错误上报**：`captureException` + request 上下文 + requestId，让 5xx 主动聚合到面前；并说清为什么只推 5xx、不推 4xx
- 建立可观测性的**全景认知**：logs / metrics / traces 三件套各回答什么问题，今天做了哪一块、还差哪两块

> 配套代码：`solutions/blog/blog-api/`。**新增** `src/observability/` 模块（`logger.ts` 单例 pino + CLS requestId 关联、`structured-logger.service.ts` 字段式注入服务、`sentry.ts` 守卫式 init、`error-reporter.ts` 抽象上报 + Sentry 实现）；
> `request-context.ts`（CLS）加 `requestId` 字段，`RequestIdMiddleware` 把 id 写进 CLS；`HttpLoggerMiddleware` / `TimingInterceptor` / `AllExceptionsFilter` / `BusinessExceptionFilter` 全部从字符串日志升级为**结构化字段**；
> `main.ts` 调 `initSentry`，`AllExceptionsFilter` 在 5xx 时推 Sentry（4xx 不推）；config 加 `LOG_LEVEL` / `SENTRY_*`；新增 `test/observability.{unit,e2e}.test.ts`（结构化 JSON 形状 / CLS 关联 / 脱敏 / 5xx 才推 Sentry / boom 端点 500 安全文案）。

---

## 📖 核心知识点

### 1. 这天在解决什么：从「跑起来」到「出事能查」

先把 Day 44 留的「可观测缺口」摆出来，对照今天怎么补：

| Day 44 的状态 | 出事时你会卡在哪 | Day 45 怎么补 |
|---|---|---|
| 日志是 Nest 默认的**文本**（`HttpLoggerMiddleware` 还在拼字符串） | `grep "POST /posts"` 捞到一堆行，但想「按状态码过滤」「按耗时排序」做不到 | **结构化日志（Pino）**：每行是 JSON，按字段 grep/jq/聚合 |
| 一条请求经 controller→service→filter，日志**散落各处、互不关联** | 一个 500 报上来，你不知道它对应访问日志里的哪一行 | **requestId + CLS**：整条链路的日志自动带上同一个 id |
| 异常只在日志里打栈，**没人主动告诉你** | 「这个错今天发生了 200 次」要等用户投诉、自己去数 | **Sentry captureException**：5xx 主动推到聚合平台，按版本/环境聚合 |
| 健康检查只有 Day 42 的 `/health` + `/health/ready` | 知道「能用」，但**为什么这么拆**没讲透 | 把 **liveness vs readiness** 的本质、编排器动作、就绪边界讲死 |
| 没有指标 / 没有分布式追踪 | 「接口慢」只能看日志里的 `durationMs`，看不到趋势、跨服务链路 | 讲清 **logs/metrics/traces 三件套**，今天做 logs，另两块留下 |

带着这张表读后面，会发现可观测性的核心就一句话：**把「跑起来时被默认值糊过去的事」（日志长什么样、错误谁去捞、健康怎么判）逐个换成出事时能查的明确形态。**

### 2. 先想清「日志给谁看」：三种读者

很多人写日志时心里只有自己——「我调试时要看」。但生产日志有三个截然不同的读者，写法要求完全不同：

- **开发者（排查问题）**：要能从一条错误回溯到「哪条请求、什么参数、走了哪段代码」。要的是**关联性**（requestId）和**上下文**（关键变量）。
- **运维 / 告警系统（盯大盘）**：要能按维度聚合——「过去 5 分钟 5xx 率」「P99 耗时」「错误最多的接口 TOP10」。要的是**结构化字段**和**稳定的级别**，能机器读。
- **安全 / 合规（审计）**：要的是「谁在什么时候做了什么」，且**绝不能含敏感数据**（token、密码、PII）。

`console.log(\`fetched post ${id} in ${ms}ms\`)` 同时得罪这三个读者：`id` 和 `ms` 焊死在字符串里，机器没法按 `id=` 聚合；级别永远是 log（没法按 error/warn 切片）；一旦你顺手 `console.log(req.body)`，密码就进了日志文件。**结构化日志就是同时伺候这三个读者的最小改动。**

### 3. 结构化日志：字段，不是散文

把同一条访问日志，用两种写法摆出来：

```
# 散文式（Day 45 之前）
[Nest] LOG [HTTP] GET /posts/abc 200 42ms reqId=9f3c-

# 字段式（Day 45 之后，一行 JSON）
{"level":30,"time":1782435659702,"app":"blog-api","requestId":"9f3c-","method":"GET","url":"/posts/abc","status":200,"durationMs":42,"msg":"http request"}
```

字段式的好处全在「能被机器精确操作」：

```bash
# 只看 5xx
jq 'select(.status>=500)' app.log
# 按接口算平均耗时
jq -s 'group_by(.url) | map({url:.[0].url, avg:(map(.durationMs)|add/length)})' app.log
# 找出某个 requestId 的全部日志（一条请求的完整轨迹）
jq 'select(.requestId=="9f3c-")' app.log
```

这些操作在散文日志上要么做不到、要么脆（`grep "reqId=9f3c-"` 一旦文案改了就失效）。**字段式日志是日志采集系统（ELK / Loki / Datadog / Sentry）的输入格式**——它要的是能建索引的结构，不是给人读的句子。给人读的那份，留给开发期的 `pino-pretty`（彩色渲染）。

> 一句话纪律：**先对象、后文案**。`logger.info({ postId, durationMs }, 'post fetched')` 是对的；`logger.info(\`fetched ${postId}\`)` 是错的——后者把 `postId` 焊进字符串，采集后没法按字段聚合。

### 4. Pino：为什么是 Node 日志的事实标准

Node 生态的日志库不少，Pino 能成主流，靠的是三件事：

**① 极致性能——靠「关掉的级别不付出代价」。** 日志库里最容易拖慢应用的是：哪怕这条日志级别被过滤掉了（生产 `info` 级跑、代码里写了 `logger.debug(大对象)`），库还是先把 `大对象` 序列化成字符串，再发现「哦不要」，扔掉。Pino 用「子进程 transport + 延迟序列化」绕开了这个：日志对象先以**对象**形式丢给 worker 线程，主线程零序列化开销；序列化在 worker 里做，不阻塞事件循环。低级别日志多写一倍，应用吞吐几乎不动。

**② JSON-first，不是事后拼装。** 很多库（含老牌 Winston）默认输出文本、要 JSON 得额外配 transport。Pino 默认就是 JSON，字段即一等公民。

**③ 扩展点干净：`mixin` / `redact` / `transport`。** 后面几节你会看到，requestId 关联靠 `mixin`、脱敏靠 `redact`、开发期美化靠 `transport`——都是 pino 配置项里的一行，不用自己包一层。

横向对比一下三个常见选择：

| | 输出 | 性能 | 扩展 | 适合 |
|---|---|---|---|---|
| `console` / Nest `ConsoleLogger` | 文本 | 快 | 无 | 本地调试、单进程小脚本 |
| Winston | 文本/JSON 可配 | 中（同步序列化） | 丰富（ transports / formats 一大堆） | 老项目、要几十种 transport 的 |
| **Pino** | **JSON 默认** | **最快** | mixin/redact/transport 三件套 | 生产 API、高吞吐、要机器读的 |

Nest 自带的 `ConsoleLogger` 我们之前一直在用（`new Logger('HTTP')`），它对早期学习够用，但它是**文本、进程内、无结构**——今天该毕业到 Pino 了。不过我们没把整个 Nest 内置 Logger 推翻（那要 `app.useLogger(...)` 全局接管，动静大、测试要改）：而是**在边界**（访问日志、慢请求、异常、业务错误）换成 Pino 的结构化输出，Nest 自己的启动日志仍走 ConsoleLogger。这是个务实的取舍——把可观测价值最高的几处先结构化。

### 5. requestId 链路追踪：CLS 让「深层日志」也带上请求身份

这是今天**最该想透的一节**。问题是这样的：

> 一条请求进来，`RequestIdMiddleware` 给它挂了 `x-request-id`，访问日志、异常过滤器在 **HTTP 边界** 都拿得到 `req`，能把这个 id 打进日志。但请求会进到 `PostsService.findOne` 这种**深层 service**——service 是单例，**它看不到 `req`**。如果 service 里也想打日志，怎么让它带上「这是哪条请求」的 id？

把 `req` 一路当参数传下去？侵入所有函数签名，丑且易漏。把 service 改成请求级（`@Scope(REQUEST)`）？单例变多例，每请求重建依赖图，性能和心智都不值。

正解是 **AsyncLocalStorage（CLS，Continuation-Local Storage）**——Node 内置的「按异步调用链传递的上下文」。它在请求最外层 `.run(store, next)` 开一个 store，之后这条请求所有的 `await`、定时器回调、Promise 链里，`getStore()` 都能拿到同一份、且只属于这条请求的 store。这正是 Day 36 给缓存命中状态（`X-Cache` 头）用的同一个机制——今天给它**多塞一个 `requestId` 字段**：

```ts
// src/common/request-context.ts —— RequestContext 既有 cache，今天加 requestId
interface RequestContext {
  cache?: CacheState;
  cacheKey?: string;
  requestId?: string;   // ★ 新增
}
export function setRequestId(requestId: string): void {
  const store = requestContextStorage.getStore();
  if (store) store.requestId = requestId;   // 没有上下文（启动期）就忽略，不报错
}
```

```ts
// src/common/middleware/request-id.middleware.ts —— 拿到 id 后顺手写进 CLS
setRequestId(id);
```

然后是 Pino 的**杀手锏**：`mixin`。它在**每写一行日志前**调一次，返回值自动合并进这行——所以我们根本不用每个调用方手动传 reqId：

```ts
// src/observability/logger.ts
mixin: () => {
  const requestId = getRequestContext().requestId;
  return requestId ? { requestId } : {};   // CLS 外（启动期）不挂，避免污染非请求日志
},
```

效果：只要这行日志是在某条请求的异步链里打的，CLS 里就有那个请求的 id，`mixin` 自动把它带上。**service 拿不到 `req`，日志照样带上 requestId**——这条请求从访问日志、到 service 内部日志、到最终抛出的异常栈，全部靠同一个 id 串起来。在 Sentry 里看到一个错误，按 `requestId` tag 回查，立刻定位到这条请求的全部轨迹。

> 顺序有个坑：`RequestContextMiddleware`（开 CLS）必须**排在 `RequestIdMiddleware`（写 CLS）之前**，否则写的时候 store 还没开。`CommonModule.configure()` 里已经把 RequestContext 放在最外层，所以成立——这是它当初「必须最先」的又一个理由。

### 6. 日志脱敏：authorization / cookie / 密码永远不能进日志

可观测性的反面是**信息泄露**。一条 `logger.info({ req })` 把整个请求对象打出来，`authorization: Bearer <jwt>`、`cookie: sid=...`、`req.body.password` 就全进了日志文件——日志文件往往权限松、留存久、还会被采集到第三方平台。token 一旦落盘，等于把会话身份明文存了一份谁都能翻的副本。

两道防线，主次分明：

**① 主防线：访问日志只挑安全字段。** 我们的 `HttpLoggerMiddleware` 只打 `method / url / status / durationMs`，**根本不碰 headers / body**。你打不出你没有的东西——这是最稳的脱敏。

**② 兜底防线：Pino `redact`。** 万一某处调试时 `logger.info({ req })` 把整个 req 塞进来了，`redact` 把指定路径盖成 `[REDACTED]`：

```ts
// src/observability/logger.ts
redact: {
  paths: [
    'req.headers.authorization', 'req.headers.cookie',
    'req.body.password', 'req.body.newPassword', 'req.body.refreshToken',
    'password', 'newPassword', 'refreshToken',
  ],
  censor: '[REDACTED]',
},
```

单元测试里专门验了这一条（`observability.unit.test.ts`：把整个 req 塞进来，断言 `authorization`/`cookie` 变成 `[REDACTED]`）。**redact 是兜底，不是主防线**——别因为有 redact 就放心打敏感数据，它能挡已知路径，挡不住你新发明的字段名。

### 7. 健康检查的本质：存活 vs 就绪（Day 42 搭好，今天讲透）

Day 42 已经把两个探针分开了，今天回答「为什么非得拆」。先看代码里它们各查什么（`src/health/health.controller.ts`）：

```ts
// 存活（liveness）：进程级，不碰 DB/Redis——又快又稳
@Get()
liveness() {
  return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
}

// 就绪（readiness）：查下游（DB + Redis），任一不通 → 503
@Get('ready')
@HealthCheck()
readiness() {
  return this.health.check([
    () => this.prisma.pingCheck('database', this.db),   // 一条 SELECT 1
    () => this.redis.pingCheck('redis'),
  ]);
}
```

这两个探针回答的是**两个不同的问题**，所以编排器（docker / k8s / Fly / Railway）对它们的反应也**完全不同**：

| | liveness（存活） | readiness（就绪） |
|---|---|---|
| 问的是 | 「这个进程还活着吗？」 | 「这个进程现在能接流量吗？」 |
| 查什么 | 进程级（不碰下游） | 下游依赖（DB / Redis） |
| 不通时编排器动作 | **重启**进程（`restartPolicy` / k8s `livenessProbe` 失败 → kill 重拉） | **不导流量**给它（从负载均衡摘掉），但不重启 |
| 失败的后果 | 进程僵尸（死循环 / 死锁）→ 重启回收 | 下游抖动 → 暂时不接客，等恢复 |

**为什么非得分开？** 因为「进程活着」和「能服务请求」是两回事。设想 DB 抖了一下：

- 如果**只有**一个 liveness 探针、而且它查 DB：DB 一抖 → liveness 失败 → 编排器**重启**进程。但重启**治不了 DB**——进程起来、DB 还在抖、又失败、又重启……于是 DB 抖 30 秒，你的 N 个实例被重启了 N 轮，连接池全砸向还没恢复的 DB，**雪上加霜**。
- 拆开后：DB 抖 → readiness 失败（503）→ 编排器**只是不导流量**给这些实例、转给还健康的、或返回 503 让客户端重试；进程**不重启**，DB 一恢复立刻自动接客。这才是对的反应。

所以 Day 42 / Day 44 的映射是：**`/health`（liveness，永远 200 只要进程在）给「判起来没」的平台探针；`/health/ready`（查下游）给「判能不能接流量」的就绪闸门。** Day 44 里 Railway 的 `healthcheckPath: /health`（宽松，判部署成没成）、Fly 的流量检查打 `/health/ready`（严格，判能不能接客），正是这套分工的落地。

**一个真实的权衡：就绪该不该查 Redis？** 我们纳入了（`redis.pingCheck`）。但 Redis 在这套里是**可选降级层**——连不上 API 也能直连 DB 跑（见 Day 36）。那 readiness 查它，就意味着「Redis 一抖，这台就不接流量」。好处：首批请求不会在缓存 miss 时穿透打 DB（cache stampede）；坏处：缓存层一抖就摘流量，可能过度反应。代码注释里写了：**如果你的部署里 Redis 真可能缺席、又希望 API 照常 ready，删掉 `redis.pingCheck` 那一行即可**。这是 DB（必填，连不上启动崩）和 Redis（可选，缺了降级）那个**不对称**的延续——就绪判定的严格度，跟着「这个依赖缺了能不能服务」走。

> terminus 还有个坑值得记：自定义 indicator 不健康时**必须抛 `HealthCheckError`**，不能只返回 `{ status: 'down' }`——后者会被 terminus 当普通 info，整体 status 仍是 `ok`、照样 200。`RedisHealthIndicator`（`src/health/redis.health.ts`）就是为这个写的，因为 terminus 内置一堆 indicator 偏偏没有 ioredis 的——继承 `HealthIndicator`、`super.getStatus()` 拼标准结果、down 时抛错，几行就够，这正是 terminus 的扩展点。

### 8. 可观测性三件套：logs / metrics / traces

把视野拉高，可观测性（Observability）有三根支柱，各回答不同问题：

| 支柱 | 回答什么 | 形态 | 我们今天的进度 |
|---|---|---|---|
| **Logs（日志）** | 「出了什么事？」具体的一次事件、错误、请求轨迹 | 结构化事件流（带级别/字段/时间） | ✅ 今天做完（Pino + requestId） |
| **Metrics（指标）** | 「趋势怎么样？」可聚合的数值时间序列（QPS、错误率、P99、内存） | 计数器 / 直方图，按时间窗口聚合 | ❌ 还没做（Prometheus / `prom-client`） |
| **Traces（分布式追踪）** | 「一次请求跨了哪些服务、卡在哪？」跨进程的调用链 | span 树，带父子关系 | ❌ 还没做（OpenTelemetry） |

为什么三样都要、不能只靠日志？因为它们**粒度和成本不同**：

- 日志**信息最全**，但**量最大、最贵**（每请求几行 × 高 QPS = 烧钱）。所以日志不能记一切——只记有价值的（访问、异常、关键业务事件）。
- 指标**便宜得多**（一个计数器一条时间序列，存一年也小），适合**长期看趋势、设告警阈值**（「错误率 > 1% 持续 5 分钟」）。但它不告诉你「具体哪条请求错了」——那得回日志。
- 追踪**采样**（不全记，记 1%），看「一次慢请求在哪个服务 / 哪段代码卡住」，是微服务时代定位跨服务延迟的本命工具。单体能用日志里的 `durationMs` 凑合，多服务就必须它。

工业界的方向是 **OpenTelemetry（OTel）**——一套统一的标准，让你用同一套 instrumentation 同时产出 logs / metrics / traces，再分别导到后端（Prometheus 存 metrics、Jaeger/Tempo 存 traces、Loki/ELK 存 logs）。今天我们手写了 logs 这一块；等上了 OTel，这套 pino 日志会被接成 OTel 的 log 信号，requestId 会升级成跨服务的 `traceId`。

### 9. Sentry：从「日志里捞 5xx」到「主动推到你面前」

Day 45 之前，一个 500 长这样：异常进 `AllExceptionsFilter`，打一行带栈的日志到 stdout，进程继续跑。问题在于**没人会主动看那行日志**——除非用户投诉、你登机器 `grep`。等你发现「这个空指针今天炸了 200 次」，已经是事后。

Sentry（或同类的 Datadog / Bugsnag / 自建 GlitchTip）干的就是把这个流程翻转：**应用出错时主动把异常推到聚合平台**，平台帮你按错误指纹（fingerprint）去重、按版本/环境分组、算「这个错误今天多少次、影响了谁、首次出现在哪个 release」。它解决的是日志解决不了的「主动告警 + 聚合归因」。

落地分两步：

**① 初始化（守卫式，无 DSN 就 no-op）：**

```ts
// src/observability/sentry.ts
export function initSentry(opts: SentryInitOptions): void {
  if (!opts.dsn) return;   // ★ 可观测层「缺了只降级」：没配 DSN 直接 return，绝不连累启动
  Sentry.init({ dsn: opts.dsn, environment: opts.environment, tracesSampleRate: opts.tracesSampleRate, ...opts.release });
}
```

```ts
// src/main.ts —— 拿到 config 后、listen 前调一次
initSentry({
  dsn: config.get('observability.sentry.dsn', { infer: true }),
  environment: config.get('observability.sentry.environment', { infer: true }),
  tracesSampleRate: config.get('observability.sentry.tracesSampleRate', { infer: true }),
  release: config.get('observability.sentry.release', { infer: true }),
});
```

注意它和「DB 必填」的不对称（Day 44 讲过）：DB 连不上 → 启动即崩（真相源必须到位）；Sentry 没配 / 连不上 → 静默 no-op（观测层缺了只降级）。`captureException` 本身也是 fire-and-forget，入队上报、永不抛错——**绝不让「记日志」这件事搞崩业务请求**。

**② 在过滤器里显式 capture（只推 5xx）：**

```ts
// src/common/filters/all-exceptions.filter.ts
if (status >= 500) {
  this.logger.error({ ...context, err: exception }, isHttp ? 'http exception' : 'unhandled exception');
  this.reporter.capture(exception, context);   // ★ 5xx 才推
}
// 4xx 不在这里推
```

`reporter` 是个**抽象**（`ErrorReporter`），生产实现是 `SentryErrorReporter`，测试塞个假实现断言「确实调了 capture」——这样单测不用碰真 Sentry、也不用配 DSN。capture 时给事件挂上 request 上下文 + requestId tag：

```ts
// src/observability/error-reporter.ts
Sentry.withScope((scope) => {
  if (context) scope.setContext('request', context);
  if (typeof reqId === 'string') scope.setTag('requestId', reqId);   // ★ 在 Sentry 里按 reqId 回查日志
  Sentry.captureException(exception);
});
```

**为什么只推 5xx、不推 4xx？** 这是最容易做错的取舍。4xx 是**客户端责任**（参数错、没登录、资源不存在），量大且「正常」——一个被爬虫乱打的接口，一天几万条 404。把这些都推 Sentry，告警噪音会淹没真正的服务端 bug，你迟早把通知关掉，于是连 5xx 也不看了。5xx 才是**服务端责任、必须修**的。所以「错误上报」纪律是：**只报「不该发生、发生了就得修」的异常**，4xx 这种预期内的客户端错误，留在日志（warn 级）里按需查就够。

> Sentry 的「错误指纹」会自动把同一个 `Error` 在不同请求里的多次发生归成一条 issue，并算「首次出现于哪个 release」「回归了吗」（上版本没有、这版本有了）。这正是 §8 说的「日志做不到的聚合归因」——也是为什么错误上报是独立于日志的一根支柱，而不是「日志的一种」。

### 10. 生产日志的几条纪律

接完了不等于用对了。几条容易踩的：

- **级别要稳。** `error` = 该告警、该修（5xx、未捕获异常）；`warn` = 异常但可继续（4xx、降级触发、慢请求）；`info` = 正常但有价值的事件（访问日志、登录成功）；`debug`/`trace` = 排查时开、平时关（靠 `LOG_LEVEL`）。级别乱了，告警就没法按级别设阈值。pino 默认用**数字级别**（`info=30 / warn=40 / error=50`），机器按 `< / >=` 切片比字符串快——别被它吓到，采集系统会映射回名字。
- **一条请求别打太多 info。** 高 QPS 下「每请求一条访问日志」已经不少，再加 service 里层层 `info`，日志量爆炸（钱 + 采集延迟）。service 内部默认用 `debug`，`LOG_LEVEL=info` 时自然不输出；要排查再临时 `LOG_LEVEL=debug`。
- **慢请求单独标。** `TimingInterceptor` 对超过阈值（默认 500ms）的请求打 `warn` 级带 `durationMs`——这是个轻量 SLO 信号，采集后能按 url 聚合「慢请求 TOP」，比翻访问日志高效。
- **日志只往 stdout 写。** 不要 `fs.writeFile` 自己存日志文件——容器里文件随重启消失，且没有轮转。正确姿势：应用只往 stdout 写，**采集 agent**（Fluent Bit / Vector / 平台自带的）负责收集、轮转、转发到后端。这也是 pino 默认 `destination(1)`（stdout）的原因。

### 11. 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `src/observability/logger.ts` | **新增**：pino 单例工厂 `createLogger` + 进程级 `appLogger`。开发 `pino-pretty` / 生产测试裸 JSON；`mixin` 从 CLS 自动挂 requestId；`redact` 脱敏 authorization/cookie/password |
| `src/observability/structured-logger.service.ts` | **新增**：字段式注入服务（`info/warn/error/debug`，对象优先），业务代码可注入 |
| `src/observability/sentry.ts` | **新增**：`initSentry`，无 DSN 直接 return（可选观测层哲学） |
| `src/observability/error-reporter.ts` | **新增**：`ErrorReporter` 抽象（当 DI token）+ `SentryErrorReporter`（带 request 上下文 + requestId tag，无 DSN 时 capture no-op） |
| `src/observability/observability.module.ts` | **新增**：`@Global`，提供 `StructuredLoggerService` + `ErrorReporter`→`SentryErrorReporter` |
| `src/common/request-context.ts` | CLS 的 `RequestContext` 加 `requestId` 字段 + `setRequestId()` |
| `src/common/middleware/request-id.middleware.ts` | 拿到 id 后 `setRequestId(id)` 写进 CLS（前提：RequestContext 在它之前开 store） |
| `src/common/middleware/http-logger.middleware.ts` | 访问日志从字符串拼接 → 结构化字段（method/url/status/durationMs），级别随 status 走 |
| `src/common/interceptors/timing.interceptor.ts` | 慢请求 warn 从字符串 → 结构化字段 |
| `src/common/filters/all-exceptions.filter.ts` | 注入 `StructuredLoggerService` + `ErrorReporter`；5xx 结构化打栈（`err` 字段）+ 推 Sentry；4xx 不推、不打；安全文案不漏 message |
| `src/common/filters/business-exception.filter.ts` | 业务 warn 从字符串 → 结构化字段（直接用 `appLogger` 单例，不靠 DI——per-controller filter 的依赖解析不如全局稳） |
| `src/common/common.module.ts` | `imports: [ObservabilityModule]`——APP_FILTER/APP_INTERCEPTOR 实例化时要在此模块上下文解析观测层依赖 |
| `src/app.module.ts` | import `ObservabilityModule` |
| `src/main.ts` | 拿到 config 后调 `initSentry(...)` |
| `src/config/{configuration,config.validation}.ts` + `.env.example` | 加 `LOG_LEVEL` / `SENTRY_DSN` / `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` / `SENTRY_TRACES_SAMPLE_RATE` |
| `test/observability.unit.test.ts` | **新增**：结构化 JSON 形状 / CLS requestId 关联 / CLS 外不带 / 脱敏 / 5xx 才推 Sentry（假 reporter）/ 503 也推 |
| `test/observability.e2e.test.ts` | **新增**：`/posts/debug/boom` → 500 + 安全文案（不泄露 "boom"）+ requestId 回显 |

> 踩过的一个 Nest DI 坑，值得记：`APP_FILTER` / `APP_INTERCEPTOR`（全局过滤器/拦截器）是在**注册它的模块（CommonModule）的上下文里**实例化的。观测层（`StructuredLoggerService` / `ErrorReporter`）虽然标了 `@Global`，但全局可见性对「useClass 的构造依赖」并不总是稳——所以 CommonModule 还得显式 `imports: [ObservabilityModule]`，否则启动报 `Nest can't resolve dependencies of the TimingInterceptor`。`@Global` 不是万能的，对 APP_* 这类宿主明确的消费者，老老实实在宿主模块 import 一遍最稳。

### 12. 一份诚实清单

✅ **今天到位的：**
- 结构化日志（Pino）：字段式 JSON、开发 pretty / 生产裸 JSON、`mixin` 自动 requestId、`redact` 脱敏
- requestId 全链路关联：CLS（AsyncLocalStorage）让「拿不到 req 的深层 service」日志也带上请求身份
- 访问日志 / 慢请求 / 异常 / 业务错误四处边界全部结构化；级别语义（5xx→error、4xx→warn、其余 info）
- 健康检查 liveness vs readiness 讲透：两种探针的本质、编排器不同动作、就绪该不该查 Redis 的权衡
- Sentry 错误上报：守卫式 init（无 DSN no-op）、显式 captureException（只 5xx）、request 上下文 + requestId tag
- 可观测三件套全景建立：logs 做完，metrics / traces 边界讲清

⚠️/❌ **还没做、明确知道的缺口：**
- **指标（Metrics）**：没有 `prom-client` / Prometheus。QPS、错误率、P99 耗时、连接池占用这些「趋势型」信号现在只能从日志事后算，没有实时大盘和阈值告警
- **分布式追踪（Traces）**：没接 OpenTelemetry。单服务靠 requestId + 日志 durationMs 凑合；多服务后必须 `traceId` 跨服务串联
- **日志采集后端**：应用只往 stdout 写了，没接 Fluent Bit / Vector → Loki / ELK 的采集转发链路（需要真实基础设施）
- **Sentry source maps / release 真用起来**：`SENTRY_RELEASE` 加了但没在构建时上传 source map，线上栈是编译后的；release 归因也只是配了值，没接 CI 上传
- **采样与成本控制**：现在每请求一条访问日志，高 QPS 下量没控；生产级要采样 + 日志保留期（retention）策略
- **审计日志**：业务上「谁改了什么」这种合规审计日志没单独建——它和运行日志语义不同（不可变、长期留、结构固定）
- **告警规则**：Sentry 接了能收错误，但「错误率阈值」「就绪连续失败 N 次」这类告警规则（接 PagerDuty / Slack）没配
- **Nest 内置日志未全量结构化**：Nest 自己的启动日志（`Nest application successfully started` 等）仍走 ConsoleLogger 文本。要全量结构化需 `app.useLogger(pinoLogger)` 全局接管，今天为求稳没做

---

## 💻 实践练习

1. **亲眼看结构化日志**（现在可做）：
   ```bash
   cd solutions/blog/blog-api
   # 开发模式：pino-pretty 彩色人类可读
   LOG_LEVEL=info DATABASE_URL='postgresql://blog:blog_dev_pwd@localhost:5435/blog?schema=blog_api' \
     REDIS_URL='redis://localhost:6379' JWT_ACCESS_SECRET='dev-only-access-secret-change-me-please' \
     pnpm start:dev
   # 另开终端打一个请求：
   curl -H 'x-request-id: my-trace-01' http://localhost:3000/posts
   ```
   终端应看到一行 JSON（开发模式是彩色 pretty），带 `requestId: my-trace-01`、`method`、`url`、`status`、`durationMs`。把 `LOG_LEVEL` 换成 `silent` 再打一次——日志没了（级别闸生效）。

2. **亲眼看 5xx 推 Sentry 的「形状」**（现在可做，不连真 Sentry）：
   ```bash
   curl -H 'x-request-id: boom-trace-77' http://localhost:3000/posts/debug/boom
   ```
   - 响应体应是 `{"code":500,...,"message":"服务器内部错误","requestId":"boom-trace-77",...}`——**固定安全文案，绝不出现 triggerBoom 抛的 "boom"**。
   - 终端的结构化日志应是 `level:50`（error）的一行，带 `err.stack`（栈打到日志了）、`requestId`、`status:500`、`msg:"unhandled exception"`。这就是 Sentry 会收到的那条事件的「本地预览」。
   - 想验证「4xx 不推」：`curl -i http://localhost:3000/posts/not-a-uuid` → 400，日志里是 warn、没有 error 级、Sentry 不收（用真 DSN 时去 Sentry 后台确认 issue 没增加）。

3. **跑可观测性测试**（现在可做，需 PG 5435 + Redis）：
   ```bash
   cd solutions/blog/blog-api
   DATABASE_URL='postgresql://blog:blog_dev_pwd@localhost:5435/blog?schema=blog_api' \
     pnpm test:unit          # 7 条 observability 单测（结构化形状/CLS/脱敏/5xx 推 Sentry）
   DATABASE_URL='postgresql://blog:blog_dev_pwd@localhost:5435/blog?schema=blog_api' \
     node --test --test-concurrency=1 -r ts-node/register -r ./test/setup.cjs test/observability.e2e.test.ts
   ```

4. **真接一次 Sentry**（需 sentry.io 免费账号，临门一脚）：
   - sentry.io 建 Node 项目，拿 DSN，填进 `.env` 的 `SENTRY_DSN`。
   - 重启服务，打 `curl -H 'x-request-id: real-1' http://localhost:3000/posts/debug/boom`。
   - Sentry 后台几秒内出现一条 issue：点进去看 stack trace（指向 `triggerBoom`）、`request` 上下文（method/url/status）、`requestId` tag = `real-1`。再打一次同样的——issue 计数 +1（指纹去重生效），不会变成两条。
   - 体会 §9 说的：不用你 grep 日志，错误主动找上门了。

5. **思考题**：
   - 为什么我们把 `redis.pingCheck` 放进 `/health/ready`，但 Redis 连不上时应用**不崩**、只是 503？（提示：就绪探针「摘流量不重启」；Redis 是可选层，挂了降级直连 DB。对比 DB 连不上启动即崩——必填 vs 可选的不对称。）
   - `console.log(\`user ${userId} login\`)` 和 `logger.info({ event:'login', userId }, 'auth')`，在生产「按用户聚合登录次数」时，差别在哪？（提示：前者 userId 焊在字符串里，采集后只能正则抠、文案一改就断；后者 userId 是字段，`jq` / 后端直接 `group by userId`。）
   - 如果 Sentry 的 `tracesSampleRate` 设成 1（全采样），在高 QPS 下会怎样？设成 0 呢？（提示：1 = 每请求都采性能 trace，开销大、可能压垮自身 / 打爆 Sentry 配额；0 = 关闭 trace，错误上报仍工作（trace 和错误上报是两路）。生产通常 0.01~0.1 折中。）
   - 我们没让 Nest 的启动日志也走 Pino（仍 ConsoleLogger）。要全量结构化，最小改动是什么、代价是什么？（提示：`app.useLogger(pinoLoggerService)` 全局接管，所有 `new Logger()` 走 Pino；代价是测试里 `logger:false` 的行为要重新核对，且 Nest 内部日志格式变化。）

---

## ✅ 今日产出

- [ ] 完成核心知识点学习（结构化日志 / Pino / requestId+CLS / liveness vs readiness / 可观测三件套 / Sentry）
- [ ] 跑通 `observability.unit.test.ts`（结构化 JSON + CLS 关联 + 脱敏 + 5xx 才推 Sentry）和 `observability.e2e.test.ts`（boom 端点 500 安全文案 + requestId）
- [ ] 起服务，亲眼看访问日志是带 `requestId` 的结构化 JSON；打 `/posts/debug/boom` 看到带栈的 error 级日志 + 安全文案响应
- [ ] （有 sentry 账号的话）真接一次 Sentry：填 DSN → 触发 boom → 后台看到带 requestId 的 issue
- [ ] 在笔记里写下：三种日志读者、为什么 liveness/readiness 必须分开、可观测三件套各回答什么、为什么只推 5xx
- [ ] 提交代码到 GitHub

---

[⬅️ Day 44](../day-44/) | [➡️ Day 46](../day-46/)
