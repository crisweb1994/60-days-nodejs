# Day 35 — Web 安全防护

> Day 32 我们做了"证明你是谁"（登录、发 token），Day 33 做"你能干什么"（RBAC），Day 34 做"借别人的平台证明你是谁"（OAuth）。
> Day 35 要换个视角：**就算认证授权全写对了，还有哪些路能把你的系统搞垮、把用户数据搞走。**
>
> 这一天的核心不是背一份"安全清单"，而是搞懂每个攻击**靠什么成立**——成因一清楚，防护就变成"拆掉它的前提条件"，而不是"祈祷我的过滤没漏"。

## 📋 今日目标

- 用服务端视角过一遍 **OWASP Top 10**（2021 版），每一条落到"我们这个项目怎么处理"
- 吃透三大经典攻击——**SQL 注入 / XSS / CSRF**——的成因，并说清哪些**在本项目根本不成立、为什么**
- 上 **Helmet**：用一组响应头，让浏览器替你挡掉点击劫持、MIME 嗅探、协议降级
- 上 **限流（Rate Limiting）**：用 `@nestjs/throttler` 给登录接口踩刹车，挡住暴力撞库
- 把以上全部接进 blog-api，并**诚实**列清楚：今天挡住了什么、还没挡什么

> 配套代码：`solutions/blog/blog-api/`。新增 `src/common/middleware/security-headers.middleware.ts`（Helmet），
> `AppModule` 接入 `ThrottlerModule` + 全局 `ThrottlerGuard`，`AuthController` 收紧到 30 次/分钟，
> `HealthController` 豁免限流，`AllExceptionsFilter` 把 429 翻译成业务码 `RATE_LIMITED`。
> 新增 `test/security.e2e.test.ts`（安全头 / 限流 / 注入 / XSS 四组用例）。

---

## 📖 核心知识点

### 1. 先校准一个心态：安全不是"挡住坏人"

很多人对"安全"的第一反应是"加一层过滤、加一道墙，把坏人拦在外面"。这个模型有个致命漏洞：**坏人手里可能拿着一个完全合法的账号。**

撞库攻击者登录用的账号密码是真的（从别处泄露来的），CSRF 的受害者是真的登录态，业务逻辑漏洞往往发生在完全合法的请求里。所以这一天的思路不是"识别坏人"，而是——

> **抬高攻击成本，让攻击在算账上不划算。** 密码撞库要 100 年？够了。注入根本拼不进去？更好。限流让 1000 QPS 变成 30 QPS？攻击者会去找更软的柿子。

带着这个心态看后面的每个防护，会发现它们都在做同一件事：**拆掉攻击成立的前提**。

### 2. OWASP Top 10（2021）服务端视角

OWASP Top 10 不是排名，是一份"最常见、最该先堵"的漏洞分类。我们把它和这个项目已做的事对照一遍（✅ 已处理 / ⚠️ 部分处理 / ❌ 还没）：

| # | 类别 | 一句话成因 | 本项目现状 |
|---|---|---|---|
| A01 | 访问控制失效 | 该鉴权的没鉴权，或鉴权了但越权 | ✅ Day 33：守卫 + 资源级权限（作者才能改自己的文章） |
| A02 | 加密失效 | 明文存密码、弱算法、明文传 | ✅ Day 32：bcrypt 哈希；Day 31：refresh 只存 sha256 |
| A03 | **注入** | 把用户输入拼进了 SQL/命令 | ✅ Prisma 参数化（见 §3） |
| A04 | 不安全设计 | 关键流程缺设计（如无并发保护） | ✅ Day 29 乐观锁 / Day 32 token 轮换事务 |
| A05 | 安全配置错误 | 默认开太多、错误回栈给客户端 | ⚠️ 今天补 Helmet；错误体已脱敏（`AllExceptionsFilter`） |
| A06 | 易受攻击的依赖 | npm 包有已知 CVE | ❌ 还没接 `npm audit` / Dependabot（§9） |
| A07 | 认证失败 | 弱密码、可枚举、无限流 | ⚠️ 密码长度校验 + 常量时间登录已有；**今天补限流** |
| A08 | 数据完整性失效 | 不校验反序列化、CI/CD 被投毒 | ⚠️ JWT 固定 HS256 算法（Day 31）；CI 供应链未管 |
| A09 | 日志监控失败 | 出事了没日志、没人看 | ⚠️ 有请求日志（Day 18）；缺审计/告警 |
| A10 | SSRF | 服务端替用户发请求，被导向内网 | ❌ OAuth 出网是固定域名，暂无通用 SSRF 面 |

这张表的价值不是"我背下来了"，而是让你在写每个功能时本能地问一句："它落在 A0 几？那个前提我拆掉了吗？"

### 3. SQL 注入：参数化是"根治"，不是"过滤"

注入的本质一句话：**把本该是"数据"的东西，当成了"代码"去执行。**

经典反面教材：

```ts
// ❌ 字符串拼接——q 直接进了 SQL 文本，攻击者能改写整条语句
db.query(`SELECT * FROM posts WHERE title LIKE '%${q}%'`);
// 用户传  ' OR '1'='1  → 语句变成  ... WHERE title LIKE '%' OR '1'='1%'  → 返回全部行
```

参数化的做法是让数据库**结构上**分清"代码"和"数据"：SQL 模板是代码，`?` / `${param}` 绑定的是数据。数据永远不会再被解析成 SQL 语法——这是从机制上堵死，不是靠你写正则去堵。

我们项目里全文搜索就是这么写的（`prisma-posts.repository.ts`）：

```ts
// ✅ Prisma 的 $queryRaw「带标签的模板字符串」：${...} 全部参数化绑定，不是字符串拼接
const rows = await this.prisma.$queryRaw<Array<PrismaPost & { total: bigint }>>`
  SELECT id, title, slug, content, ...
  FROM posts
  WHERE to_tsvector('simple', title || ' ' || content)
        @@ websearch_to_tsquery('simple', ${query.q})   -- ★ query.q 是参数，不是文本
        ${statusFilter}
  ORDER BY ts_rank(...) DESC
  LIMIT ${limit} OFFSET ${offset}
`;
```

三个要点，逐个拆：

- **`${query.q}` 是参数绑定，不是插值**：尽管长得像模板字符串，但 `Prisma.sql` / `$queryRaw` 的标签函数会把 `${}` 部分作为**带类型的绑定参数**传给驱动，而不是拼进 SQL 文本。用户传 `' OR '1'='1`，数据库拿到的就是字面量这个字符串，去匹配 tsquery——根本不会变成 `OR`。
- **动态片段也要用 `Prisma.sql` 拼**：`statusFilter` 是"有 status 才加这个条件"，它用的是 `Prisma.sql\`AND status = ${query.status}\``，`Prisma.empty` 当占位。同样参数化。**千万别图省事用字符串拼 SQL 再 `$queryRawUnsafe`**——后者名字里带 `Unsafe` 就是给你的警告：它真的会把字符串原样塞进去。
- **`websearch_to_tsquery` 比 `to_tsquery` 更安全**：不是因为它防注入（防注入靠参数化），而是它对乱输入**容错**——遇到裸符号不会抛错返回 500，用户体验和健壮性都更好。注释里特意写了这一点。

**为什么"过滤/转义"是错误的心智模型**：你可能想"我把 `'` 转义掉不就行了"。问题是转义是个**白名单不可能穷举完**的活——不同数据库、不同上下文（字符串里、标识符里、LIKE 通配符里）要转义的东西不一样，漏一个就破防。参数化让你根本不用关心这些：你给的是数据，数据库替你保证它不可能是代码。**能用参数化就别转义，能转义就别正则过滤。**

测试里我们直接拿经典 payload 去打搜索接口，验证它既不报错、也不会"越权返回全部行"（`test/security.e2e.test.ts`）：

```ts
const payloads = ["' OR '1'='1", "'; DROP TABLE posts; --", "' UNION SELECT * FROM users; --"];
for (const q of payloads) {
  const r = await req('GET', `/posts/search?q=${encodeURIComponent(q)}`);
  assert.equal(r.status, 200);                          // 不报错（更不会 DROP/UNION）
  assert.equal((r.json.data?.items ?? []).length, 0);   // 当成普通查询词，命中 0 条而非全部
}
```

### 4. XSS：这个 API 几乎不沾边——但要讲清"为什么"

XSS（跨站脚本）的本质是：**攻击者把脚本塞进页面，在别的用户的浏览器里执行**，从而偷 cookie、冒充操作。分三类：

- **存储型**：脚本存进数据库，谁访问谁中招（最危险，论坛评论是重灾区）。
- **反射型**：脚本藏在 URL 里，服务器原样"反射"回页面（搜索结果页常见）。
- **DOM 型**：纯前端把不可信数据插进 DOM（`innerHTML`）。

关键认知：**XSS 的"出口"是 HTML 渲染。服务端（或前端）把不可信数据拼进 HTML，才会发生 XSS。**

我们的 blog-api 是个**纯 JSON API**——`title` / `content` 原样存进 PG、原样用 JSON 返回，从不在服务端拼 HTML：

```ts
// posts.service.ts：content 就是个字符串，存进去什么样、取出来什么样
return this.repo.create({ title: dto.title, slug: dto.slug, content: dto.content, ... });
```

所以即使有人把 `<script>alert(1)</script>` 当标题发上来，它也只是个**普通字符串**，躺在 JSON 的字段里。浏览器收到 `Content-Type: application/json` 的响应，不会把字段里的 `<script>` 当 HTML 执行。测试验证的就是这点：

```ts
const payload = '<script>alert("xss")</script>';
const created = await req('POST', '/posts', { title: payload, /* ... */ });
assert.equal(created.json.data.title, payload);        // 原样存，不被改写、不被"执行"
const got = await req('GET', `/posts/${created.json.data.id}`);
assert.match(got.headers.get('content-type') ?? '', /application\/json/);  // 是 JSON，不是 HTML
```

**那 XSS 谁来防？消费方——也就是前端。** React 默认会把插值的数据 HTML 转义（`{title}` 是安全的），只有用了 `dangerouslySetInnerHTML` 才会把字符串当 HTML 解析——那才是前端 XSS 的真正入口。如果哪天前端要渲染用户写的富文本（Markdown / HTML），才需要在**渲染前**用 DOMPurify 这类库清洗。

后端在 XSS 上能做的、且我们已做的：

- **输入校验**：全局 `ValidationPipe` 开了 `whitelist: true, forbidNonWhitelisted: true`——DTO 没声明的字段直接拒，减少不可控输入。
- **`X-Content-Type-Options: nosniff`**（Helmet）：禁止浏览器"嗅探"——否则它可能把一个 JSON 响应当成 HTML 来解析，凭空造出一个 XSS 出口。
- **CSP**（生产环境开）：限制页面能加载哪些脚本源，是 XSS 的纵深防御。

一句话：**对于 JSON API，"我们没有 XSS"是因为"我们没有 HTML 出口"，而不是因为我们在服务端清洗了输入。** 别去给纯 API 加什么"XSS 过滤中间件"——那是没弄清攻击面的无效防护。

### 5. CSRF：这个 API 天然免疫——但这是今天最容易踩的坑

CSRF（跨站请求伪造）是最容易被误解的一个。先把它的成立条件说死：

> **CSRF 靠的是：浏览器会"自动"把你的 cookie 带上。** 攻击者在 `evil.com` 放一个表单，指向 `你的银行.com/转账`，诱导你点。你一提交，浏览器**自动**带上你在银行站点的登录 cookie，银行以为是你的操作。

也就是说，CSRF 的前提是**自动携带凭证（cookie）**。

**我们的认证用的是 `Authorization: Bearer <token>` 头，不是 cookie。** 看登录响应就知道（`auth.service.ts`）：

```ts
private authResponse(user: User, tokens: IssuedTokens) {
  return { ...tokens, tokenType: 'Bearer', user: this.toUserResponse(user) };
  //     ↑ token 在响应体里，由前端自己存（localStorage / memory），请求时手动塞进 Authorization 头
}
```

`Authorization` 头**不是浏览器自动携带的**（cookie 才是）。攻击者的页面既**读不到**你的 token（同源策略 SOP 挡着，`evil.com` 拿不到 `你的站.com` 的 localStorage），也**设不上**这个头（跨域 `fetch` 设自定义头要过 CORS 预检，你不允许就过不了）。两个前提都被拆掉，CSRF 在这里**不成立**。

这点值得点破，因为市面上有大量"给纯 token API 加 CSRF 中间件"的教程——**那是无效防护，因为你的攻击面里压根没有这个洞**。加了除了增加复杂度、制造假安全感，没有收益。

**那什么时候才真的要防 CSRF？** 当你为了"自动带凭证"的便利，把 token 放进了 **cookie** 的时候。那一刻，cookie 自动携带的"便利"，恰好就是 CSRF 进来的那扇门。真要这么设计，得同时上：

- **`SameSite=Lax/Strict`**：浏览器不在跨站请求里带 cookie（现代浏览器默认 Lax，已经挡掉大部分）。
- **双提交 token（Double Submit）或同步器模式（Synchronizer Token）**：服务端发一个随机 token，前端每个写请求带上，服务端校验。攻击者猜不到这个 token。

我们 Day 34 的 OAuth 流程里那个 `state`，就是 **OAuth 回调场景的 CSRF 防护**：防止攻击者把自己的 GitHub `code` 塞进受害者的回调，让受害者登录进攻击者的账号。原理同源——一次性、不可预测的服务端凭证。

还有两个常被误以为"能防 CSRF"的东西，澄清一下：

- **CORS 不能防 CSRF。** CORS 管的是"浏览器让不让 JS 读跨域响应"，CSRF 的请求是 *simple request*（如表单 POST），浏览器**照样发出去**，攻击者根本不在乎读不读得到响应——他要的是"请求发出去造成副作用"。
- **Helmet 没有"防 CSRF"这个开关。** 它管的是响应头指令，不是请求来源校验。

### 6. Helmet：让浏览器替你干活——响应头逐个讲

安全的很多力气，其实是**浏览器**在出。你只要在 HTTP 响应头里"下达指令"，浏览器就替你执行。Helmet 就是一组这样的指令，一次性钉上一打安全头。我们把它做成了一个 Nest 中间件（`security-headers.middleware.ts`）：

```ts
@Injectable()
export class SecurityHeadersMiddleware implements NestMiddleware {
  private readonly handler: ReturnType<typeof helmet>;

  constructor(config: ConfigService<AppConfig, true>) {
    const env = config.get('env', { infer: true });
    this.handler = helmet({
      // CSP 只在生产开：它默认拦内联脚本/样式，而 /docs 的 Swagger UI 大量用内联脚本
      contentSecurityPolicy: env === 'production',
      // 跨域 API：让前端（:5173）能读到响应
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    });
  }

  use(req: Request, res: Response, next: () => void): void {
    this.handler(req, res, next);
  }
}
```

逐个头看它为什么有用：

| 响应头 | Helmet 默认值 | 防的是什么 |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | **MIME 嗅探**：浏览器不再"猜"响应类型，防止把 JSON 当 HTML 解析（反射型 XSS 的帮凶） |
| `X-Frame-Options` | `SAMEORIGIN` | **点击劫持（Clickjacking）**：别站不能用透明 `<iframe>` 套你的页面、诱导你点按钮 |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | **协议降级（SSL Strip）**：强制 HTTPS，防止中间人把连接降到 HTTP 偷听 |
| `Content-Security-Policy` | （我们仅生产开） | **脚本来源白名单**：XSS 的纵深防御，限制页面能加载哪些 JS/CSS |
| `Cross-Origin-Resource-Policy` | 我们设 `cross-origin` | 默认 `same-origin` 会拦 *no-cors* 的跨域加载；我们是给跨域前端吃的 API，直接放行 |

两个我们**故意改了默认**的点，理由要说清：

- **CSP 在开发/测试关掉**：CSP 默认禁止内联 `<script>`，而 Swagger UI（`/docs`）依赖大量内联脚本。生产环境没有 Swagger（或应单独配 CSP 白名单），所以只在 `NODE_ENV === 'production'` 开。
- **CORP 设成 `cross-origin`**：Helmet 默认 `same-origin`。对你 React 用 `fetch` + CORS 的请求，CORP 其实不强制（CORS 那套已经管了）；但既然我们本来就是跨域 API，直接声明 `cross-origin` 最直白，也不会被将来的 `<img src>` / `<script src>` 这类 *no-cors* 场景坑到。

**为什么放成中间件、而不是 `main.ts` 里 `app.use(helmet())`？** 因为这样它属于应用的横切配置，e2e 测试直接 `NestFactory.create(AppModule)` 就能拿到这些头，不用在每个测试里重复挂一遍——`main.ts` 里挂的东西，测试是拿不到的。

### 7. 限流（Rate Limiting）：给暴力撞库踩刹车

为什么要限流？看登录接口——**如果它不限流，攻击者可以拿一份泄露的"邮箱+密码"字典，1000 QPS 地撞**。bcrypt 慢（工作因子 10，约 100ms/次）能天然拖慢一点，但：

- 攻击者会并发、会分布式，单机 bcrypt 的延迟挡不住规模化撞库。
- 登录失败本身就是个**信号**：同一个 IP 短时间内大量 401，几乎可以断定是撞库。

`@nestjs/throttler` 的做法是：**按来源（默认是 IP）在时间窗口内计数，超阈值抛 429**。我们分三层配：

```ts
// app.module.ts —— 全局兜底：每 IP 每分钟最多 1000 次（env 可调），只兜暴力刷
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => [
    { ttl: config.get('rateLimit.ttlMs', { infer: true }), limit: config.get('rateLimit.limit', { infer: true }) },
  ],
}),
// ...
providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],  // 全局守卫：每个请求先过这道闸
```

```ts
// auth.controller.ts —— 登录/注册是撞库主战场，比全局默认紧得多
@Throttle({ default: { limit: 30, ttl: 60000 } })  // 每 IP 每分钟最多 30 次覆盖整个 AuthController
@Controller('auth')
export class AuthController { /* register / login / refresh / oauth ... */ }
```

```ts
// health.controller.ts —— 探针几秒打一次、还都来自同一内网 IP，不豁免会被误伤成 429
@SkipThrottle()
@Controller('health')
export class HealthController { /* ... */ }
```

超了会怎样？`ThrottlerGuard` 抛 `ThrottlerException`——它是个 `HttpException(429)`。我们的全局 `AllExceptionsFilter` 捕到 429，翻译成统一业务码：

```ts
// all-exceptions.filter.ts
if (status === HttpStatus.TOO_MANY_REQUESTS) {
  payload.code = ErrorCodes.RATE_LIMITED;
  payload.message = '请求过于频繁，请稍后再试';
}
// → { code: 'RATE_LIMITED', data: null, message: '请求过于频繁，请稍后再试', requestId, ... }
```

成功响应还会带上 `X-RateLimit-Limit / -Remaining / -Reset`，被拦的响应带 `Retry-After`，告诉客户端等多久再试——前端可以据此做退避重试。

几个**真实部署才会撞上的坑**，提前知道：

- **throttler 是按 IP 分桶、不按路由分的**。也就是说"全局 1000/分钟"是所有路由共享一个桶，不是每个路由各 1000。这正是为什么登录接口要单独 `@Throttle` 收紧——否则它跟读列表共享那 1000 的额度。
- **`req.ip` 在反向代理后面是代理的 IP，不是客户端的**。Nginx / LB 转发后，所有请求看起来都来自同一个代理 IP，限流要么形同虚设（都算一个桶，很快全站 429），要么全失效。生产环境要 `app.set('trust proxy', 跳数)`，并信任正确的代理层数，让 Express 从 `X-Forwarded-For` 取真实 IP。
- **单机内存计数 ≠ 多副本**。我们现在是进程内 `Map` 计数，两个 Pod 各算各的，实际额度翻倍。要全局限流得把计数放到共享存储（Redis），Day 36 起会用到。

**别把限流当成撞库的唯一防线。** 真正的撞库是分布式的——几百个 IP 各发几十次，单机 IP 限流轻松绕过。限流是"抬高成本 + 留下信号"，真正要闭环还得靠：密码强度策略、账号锁定 / 登录延迟、CAPTCHA、异常登录告警。我们今天先把"信号"和"基础刹车"做上。

### 8. 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `src/common/middleware/security-headers.middleware.ts` | **新增**：Helmet 中间件，CSP 仅生产开、CORP 设 cross-origin |
| `src/common/common.module.ts` | 把安全头挂到所有路由（含 `/health`），排在日志中间件前 |
| `src/app.module.ts` | 接入 `ThrottlerModule.forRootAsync`（配置驱动）+ 全局 `ThrottlerGuard` |
| `src/auth/auth.controller.ts` | `@Throttle({ default: { limit: 30, ttl: 60000 } })` 收紧认证接口 |
| `src/health/health.controller.ts` | `@SkipThrottle()` 豁免探针 |
| `src/common/constants/error-codes.ts` | 新增 `RATE_LIMITED` |
| `src/common/filters/all-exceptions.filter.ts` | 429 → `RATE_LIMITED` 统一错误码 |
| `src/config/{configuration,config.validation}.ts` | 新增 `RATE_LIMIT_TTL`（秒）/ `RATE_LIMIT_LIMIT`，默认 60s / 1000 |
| `.env.example` | 补两个限流变量 + 注释 |
| `test/security.e2e.test.ts` | **新增**：安全头 / 限流 / 注入 / XSS 四组用例 |

### 9. 一份诚实的清单：今天挡住了什么，还没挡什么

✅ **今天挡住 / 强化的：**
- **注入**——Prisma 参数化（`$queryRaw` 模板 + `Prisma.sql`），结构上不可能拼出 SQL
- **点击劫持 / MIME 嗅探 / 协议降级**——Helmet 三个头
- **撞库的流量**——登录限流到 30/分钟 + 429 信号
- **敏感信息泄露**——`password` 永不出库（Day 32）、常量时间登录防枚举（Day 32）、refresh 只存哈希（Day 31）、JWT 固定算法防 `alg:none`（Day 31）
- **CSRF（OAuth 回调场景）**——Day 34 的 `state`

⚠️/❌ **还没做、留到 Day 36–40 的：**
- **分布式撞库**——要 Redis 做全局限流 + 账号锁定（Day 36）
- **依赖漏洞**——`npm audit` / Dependabot / Renovate 定期扫 CVE（A06）
- **密钥管理**——`JWT_ACCESS_SECRET` 现在在 env 文件，生产应走密钥管理服务（Vault / KMS）+ 轮换
- **审计日志**——"谁在什么时候做了什么"，现在只有访问日志，缺业务审计（A09）
- **HTTPS 终止**——交给反向代理 / 网关（Nginx / Caddy / ALB），应用层不操心底
- **SSRF 防护**——OAuth 出网是固定域名暂时安全；将来若有"用户给个 URL 让服务端去抓"的功能，必须做内网地址白名单

把"没挡什么"列出来，比列"挡了什么"更重要——安全是持续过程，知道自己的盲区才是安全意识的开始。

---

## 💻 实践练习

1. **跑测试**：在 `solutions/blog/blog-api` 目录下 `pnpm test`，看 `security.e2e.test.ts` 的四组用例。需要先起好 PG（见 `solutions/blog/blog-db`）。
2. **看头**：`curl -i http://localhost:3000/health`，对照 §6 的表，逐个找到 Helmet 钉上的头。
3. **触发限流**：把 `.env` 的 `RATE_LIMIT_LIMIT` 调成 3，重启，连续 `curl` 同一个接口 4 次，第 4 次应该 429 并带 `Retry-After`。
4. **打注入**：`curl 'http://localhost:3000/posts/search?q='"'"'%20OR%20'"'"'1'"'"'='"'"'1'`，确认返回 200 + 空 results，而不是"全部文章"。
5. **思考题**：如果哪天我们改成"token 放 HttpOnly cookie"，需要补哪三样东西才不会重新打开 CSRF 的门？（提示：SameSite / CSRF token / CORS credentials）

---

## ✅ 今日产出

- [ ] 完成核心知识点学习（注入 / XSS / CSRF / Helmet / 限流）
- [ ] 跑通 `security.e2e.test.ts`
- [ ] 在自己的笔记里写下"我的项目落在 OWASP A0 几"
- [ ] 提交代码到 GitHub

---

[⬅️ Day 34](../day-34/) | [➡️ Day 36](../day-36/)
