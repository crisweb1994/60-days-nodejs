# Day 40 — 🏆 里程碑：安全加固版博客系统（v2.0）

> 这一天是个收口。前面十几天我们一块块往上垒：Day 32 的 JWT、Day 33 的 RBAC、Day 34 的 OAuth、Day 35 的 Helmet + 限流、Day 36/37 的缓存与锁、Day 38 的队列、Day 39 的文件上传。每一块单独看都「能用」，但把它们拼到一起回头看，安全面还有几个窟窿一直没人堵。
>
> Day 39 那张诚实清单就点了两条：限流是**按 IP、还是进程内**的——多副本部署额度直接翻倍；密码只要 `≥8` 位就放行——`password`、`12345678` 这种全网泄露过的照样过。这两条指向同一类攻击：**密码爆破**。Day 35 的限流挡的是「同一来源 IP 的洪泛」，可攻击者换个代理池，每个 IP 都没超阈值，照样能对**同一个账号**慢速撞库。这一天就把这个窟窿补上——给登录加一道**按账号**的闸，顺手把密码策略、请求体上限一起收掉，最后把整套安全防线拉成一张全景图。
>
> 之所以叫 v2.0：到这里博客系统在「正确性」之外第一次有了「可信度」——别人能登录、能发帖、能传图，但**不是任何人、用任何姿势**都能。

## 📋 今日目标

- 给登录加一道**按账号的爆破防护（账号锁定）**，并说清它和 Day 35「按 IP 的限流」为什么是**正交**的两层、缺一不可
- 把注册密码从「只看长度」升级成**强度策略**（字符类别 + 常见密码黑名单），并理解 NIST 新规和老式复杂度要求的张力
- 给 JSON 请求体加一道**显式体积上限**，并把超大请求从「默认 500」纠正成「干净利落的 413」
- 复盘**纵深防御（defense in depth）**：把 Day 32–39 的每一道闸拉成一张「威胁 → 在哪挡」的全景表，说清「每一层都假设前一层被绕过」是什么意思
- 沿用一以贯之的「**可选基础设施**」哲学：锁定状态落在 Redis，连不上就静默降级，绝不让安全层拖垮登录主流程

> 配套代码：`solutions/blog/blog-api/`。新增 `src/cache/login-attempt.service.ts`（账号锁定计数，Redis 实现）、`src/common/validators/is-strong-password.validator.ts`（密码强度校验器）、`test/hardening.e2e.test.ts`（锁定 / 强度 / 体积上限集成测试）；
> `RedisService` 加 `incrWithTtl`（带 TTL 的原子计数器）；`AuthService.login` 前置锁定闸 + 失败计数 + 成功清零；`RegisterDto.password` 换成 `IsStrongPassword`；`AllExceptionsFilter` 把超大请求体翻译成 `413 BODY_TOO_LARGE`；`main.ts` 显式设 JSON 体积上限；配置加 `auth.lockout` / `http.bodyLimitKb` 块。

---

## 📖 核心知识点

### 1. 这天在解决什么：把爆破这一类攻击的窟窿堵上

先把 Day 35–39 留下的安全尾巴摆出来，对照今天怎么补：

| 留的问题（出处） | 后果 | Day 40 的对策 |
|---|---|---|
| 限流**按 IP、且进程内**（Day 35/37） | 攻击者用代理池，每 IP 都没超阈值，照样慢速撞**同一账号** | **账号锁定**：按 email 计数，与 IP 限流正交 |
| 注册密码只 `≥8` 位（Day 32） | `password`、`12345678` 这种全网泄露过的密码照过 | **强度策略**：字符类别 + 常见密码黑名单 |
| 请求体大小靠 Express 隐式默认 | 默认值跨版本会变；超大 JSON 整坨进内存 | **显式体积上限**，解析阶段就拒成 413 |
| 超大请求体报错默认落到 **500** | 客户端错误被误报成服务端故障，污染 5xx 告警 | 过滤器识别后翻译成 **413 BODY_TOO_LARGE** |

带着这张表读后面每一节，会发现它们都在回答同一个问题：**怎么让登录这条最高危的路径，多几道彼此独立、互为补位的闸。**

### 2. 账号锁定：为什么和「按 IP 限流」是两层，不是替代

先把两个概念彻底分开，这是今天最容易混的点：

- **限流（Day 35）**：按 **IP**。挡的是「同一个来源 IP 在短时间内发太多请求」——洪泛攻击、脚本无脑刷。阈值是「这个 IP 一分钟最多 30 次登录」。
- **锁定（今天）**：按 **账号（email）**。挡的是「针对**同一个账号**反复试密码」——爆破、撞库。阈值是「这个账号连续失败 5 次就锁 15 分钟」。

它们正交，因为攻击向量不同：

```
攻击者拿一个代理池（100 个 IP），对 victim@x.com 慢速撞库：
  - 按 IP 限流：每个 IP 一分钟才打 1 次 → 全都远低于 30 阈值 → 全部放行 ❌
  - 按账号锁定：不管来自哪个 IP，victim@x.com 这个 key 的失败计数累加 → 5 次后锁死 ✅
```

反过来：

```
攻击者用一个 IP，对 1 万个不同账号各试 1 次密码（撞库泄露的密码表）：
  - 按账号锁定：每个账号只失败 1 次 → 都不锁 ❌（这种得靠「单 IP 对多账号」的限流）
  - 按 IP 限流：一个 IP 1 分钟内 1 万次登录 → 早早超 30 阈值 → 拦下 ✅
```

**一句话：IP 限流挡「一个 IP 打很多次」，账号锁定挡「很多 IP 打一个账号」。两层都要有，单独任何一层都堵不住对方擅长的那种攻击。**

落地（`src/cache/login-attempt.service.ts`）。状态落在 Redis 的一个**带 TTL 的计数器** key：

```
loginfail:victim@x.com = 失败次数
  首次失败时起算窗口（默认 900s）→ 到期 key 自动消失 → 账号自动解锁
```

三个方法各管一段：

```ts
// 锁没锁？登录入口先问它——锁了就省掉 bcrypt 比对，直接拒
async isLocked(email) {
  if (!this.redis.available) return false;        // Redis 不通 = 不锁（降级）
  const n = Number(await this.redis.get(this.key(email)));
  return Number.isInteger(n) && n >= this.maxAttempts;
}
// 记一次失败。incrWithTtl 用 Lua 把「自增 + 首次设过期」原子合一（见 §3）
async recordFailure(email) {
  if (!this.redis.available) return { attempts: 0, locked: false };
  const attempts = await this.redis.incrWithTtl(this.key(email), this.windowSec);
  return { attempts, locked: attempts >= this.maxAttempts };
}
// 成功就抹掉——否则用户偶发手滑几次后，计数器会一直挂着顶到阈值
async clear(email) {
  if (!this.redis.available) return;
  await this.redis.del(this.key(email));
}
```

**为什么状态放 Redis 而不是数据库**：和 Day 36/37 的缓存、锁一个道理——锁定是「真相源之外的可选层」，要**高频写**（每次失败登录都要 +1）、且**连不上绝不能拖垮登录**。Redis 的 `INCR` 是原子操作，多实例并发失败计数不丢不重；数据库得加行锁，慢且没必要。这套代码从 Day 36 起就把 Redis 当「可选层」：连不上静默降级（`isLocked` 恒 false），登录照常走——哪怕少了这层防护，也不让安全配置连累可用性。这和 Day 39 选 S3 存储「配错就启动崩」的 fail-fast **刻意相反**：锁定是锦上添花，不是运营命脉。

### 3. 带_ttl_的原子计数器：又见 `INCR + EXPIRE` 的老坑

`recordFailure` 靠一个「自增 + 首次设过期」的计数器。直觉写法是两条命令：

```ts
const n = await client.incr(key);   // 失败次数 +1
if (n === 1) await client.expire(key, ttl);  // 第一次才设过期
```

这有个经典竞态，和 Day 37 分布式锁里 `SETNX` + `EXPIRE` 的老坑**同构**：`INCR` 之后、`EXPIRE` 之前进程崩了，这个 key 就**永不过期**——某邮箱的一次失败永远占着内存，而且账号会被**永久误锁**（计数器永远 ≥ 阈值）。

解法和 Day 37 一样：用一条 **Lua 脚本**把两步合一，Redis 保证单条 Lua 原子执行（脚本跑的时候别的命令都得排队）。`RedisService` 包了个 `incrWithTtl`：

```ts
// src/cache/redis.service.ts
async incrWithTtl(key, ttlSeconds): Promise<number> {
  const script = `
    local n = redis.call('INCR', KEYS[1])          -- 自增
    if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end  -- 仅首次设过期
    return n
  `;
  const n = await this.client.eval(script, 1, key, ttlSeconds);
  return typeof n === 'number' ? n : 0;   // 出错降级成 0（调用方据此不锁定）
}
```

**`n == 1` 才 `EXPIRE`** 是关键：后续失败只 `INCR`、不续期。于是窗口**固定从首次失败起算**——到点整个计数器归零、账号自动解锁，无需人工介入，也绝不会永久误锁。这是「时间锁」相对「次数锁永久封」的安全优势：宁可让攻击者 15 分钟后重试，也不能把真实用户彻底锁死在门外。

> 生产里更细的做法会把「窗口」和「锁定期」**解耦**：窗口（比如 15 分钟滑窗）决定「失败计数在多长时间内累加」，锁定期（比如 30 分钟）决定「达到阈值后锁多久」。我们这里简化成两者相等（都是 `LOGIN_LOCK_MINUTES`）——够讲清原理，省一个配置项。需要分开时，多一个 `loginlock:<email>` 的 `SET NX EX` key 即可。

### 4. 锁定的三段式与几个反直觉点

把锁定接进 `AuthService.login`（`src/auth/auth.service.ts`），有三段，顺序和细节都有讲究：

```ts
async login(dto: LoginDto) {
  // ① 锁定闸：优先于一切。锁了就省掉 bcrypt（省 CPU）、也避免对已锁账号再泄露信息
  if (await this.loginAttempts?.isLocked(dto.email)) {
    throw new BusinessException(ErrorCodes.ACCOUNT_LOCKED, '…', 423 as HttpStatus);
  }
  const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
  const ok = await bcrypt.compare(dto.password, user?.password ?? DUMMY_HASH);  // 常量时间
  if (!user || !ok) {
    // ② 失败计数：达阈值即锁。不区分「用户不存在 / 密码错」
    await this.loginAttempts?.recordFailure(dto.email);
    throw new BusinessException(ErrorCodes.INVALID_CREDENTIALS, '邮箱或密码错误', 401);
  }
  // ③ 成功清零
  await this.loginAttempts?.clear(dto.email);
  return this.authResponse(user, await this.tokens.issue(user));
}
```

四个反直觉点，每个都对应一个真实坑：

**① 锁定闸放在 bcrypt 之前，会破坏「常量时间登录」吗？**

不会，但要想清楚边界。Day 32 引入常量时间登录（用户不存在也跑一次 bcrypt），是为了挡「靠响应耗时判断邮箱是否注册」的**时序枚举**。锁定闸在它之前返回（更快），确实让「已锁账号」的响应比「正常失败」快——但这不是问题：锁定状态本身就是要**显式告诉用户**的（`ACCOUNT_LOCKED`），它不再是「不可见的时序信号」，而是「有意的 UX 反馈」。真正要保护的常量时间性质是 **INVALID_CREDENTIALS 那条路径**（用户不存在 vs 密码错，都走 bcrypt，耗时一致）——这条没动，依然安全。

**② 为什么「用户不存在」也要计失败？**

看 ② 那行：不管 `user` 是否存在，失败都对 `dto.email` 计数。反例是「用户不存在就跳过计数」——可这个**差行为本身就是枚举信号**：攻击者试 `a@x.com`（不存在，不计失败）和 `b@x.com`（存在，计失败），靠「会不会触发锁定」反推出哪些邮箱注册过。所以**一律计**，把差异抹平。

**③ 锁定会变成 DoS 武器吗？**

会，这是账号锁定的固有代价。攻击者知道 `victim@x.com` 存在，故意用错密码连打 5 次，把受害者账号锁 15 分钟——**拒绝服务**。两个缓解：(a) 锁是**时间锁**（自动解锁），不会永久封；(b) 阈值 + 锁定期可调，给「慢速、不惊动用户」留余地。生产里更稳的是「锁定后要求验证码 / 邮件解锁」而非纯时间锁，把成本转回攻击者。这个权衡写进了诚实清单。

**④ 为什么用 423，不是 429？**

IP 限流命中是 `429 RATE_LIMITED`（Day 35）。账号锁定用 **`423 Locked`**（RFC 4918）——语义更准：账号被锁，不是「频率太快」（429），也不是「你没权限」（403）。两者 HTTP 状态不同、业务码不同（`ACCOUNT_LOCKED` vs `RATE_LIMITED`），前端能各走各的处理分支。Nest 的 `HttpStatus` 枚举里没有 423，所以传数字字面量 `423 as HttpStatus`（业务码才是前端真正 key 的东西，状态码只是载体）。

> 测试里有个值得单独记的坑：Redis 依赖的用例要**运行时** `t.skip()`，不能用 `{ skip: !redisAvailable }` 注册期选项——后者在 import 阶段求值，那时 `before()` 还没跑、`redisAvailable` 恒 `false`，用例会被**无条件 skip**。这是 node:test 的求值时机，和 Day 39「env 必须在 import 前就位」是同一类「求值时机」陷阱。

### 5. 密码强度策略：NIST 新规和老式复杂度的张力

注册密码从「`@MinLength(8)`」升级成一个自定义校验器（`src/common/validators/is-strong-password.validator.ts`，和 Day 的 `IsSlug` 同款写法）：

```ts
validate(value: unknown): boolean {
  if (typeof value !== 'string' || value.length < 8 || value.length > 100) return false;
  // 至少 3 种字符类别：小写 / 大写 / 数字 / 符号
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  if (/[^a-zA-Z0-9]/.test(value)) classes++;
  if (classes < 3) return false;
  // 常见密码黑名单——即便「看起来」够复杂（如 Passw0rd!）也拒
  if (COMMON_PASSWORDS.has(value.toLowerCase())) return false;
  return true;
}
```

这里有个**有意思的认知冲突**值得讲透：NIST 800-63B（现行密码规范）其实**反对**强制复杂度规则，它推荐的是——

1. **长度优先**（≥8，鼓励更长，≥16 更好）；
2. **查泄露密码库**（拒掉在数据泄露里出现过的密码）——这是它认为**最有效**的一条；
3. **不要**强制「大小写+数字+符号」组合（用户应付了事会写 `Password1!`，反而好猜）。

可绝大多数公司**仍然**要求复杂度。为什么？因为「查泄露库」要联网（调 HaveIBeenPwned 的 k-anonymity API），离线 / 内网环境做不到，复杂度成了「不依赖外部服务、本地就能算」的替代。所以我们**两者都做**：黑名单（NIST 推荐的那条的简化版）+ 复杂度（离线兜底）。诚实清单里记了：我们的黑名单是个 ~30 条的静态集合，真实生产该接 HIBP 的 k-anonymity 查询（只传密码哈希前 5 位，既查泄露库又不泄露密码本身）。

**只校验注册，不校验登录**——这是另一条铁律，写在校验器注释里。密码规则会随时间收紧，**绝不能拿今天的新规则卡住昨天注册的老用户**：他们用的是当年合规、今天不够强的旧密码，登录时强校验会把他们直接挡在门外。所以 `LoginDto.password` 只有 `@IsString()`，强度校验只在 `RegisterDto` 上。这也呼应 Day 27「数据库是真相源」的审慎：存量数据不被后来的代码变更否定。

### 6. 请求体上限：把一个本该是 413 的错误，从 500 里救回来

Express 默认对 JSON 请求体有 100KB 上限（`body-parser` 的 `limit`）。两件事要做对：

**① 把隐式默认变成显式配置。** 默认值跨 Express 版本会变，且「我的 API 到底允许多大的 body」不该是个谜。`main.ts` 显式设：

```ts
app.useBodyParser('json', { limit: `${config.get('http.bodyLimitKb', { infer: true })}kb` });
```

配置驱动（默认 100KB），部署时可调。文件上传走 multipart，由 Day 39 的 multer `fileSize` 闸管，不经这条 json 解析——两套上限各管各的。

**② 超限时报对状态码。** 这是真坑：body-parser 抛的「请求体过大」是个**普通 `Error`，不是 `HttpException`**。我们的 `AllExceptionsFilter` 对未知异常的默认处理是 `500 服务器内部错误`——可「请求体太大」明明是**客户端**错误，让它落到 500 既误导前端、又污染 5xx 告警（半夜被这种「客户端乱发大 body」的告警叫醒）。

修法在过滤器里识别它的特征签名（`type === 'entity.too.large'` 或 `status === 413`），翻译成干净的 `413 BODY_TOO_LARGE`：

```ts
// src/common/filters/all-exceptions.filter.ts
if (!isHttp && isPayloadTooLarge(exception)) {
  status = HttpStatus.PAYLOAD_TOO_LARGE;       // 413
  payload.code = ErrorCodes.BODY_TOO_LARGE;
  payload.message = '请求体过大，请减小提交内容';
}
```

顺带把日志条件从 `if (!isHttp)` 收紧成 `if (!isHttp && status >= 500)`——否则一个 413 会被当成「服务端 bug」打全栈。**把客户端错误和服务端故障在日志层也分开**，是「能复盘」的前提：5xx 才该进 error 级别、触发告警。

> 这和 Day 35 过滤器把 `429 ThrottlerException` 翻译成 `RATE_LIMITED` 是同一个套路：框架/中间件抛的「裸」错误，到统一外壳里都要有对应的业务码，前端才能用一套逻辑处理。

### 7. 纵深防御全景图：把 Day 32–39 的每一道闸拉成一张表

到了里程碑日，值得把整套安全防线摊开看——**每一层都假设前一层被绕过**：

| 威胁 | 挡它的层 | 在哪 | 出处 |
|---|---|---|---|
| 伪造 token / 算法混淆（`alg:none`） | HS256 写死，验证不看 token 头的 alg | `AuthModule` JwtModule 配置 | Day 31/32 |
| 撞库 / 暴力破解（按 IP） | 按 IP 限流，登录路径 `@Throttle(30/min)` | `AuthController` + 全局 ThrottlerGuard | Day 35 |
| 撞库 / 暴力破解（按账号） | **账号锁定**，连续失败锁死 | `LoginAttemptService` + `login()` | **Day 40** |
| 时序枚举（邮箱是否注册） | 常量时间登录（用户不存在也跑 bcrypt） | `AuthService.login` + `DUMMY_HASH` | Day 32 |
| 弱密码注册 | **强度策略**（类别 + 黑名单） | `RegisterDto` + `IsStrongPassword` | **Day 40** |
| refresh token 泄露 / 重放 | 只存 sha256 哈希、轮换、一次性、可撤销 | `TokensService` | Day 31/32 |
| 越权（改别人的文章） | 资源级权限（owner / admin） | `PostsService.assertCanModify` | Day 33 |
| 越权（管理员功能） | 角色级权限 RBAC | `RolesGuard` + `@Roles('admin')` | Day 33 |
| OAuth 回调被 CSRF / 重放 | state 一次性消费 | `OAuthStateStore` | Day 34 |
| 请求参数污染 / 类型错 | 全局 `ValidationPipe`（whitelist + forbidNonWhitelisted） | `CommonModule` | Day 18 |
| SQL 注入 | 参数化查询（Prisma），恶意 payload 当普通词 | `PrismaPostsRepository` | Day 27（Day 35 测过） |
| XSS（API 侧） | 不渲染 HTML，输出是 JSON；`nosniff` 禁 MIME 嗅探 | 响应设计 + Helmet | Day 35 |
| 点击劫持 | `X-Frame-Options: SAMEORIGIN` | Helmet | Day 35 |
| 文件上传：图片炸弹 / 改名伪装 / 目录穿越 | 体积上限 + MIME 白名单 + Sharp 字节核验 + uuid key | `storage/*` | Day 39 |
| 大 payload DoS（JSON） | **显式体积上限**，解析阶段拒成 413 | `main.ts` + 过滤器 | **Day 40** |

读这张表的方式：**纵向**看每个威胁被哪层挡（很多威胁有多层冗余，比如爆破有 IP + 账号两道）；**横向**看每层挡什么。没有任何一层是「银弹」——拿掉任何一行，对应那一列的威胁就会漏过去。这就是 defense in depth 的全部含义：**不指望任何单层完美，靠层数和冗余把整体失守概率压到极低。**

今天补的三行（按账号锁定、弱密码、大 payload）填的正是这张表里「爆破」「弱密码」「大 payload」三个之前**只有半道闸**的位置。

### 8. 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `src/cache/login-attempt.service.ts` | **新增**：账号锁定。`isLocked` / `recordFailure` / `clear`，Redis 不通即降级 |
| `src/cache/redis.service.ts` | 加 `incrWithTtl`：Lua 原子的「自增 + 首次设过期」（堵 `INCR`+`EXPIRE` 竞态） |
| `src/cache/cache.module.ts` | 提供 + 导出 `LoginAttemptService`（@Global，AuthModule 直接注入） |
| `src/auth/auth.service.ts` | `login()` 前置锁定闸 + 失败计数 + 成功清零；`@Optional` 注入 `LoginAttemptService` |
| `src/auth/dto/register.dto.ts` | `password` 从 `@MinLength(8)` 换成 `@IsStrongPassword`（类别 + 黑名单） |
| `src/common/validators/is-strong-password.validator.ts` | **新增**：密码强度校验器（≥3 类字符 + 常见密码黑名单） |
| `src/common/constants/error-codes.ts` | 加 `ACCOUNT_LOCKED`（423）、`BODY_TOO_LARGE`（413） |
| `src/common/filters/all-exceptions.filter.ts` | 识别 body-parser 的 413 → 翻译成 `BODY_TOO_LARGE`；日志条件收紧到 `status>=500` |
| `src/main.ts` | `useBodyParser('json', { limit })` 显式设 JSON 体积上限（配置驱动） |
| `src/config/{configuration,config.validation}.ts` | 加 `auth.lockout`（maxAttempts/windowSec）+ `http.bodyLimitKb`；env 加 `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MINUTES` / `HTTP_BODY_LIMIT_KB` |
| `.env.example` | 文档化三个新环境变量（含默认值与含义） |
| `test/hardening.e2e.test.ts` | **新增**：账号锁定（连错即锁 / 成功清零）/ 密码强度（弱拒强过 / 登录不卡）/ 请求体 413 |

### 9. 一份诚实清单

✅ **今天到位的：**
- 账号锁定：按 email 计数、Redis 实现、自动解锁（时间锁）、连不上静默降级
- 锁定与 IP 限流正交，两层叠加覆盖「一 IP 多次」和「多 IP 一账号」两种爆破
- 失败计数不区分用户存不存在（堵枚举）；成功即清零
- 密码强度：字符类别 + 常见密码黑名单，仅作用于注册（不卡老用户）
- 请求体显式上限 + 超限翻译成干净 413（不再误落 500）
- 纵深防御全景图：把 Day 32–39 的安全闸拉成一张「威胁 → 在哪挡」的表

⚠️/❌ **还没做、明确知道的缺口：**
- **锁定可被用作 DoS**：攻击者故意错输可锁死受害者账号。现仅靠「时间锁自动解锁」缓解；生产该上「锁定后要求验证码 / 邮件解锁」，把成本转回攻击者
- **密码黑名单是静态小集合**：~30 条常见密码，不是真实的泄露库；生产应接 HaveIBeenPwned 的 k-anonymity 查询（传哈希前 5 位，既查泄露又不泄露密码）
- **refresh token 仍在响应体里**（不是 httpOnly cookie）：SPA 存 localStorage，XSS 能偷；生产级做法是 httpOnly + Secure + SameSite cookie，但那要连带做 CSRF 防护（Bearer token 方案下 CSRF 基本不适用，换 cookie 后必须补）
- **限流仍是进程内按 IP**（Day 35/37 留的尾巴）：多副本部署额度翻倍；要真正全集群一致，得换 Redis 后端的 throttler（`@nestjs/throttler` + `storage-redis`）
- **锁定信息轻微泄露枚举面**：`ACCOUNT_LOCKED` 暴露「这个邮箱注册过且正被攻击」。这是「要让真实用户知道为啥登不上」的 UX 取舍，可接受；极致做法是锁定也回 `INVALID_CREDENTIALS`（牺牲 UX 换零信息泄露）
- **没有依赖漏洞扫描**：没接 `npm audit` / SCA；供应链安全（依赖里的已知 CVE）是另一条独立防线
- **没做注册的「按账号」限流**：只有按 IP 的；攻击者用多 IP 批量注册垃圾账号不会被账号维度拦
- **生产 CSP 需复核**：Day 35 的 Helmet CSP 只在生产开，且没针对真实前端资源做白名单调校

---

## 💻 实践练习

1. **亲眼看锁定生效**：起服务、注册一个账号，然后故意连输 5 次错密码：
   ```bash
   for i in 1 2 3 4 5; do
     curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/auth/login \
       -H 'Content-Type: application/json' \
       -d '{"email":"you@x.com","password":"definitely-wrong"}'
   done   # 五次都应是 401
   # 第 6 次——哪怕用【正确】密码——应被锁成 423
   curl -s -X POST http://localhost:3000/auth/login -H 'Content-Type: application/json' \
     -d '{"email":"you@x.com","password":"你的正确密码"}'   # → 423 ACCOUNT_LOCKED
   ```
   再 `docker exec redis-blog redis-cli GET loginfail:you@x.com`，亲眼看计数器顶到阈值。等 15 分钟（或手动 `DEL`）后账号自动恢复。
2. **验证成功清零**：注册新账号，连输 3 次错（默认阈值 5，没锁），再用**正确**密码登一次（成功、清零），然后再错 1 次、再正确登一次——应照常 200。说明计数器被成功那次抹掉了，没累加。
3. **验证密码强度**：注册时分别试 `abcdefgh`（单类别）、`password123`（黑名单）、`S3cure-pass!`（合规），前两个应 `400 VALIDATION_ERROR` 且 `errors` 里带 password 字段，第三个 `201`。再用 `abcdefgh` 这种老弱密码**登录**——注意登录不卡强度（铁律：新规则不卡老密码）。
4. **验证请求体 413**：发一个超过 100KB 的 JSON：
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/auth/register \
     -H 'Content-Type: application/json' \
     -d "{\"username\":\"x\",\"password\":\"$(python3 -c 'print("y"*200000)')\"}"   # → 413
   ```
   应是 `413 BODY_TOO_LARGE`，不是 `500`。对照发个小 body，是 `400`（校验失败），不是 `413`。
5. **思考题**：攻击者不知道 `victim@x.com` 的密码，但知道这个邮箱注册过。他写个脚本，每 14 分钟用错密码登一次（永远到不了「连续失败」的阈值，因为窗口会刷新……真的会吗？）。他能把受害者锁死吗？我们的「窗口固定从首次失败起算」设计，对这种「慢速保持锁定」的攻击是友好还是不友好？（提示：看 §3 那条 `n == 1 才 EXPIRE`——窗口**不随后续失败续期**，所以攻击者只要每次失败间隔 < 锁定期，计数会一直累加到锁定，且锁定期内继续失败也不会让窗口后移。这是「时间锁」的副作用。）
6. **思考题二**：为什么锁定状态放 Redis、配错降级，而 Day 39 的 S3 存储配错却要启动即崩？把 §2 那句判据（「瞬时故障降级 vs 显式配置缺失 fail-fast」）再讲一遍——如果 Redis 存的是「真相」（比如换成了数据库当锁定计数源），降级姿势该不该变？（答：锁定始终是「真相源之外的可选层」——哪怕记在 DB 里，它也只是登录的辅助闸，挂了就该降级，不该让登录跟着挂。判据是「这层挂了主流程能不能活」，不是「这层记在哪」。）

---

## ✅ 今日产出

- [ ] 完成核心知识点学习（账号锁定 vs IP 限流 / 原子计数器 / 密码强度与 NIST 张力 / 413 纠错 / 纵深防御全景）
- [ ] 跑通 `hardening.e2e.test.ts`，用 `curl` 亲手把账号锁出 423、把请求体顶出 413
- [ ] 在笔记里写下「我的系统里 IP 限流和账号锁定各挡什么、为什么两层都要」
- [ ] 把 §7 的纵深防御全景表对照自己的项目填一遍，标出哪几行还缺
- [ ] 提交代码到 GitHub，打上 v2.0 标签

---

[⬅️ Day 39](../day-39/) | [➡️ Day 41](../day-41/)
