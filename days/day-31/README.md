# Day 31 — 认证基础：Session vs JWT

> 阶段三（认证、安全与缓存）开篇。今天是**概念地基**——把"登录态怎么记住"这件事彻底想清楚；
> Day 32 才动手把 JWT、bcrypt、双 Token 接进 blog-api。

## 📋 今日目标

- 先分清两个总被混为一谈的词：**认证（Authentication）**和**授权（Authorization）**
- 理解两种"记住登录态"的范式：**有状态 Session** vs **无状态 JWT**，各自的请求流程
- 把 **JWT 结构**看穿：`header.payload.signature` 到底是什么、为什么能被信任
- 记住一条容易要命的事实：**JWT 不是加密**，以及由此带来的安全注意（`alg:none`、算法混淆、secret 泄露）
- 想清楚无状态的代价——**无法即时撤销**，以及它怎么催生了 access + refresh 双 Token
- 会按场景选型：什么时候 Session，什么时候 JWT，以及现实里怎么混用

> 配套代码：`solutions/auth-basics/`——**零依赖**手写一个 JWT（只用 `node:crypto`）看穿结构，
> 再用一个 demo 对比 Session / JWT 的"登出"差异。先跑一遍再读，体感最强。

---

## 📖 核心知识点

### 1. 先分清：认证 vs 授权

两个词常被混用，但解决的是不同问题：

- **认证（Authentication, authn）**：**你是谁**？——核对凭据（密码、验证码、第三方登录），确认身份。
- **授权（Authorization, authz）**：**你能干什么**？——已知身份后，判断有没有权限做某操作。

Day 31–32 解决 authn（登录、记住登录态），Day 33 的 RBAC 解决 authz（角色权限）。今天只谈：**核对完密码之后，怎么在后续请求里记住"你已经登录了"**——这才是 Session vs JWT 要回答的问题。

> 核对密码本身（bcrypt 慢哈希 + salt，绝不明文存）是 Day 32 的实战；这里先记住一句：**密码只存哈希，且要用 bcrypt/argon2 这类「慢」哈希**，别用 md5/sha256 这种快哈希。

### 2. 问题的本质：HTTP 是无记忆的

HTTP 每个请求都是独立的，服务端默认不记得你上一个请求是谁。登录成功后，怎么让接下来的请求都被认出来？两条路：

- **有状态（Session）**：服务端**记住**你登录了（存一条会话），给你一张"号码牌"（sessionId）。之后你出示号码牌，服务端查表认人。
- **无状态（JWT）**：服务端**不记**任何东西，给你一张**自带签名、防伪造**的"身份证"（token）。之后你出示它，服务端验签就认人，不查表。

一句话：**Session 把状态放服务端，JWT 把状态放 token 里**。下面分别看。

### 3. 有状态 Session：服务端记账

```
登录：
  POST /login (密码) ──► 服务端核对 ──► 在 session store 写一条 { sid → userId }
                       ◄── Set-Cookie: sid=abc...（HttpOnly）

后续请求：
  GET /me (Cookie: sid=abc) ──► 服务端拿 sid 查 session store ──► 查到 userId，认人
登出：
  POST /logout ──► 服务端 **删掉** 这条 session ──► 号码牌当场作废
```

要点：
- **cookie 里只有一个不透明的 sessionId**，本身不含任何信息（不像 JWT 自带 userId）。
- **session store 在哪**：单机可放内存，但多实例 / 重启会丢，生产放 **Redis**（Day 36）。
- **cookie 属性**是安全关键：`HttpOnly`（JS 读不到，防 XSS 偷 cookie）、`Secure`（只走 HTTPS）、`SameSite`（防 CSRF）。
- **撤销很简单**：删 session 记录即可，**即时生效**。

### 4. 无状态 JWT：token 自证身份

JWT（JSON Web Token）是一个**自带签名**的字符串，三段用 `.` 拼起来：

```
eyJhbG...（header）  .  eyJzdWI...（payload）  .  u5CK1R...（signature）
```

- **Header**：`{ "alg": "HS256", "typ": "JWT" }`——用什么算法签的。
- **Payload**：**声明（claims）**，比如 `{ "sub": "user-123", "role": "admin", "iat": ..., "exp": ... }`。
- **Signature**：对 `base64url(header).base64url(payload)` 用 secret 做的签名。

前两段是 **base64url 编码**（不是加密！），第三段是签名。`solutions/auth-basics/src/jwt.ts` 用 30 行 `node:crypto` 把它实现了一遍——跑 `pnpm demo:anatomy` 看它拆开长什么样。

**常见 claims（注册声明）**：

| claim | 含义 |
|-------|------|
| `iss` | issuer，签发者 |
| `sub` | subject，主体（通常是 userId）|
| `aud` | audience，受众（这个 token 给谁用）|
| `exp` | 过期时间（秒级时间戳）★最重要 |
| `iat` | 签发时间 |
| `nbf` | not before，此刻之前不生效 |
| `jti` | JWT id，唯一标识（做黑名单/防重放用，见 §7）|

请求流程：

```
登录： POST /login ──► 核对密码 ──► sign({sub, role}, secret, {exp}) ──► 返回 token（服务端不存）
后续： GET /me (Authorization: Bearer <token>) ──► 服务端 verify(token, secret) ──► 验签+验exp通过即认人
```

服务端**不查任何表**，信任完全来自"签名对 + 没过期"。

### 5. 签名算法：HS256 vs RS256

- **HS256（对称）**：HMAC + 一个**共享 secret**。同一个 secret 既签发又验证。简单，适合**单体应用 / 一个服务自签自验**。secret 必须够长够随机，且**泄露 = 任何人都能伪造任意 token**。
- **RS256（非对称）**：RSA **私钥签发、公钥验证**。适合**多服务 / 第三方**：认证中心用私钥签，各资源服务用公钥验（公钥可公开，泄露公钥不影响安全）。

口诀：**自己签自己验 → HS256；一处签、多处/外部验 → RS256**。

### 6. 要命的认知：JWT 不是加密

这是新手最容易栽的地方：

- **payload 只是 base64 编码，谁都能解开读**（`pnpm demo:anatomy` 第 2 步亲眼看到）。所以**绝不能往 payload 放密码、密钥、隐私数据**。
- JWT 能被信任，**不是因为"读不到"，而是因为"改不动"**——改了 payload，签名就对不上（demo 第 4 步演示篡改 → `bad-signature`）。**防篡改靠签名，不靠保密**。

由此引出几个**安全坑**，面试常考、线上真出过事：

- **`alg: none` 攻击**：早期一些库会信任 header 里的 `alg`，攻击者把 `alg` 改成 `none`、去掉签名，库就"验过了"。**对策：服务端固定期望算法，绝不接受 `none`，绝不让 token 自己决定用什么算法验。**
- **算法混淆（RS256 → HS256）**：验证方若用"密钥"既能当 RSA 公钥又能当 HMAC secret，攻击者拿公开的公钥当 secret 用 HS256 签一个，就骗过验证。**对策：固定算法，公钥/私钥用途分开。**
- **secret 太弱 / 泄露**：HS256 的 secret 一旦泄露，全线失守。用足够长的随机串，放环境变量，别进代码库。

好消息：用成熟库（`@nestjs/jwt` / `jsonwebtoken`）并**显式 pin 算法**，这些坑基本都堵上了。手写只为理解，生产别手写。

### 7. 无状态的代价：撤销难

JWT 最大的优点（服务端不存）也是它最大的痛点：**已经签发的 token，在 `exp` 到点前服务端没法让它立刻失效**。`pnpm demo:session-vs-jwt` 的 B 段演示得很清楚——用户点了"登出"，可服务端根本没存这个 token，无从作废，它还能继续用。

现实里的应对：

1. **access token 设短 exp**（如 15 分钟），降低被盗后的危害窗口。
2. **配一个 refresh token**（长一点、**落库可撤销**）：access 过期后拿 refresh 换新的 access。登出 / 改密 / 风控时，**删库里的 refresh** 即可阻止续期。这就是 **Access + Refresh 双 Token**（Day 32 实战）。
3. **黑名单（blocklist）**：给 token 加 `jti`，登出时把 jti 拉黑（放 Redis，TTL 到 exp）。能即时撤销——**但每次请求都要查黑名单，等于把"状态"加回来了**（demo C 段演示）。

记住这个权衡：**纯无状态省了存储和查询，但买不到"即时撤销"**。

### 8. token 存客户端哪里？（XSS vs CSRF 的权衡）

- **localStorage**：JS 能读 → 方便带进 `Authorization` 头；但**一旦 XSS，token 直接被偷**。
- **HttpOnly Cookie**：JS 读不到（防 XSS 窃取），浏览器自动带上；但要防 **CSRF**（配 `SameSite` + CSRF token）。

没有银弹，是两类攻击之间的权衡。Day 32 会展开，并给 blog-api 选一种落地。

### 9. 怎么选：决策表

| 场景 | 选 |
|------|----|
| 单体 / 传统服务端渲染、需要即时登出、同一域 | **Session**（配 Redis 存储）|
| 多服务 / 微服务、不想共享会话存储 | **JWT**（资源服务验签即可，常用 RS256）|
| 移动端 / 第三方 API / 无 cookie 场景 | **JWT** |
| 既要无状态又要能撤销 | **混用**：JWT 短 access + 落库的 refresh |

**别教条**：大多数真实系统是**混用**——用 JWT 做无状态的 access token（性能、免共享存储），用可撤销的 refresh token 把"登出/失效"补回来。

---

## 💻 实践练习

### 主练习：跑透 auth-basics playground

```bash
cd solutions/auth-basics
pnpm install
pnpm demo:anatomy          # 看穿 JWT 三段结构 / 防篡改 / 不能放秘密 / 过期
pnpm demo:session-vs-jwt   # 有状态 vs 无状态，登出/撤销的本质差异
```

读 `src/jwt.ts`——**30 行实现一个 HS256 JWT**，确认你能讲清 sign / verify 每一步在干什么。

### 加分练习：自己想答案再看

1. **把 demo 里的 secret 改掉再 verify 老 token**，解释为什么 `bad-signature`。
2. **手动篡改一个 token 的 payload**（base64 解码 → 改 role → 重新 base64 → 拼回去），不改签名，verify 会怎样？为什么？
3. **`alg: none` 攻击**：如果一个 verify 实现"信任 header 里的 alg"，攻击者能怎么绕过？你的 `verify` 为什么不受影响（提示：它写死了用 HS256 重算）？
4. **画两张时序图**：Session 登录→带 cookie 请求→登出；JWT 登录→带 Bearer 请求→登出。标出"服务端这一步存/查了什么"。
5. **设计一个"既能即时登出又尽量无状态"的方案**——大概率你会推导出 access(短) + refresh(落库) 的组合。

### 验收清单（认证方案分析笔记）

```bash
cd solutions/auth-basics
pnpm typecheck && pnpm demo:all   # 类型干净 + 两个 demo 跑通
```

用自己的话写一页笔记，能回答：
- [ ] 认证 vs 授权的区别
- [ ] Session 和 JWT 各自"状态放哪"，登录/请求/登出三步分别发生什么
- [ ] JWT 三段是什么；为什么"能读不能改"；为什么不能放敏感数据
- [ ] HS256 vs RS256 各自适用场景
- [ ] 无状态为什么难撤销，access+refresh 怎么补救
- [ ] token 存 localStorage vs HttpOnly cookie 的权衡
- [ ] 给定场景能说出选 Session 还是 JWT，并讲出理由

---

## ⚠️ 常见误区

- **把 JWT 当加密**：payload 是明文 base64，谁都能读。防篡改 ≠ 保密。别放敏感数据。
- **认证 = 授权**：两码事。JWT 解决"你是谁"，权限（"你能干啥"）是 Day 33 的 RBAC。
- **JWT 能像 Session 一样即时登出**：不能。已签发的 token 到 exp 前一直有效，除非加黑名单（又变有状态）。
- **access token 设很长的 exp**：被盗危害窗口大。access 短 + refresh 续期才对。
- **secret 写死在代码里 / 用弱 secret**：HS256 的 secret 泄露 = 全线失守。环境变量 + 强随机。
- **信任 token header 里的 alg**：`alg:none` / 算法混淆攻击的根源。服务端固定期望算法。
- **密码用快哈希（md5/sha256）存**：要用 bcrypt/argon2 慢哈希 + salt（Day 32）。
- **以为必须二选一**：现实常混用，JWT access + 可撤销 refresh 是主流组合。
- **localStorage 存 token 觉得很安全**：XSS 能直接偷走。HttpOnly cookie 防窃取但要防 CSRF——是权衡不是银弹。

---

## ✅ 今日产出

- [ ] 能讲清认证 vs 授权、有状态 vs 无状态
- [ ] 能手画 Session 和 JWT 的登录/请求/登出流程，并指出状态放在哪
- [ ] 能拆解 JWT 三段，解释"能读不能改"的原理
- [ ] 知道 JWT 不是加密，以及 `alg:none`/算法混淆/secret 泄露的安全坑
- [ ] 理解无状态的撤销难题与 access+refresh 的应对
- [ ] 跑通 `auth-basics` 两个 demo，读懂 `jwt.ts`
- [ ] 写出"认证方案分析笔记"，能按场景做选型
- [ ] 提交到 GitHub，commit message 写明 "day 31 auth basics: session vs jwt"

---

## 📚 延伸阅读

- [JWT.io — Introduction to JSON Web Tokens](https://jwt.io/introduction)（配交互式 debugger，强烈建议把 demo 的 token 贴进去看）
- [RFC 7519 — JSON Web Token](https://datatracker.ietf.org/doc/html/rfc7519)（claims 的权威定义）
- [OWASP — JSON Web Token for Java Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)（语言无关的 JWT 安全要点）
- [Auth0 — Refresh Tokens](https://auth0.com/docs/secure/tokens/refresh-tokens)（access + refresh 的标准做法）
- [The Copenhagen Book — Sessions](https://thecopenhagenbook.com/sessions)（现代 session 实现的细节，写得很实在）
- [OWASP — Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Critical vulnerabilities in JSON Web Token libraries（alg:none / 算法混淆）](https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/)

---

[⬅️ Day 30](../day-30/) | [➡️ Day 32](../day-32/)
