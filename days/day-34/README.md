# Day 34 — OAuth 2.0 与第三方登录

> Day 32-33 做完了**自己发 token** 的认证/授权。Day 34 换个场景：让用户用 **GitHub 账号**登录，
> 而我们**永远拿不到他的 GitHub 密码**。这就是 OAuth 2.0 要解决的问题——
> "我授权 A 应用访问我在 B 平台的部分资源，但不把 B 的密码交给 A"。

## 📋 今日目标

- 说清 OAuth 2.0 的四个角色，以及它到底解决什么问题（不是"登录协议"，是"授权协议"）
- 走通**授权码模式（Authorization Code Flow）**的完整流程，每一跳传什么、为什么
- 理解 **Client Secret 为什么只能待在服务端**——这是授权码模式 vs 隐式模式的分水岭
- 用 `state` 防 OAuth 的 CSRF（会话固定 / 回调注入）
- 给 blog-api 接上 GitHub 登录：`GET /auth/github` 和 `GET /auth/github/callback` 两个端点
- 设计**第三方用户的建号/绑定策略**，以及"无密码用户"带来的 schema 改动

> 配套代码：`solutions/blog/blog-api/`。新增 `auth/oauth/`（provider + state store + dto），
> `User` 加 `githubId`、`password` 改可空，`AuthService.loginWithGithub`。

---

## 📖 核心知识点

### 1. OAuth 2.0 解决的是"授权委托"，不是"登录"

先纠一个最常见的误解：**OAuth 2.0 本身是授权（authorization）框架，不是认证（authentication）协议。** 它的原始目的是——

> 让"第三方应用"在用户授权下，访问用户存在"资源服务器"上的部分数据，**而不暴露用户的密码**。

经典例子：某个打印照片的网站想读你 Google 相册里的照片。早期做法是你把 Google 密码给它（灾难：它能改你密码、读你邮件、删你账号）。OAuth 的做法是：你跳到 Google，Google 问你"允许 XX 读你的相册吗？"，你点同意，XX 拿到一个**只能读相册、随时可撤销**的令牌——密码全程没离开过 Google。

"用 GitHub 登录"是把这套机制**借来做登录**：我们请求一个"读你 GitHub 基本资料"的授权，拿到资料里的稳定 `id`，就认定"持有这个 GitHub 账号的人 = 我这边的某个用户"。严格的"用第三方做登录"有专门的协议 **OpenID Connect（OIDC）**，它在 OAuth 2.0 之上加了一个标准化的身份令牌（`id_token`，一个 JWT）。GitHub 没实现 OIDC，所以我们走"OAuth + 读 /user 接口"的务实做法；Google / 微软 / Auth0 则建议直接用 OIDC。

### 2. 四个角色

| 角色 | OAuth 术语 | 本例 |
|---|---|---|
| 资源拥有者 | Resource Owner | 用 GitHub 登录的那个人 |
| 客户端 | Client | 我们的 blog-api（想代表用户拿资料）|
| 授权服务器 | Authorization Server | `github.com/login/oauth/*`（发 code、发 token）|
| 资源服务器 | Resource Server | `api.github.com`（拿 token 来读 `/user`）|

GitHub 把授权服务器和资源服务器放在一起，很多家也是。记住"谁发 token、谁验 token"这两个职责即可。

### 3. 授权码模式：完整流程

这是 OAuth 2.0 最主流、最安全的流程，**有自己后端的 Web 应用都该用它**。一图胜千言（A=用户浏览器，B=我们后端，G=GitHub）：

```
A ──①点击"用 GitHub 登录"──> B
B ──②302 跳转到 GitHub 授权页（带 client_id + redirect_uri + scope + state）──> A
A ──③在 GitHub 登录并点"授权"──────────────────────────────────────────> G
G ──④302 回调到 redirect_uri，带 ?code=...&state=...─────────────────> A ──> B
B ──⑤拿 code + client_secret 在【后端】换 access_token（服务器对服务器）──> G
G ──⑥返回 GitHub access_token─────────────────────────────────────────> B
B ──⑦拿 token 读 api.github.com/user 拿到稳定 id────────────────────────> G
B ──⑧在自己库里 找/建 用户，签发【我们自己的】access+refresh──────────> A
```

几个关键点，逐个拆：

- **②里只传 `client_id`，不传 secret**：这一跳经过用户浏览器，是公开的。`client_id` 公开没关系。
- **④回来的是 `code`，不是 token**：`code` 是个一次性、短命（GitHub 约 10 分钟）的"中间凭证"。即使它在浏览器地址栏/日志里泄露，攻击者也**换不出 token**——因为第⑤步还要 `client_secret`。
- **⑤是后端直连 GitHub**：`code` + `client_secret` 在这一跳交换 token，全程服务器对服务器，浏览器看不到。**这就是授权码模式的安全内核：真正值钱的 token，只在后端出现。**
- **⑧发的是我们自己的 token**：GitHub 的 access_token 我们用完即弃（甚至不存），之后用户在我们站点的会话，靠的是我们 Day 32 那套 JWT + refresh。GitHub 只在"登录这一刻"参与。

### 4. Client Secret 为什么只能待在后端

这是今天的安全核心，值得单独讲。OAuth 2.0 历史上还有个**隐式模式（Implicit Flow）**：跳过 code，授权服务器直接把 token 拼在回调 URL 的 `#fragment` 里甩回浏览器。它是当年为"没有后端的纯前端 SPA"设计的——因为 SPA 藏不住 `client_secret`（前端代码人人可见）。

但隐式模式问题很大：token 出现在 URL 里（进浏览器历史、Referer、日志），且没有 `client_secret` 这道"客户端身份证明"。**现在隐式模式已被官方弃用**（OAuth 2.1 直接删了它）。今天所有场景的推荐答案都是授权码模式：

- **有后端的 Web 应用**（我们这种）：授权码模式，`client_secret` 放后端环境变量，完美。
- **纯前端 SPA / 移动 App**（藏不住 secret）：授权码模式 **+ PKCE**（见 §8），用一次性的动态校验码替代固定 secret。

一句话记牢：**`client_secret` 一旦进了前端打包产物，等于公开。任何"前端直接换 token"的设计都是错的。** 在我们的代码里，`client_secret` 只出现在一个地方——`GithubOAuthProvider.exchangeCodeForToken`，跑在后端：

```typescript
// github-oauth.provider.ts —— 唯一用到 client_secret 的地方，在服务端
async exchangeCodeForToken(code: string): Promise<string> {
  const c = this.cfg();
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: c.clientId,
      client_secret: c.clientSecret, // ★ 只在后端出现，绝不下发
      code,
      redirect_uri: c.callbackUrl,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new BusinessException(OAUTH_FAILED, ...);
  return data.access_token;
}
```

### 5. state：OAuth 版的 CSRF 防护

OAuth 回调是个 GET，攻击者能不能伪造一个回调骗你？能——这叫 **OAuth CSRF / 登录会话固定**：攻击者用**自己的** GitHub 拿到一个 `code`，然后诱导**受害者的**浏览器去访问 `你的站点/auth/github/callback?code=攻击者的code`。如果你照单全收，受害者就被静默登录进了**攻击者的账号**，他之后存的东西全在攻击者眼皮底下。

防法是 OAuth 标准参数 `state`：

1. 发起授权前（第②步），后端**生成一个随机 `state`**、记下来，拼进跳转 URL。
2. GitHub 回调时（第④步）会**原样带回** `state`。
3. 后端核对：这个 `state` 是不是我刚发出去的？**一次性消费**（用过即作废，防重放）。对不上 → 拒绝。

攻击者无法预测/伪造一个我们认识的 `state`，于是塞不进合法回调。我们的实现是个内存版一次性存储：

```typescript
// oauth-state.store.ts
generate(): string {
  const state = randomBytes(16).toString('hex');
  this.store.set(state, Date.now() + this.ttlMs); // 记下来 + 10 分钟 TTL
  return state;
}
consume(state: string): boolean {        // 一次性：存在且未过期 → 删掉并返回 true
  const expiresAt = this.store.get(state);
  if (expiresAt === undefined) return false;
  this.store.delete(state);              // ★ 先删，保证用过即失效（防重放）
  return expiresAt > Date.now();
}
```

> ⚠️ **内存 Map 的局限**：单实例、重启即丢、多副本不共享。生产环境应放 **Redis** 并带 TTL（Day 36 会讲）。这里用内存是为了把概念讲清楚、不引入新依赖。`state` 严格说还应和**用户会话**绑定（存进 cookie/session 而非全局表），我们简化成全局一次性表——够挡住跨用户注入，够教学。

`state` 还能顺便携带"登录后跳回哪个页面"等业务信息（通常做法是 `state` 里塞一个随机 nonce 当 key，把真正的 payload 存服务端）。

### 6. 接进 blog-api：两个端点

整个流程在控制器里就是两个 `GET`：

```typescript
// auth.controller.ts
@Get('github')                         // ① 发起：生成 state → 302 跳 GitHub
githubLogin(@Res() res: Response) {
  if (!this.github.isConfigured())     // 没配 client_id/secret → 503，别跳一个必失败的 URL
    throw new BusinessException(OAUTH_NOT_CONFIGURED, ..., 503);
  const state = this.stateStore.generate();
  res.redirect(this.github.getAuthorizeUrl(state));
}

@Get('github/callback')                // ④ 回调：校验 state → 换 token → 拉资料 → 发我们的 token
async githubCallback(@Query() q: GithubCallbackDto) {
  if (q.error) throw new BusinessException(OAUTH_FAILED, ...);          // 用户点了"拒绝"
  if (!q.code || !q.state || !this.stateStore.consume(q.state))        // state 不对/缺/重放
    throw new BusinessException(OAUTH_STATE_INVALID, ..., 401);
  const ghToken = await this.github.exchangeCodeForToken(q.code);       // ⑤
  const ghUser  = await this.github.fetchGithubUser(ghToken);           // ⑦
  return this.auth.loginWithGithub(ghUser);                            // ⑧
}
```

两个设计细节：

- **`@Res()` 手动发 302**：这是少数要手动控制响应的场景，绕过统一 envelope（跳转没有 JSON body）。`TransformInterceptor` 只 `map` body、不碰 `res`，所以 redirect 安全；`BusinessExceptionFilter` 直接拿 `res` 写错误体，所以 `isConfigured` 为假时抛异常也能正常返回 503。
- **把"打 GitHub 的 HTTP"全塞进 `GithubOAuthProvider`**：`exchangeCodeForToken` / `fetchGithubUser` 是仅有的两个出网方法。这样 e2e 测试拿到 provider 单例后，把这两个方法替换成假的，就能不连 GitHub 跑通全链路——把"我们的逻辑"和"网络"解耦。

### 7. 建号 / 绑定策略，以及"无密码用户"

GitHub 把用户认了，接下来是**我们这边**的问题：这个 GitHub 用户对应我库里的谁？`loginWithGithub` 三步走：

```typescript
// auth.service.ts
async loginWithGithub(gh: GithubUser) {
  // 1) 已绑过 GitHub → 直接是这个人（靠稳定的 githubId 命中，不靠会变的邮箱/用户名）
  let user = await this.prisma.user.findUnique({ where: { githubId: gh.id } });

  // 2) 没绑过，但邮箱已注册 → 关联到老账号（信任 GitHub 已验证的主邮箱）
  if (!user && gh.email) {
    const existing = await this.prisma.user.findUnique({ where: { email: gh.email } });
    if (existing) user = await this.prisma.user.update({
      where: { id: existing.id }, data: { githubId: gh.id },
    });
  }

  // 3) 全新用户 → 建号：无密码，邮箱缺失就用 noreply 占位
  if (!user) user = await this.prisma.user.create({
    data: {
      email: gh.email ?? `${gh.id}+${gh.login}@users.noreply.github.com`,
      username: await this.uniqueUsername(gh.login),
      githubId: gh.id,
      password: null,                  // ★ 第三方登录用户没有密码
    },
  });

  return this.authResponse(user, await this.tokens.issue(user)); // 发我们自己的 token
}
```

每一步的取舍：

- **用 `githubId` 当身份锚点，不用邮箱/用户名**：GitHub 的数字 `id` 永不变；用户名（`login`）和邮箱用户都能改。拿会变的东西当身份锚点，迟早出事。
- **第 2 步"按邮箱自动关联"是个安全判断**：它假设"GitHub 返回的已验证主邮箱"可信。GitHub 的 `/user/emails` 确实标了 `verified`，我们只取 `primary && verified` 的——所以这个关联是安全的。**但如果第三方不保证邮箱已验证，自动关联就是账号劫持漏洞**（攻击者注册一个声称是你邮箱的第三方账号，就能并进你的账号）。务必只信"已验证"的邮箱。
- **`password` 改可空**：纯 GitHub 用户没有密码，schema 里 `password String?`。`login`（账号密码登录）那条路径会先 `findUnique` 再 `bcrypt.compare(input, user.password ?? DUMMY_HASH)`——`?? DUMMY_HASH` 这个 Day 32 写的兜底，正好让"无密码用户"走账号密码登录时稳稳失败且常量时间，不会 crash。
- **`uniqueUsername`**：把 GitHub `login` 洗成合法 username，撞了就补随机后缀——别让"建号"因为用户名重复直接 500。

对应的 schema 改动（迁移见 `prisma/migrations/*_day34_oauth`）：

```prisma
model User {
  password String? @db.VarChar(255)              // Day 34：可空（纯第三方登录无密码）
  githubId String? @unique @map("github_id") @db.VarChar(32)  // GitHub 数字 id，唯一
  // ...
}
```

### 8. PKCE：给藏不住 secret 的客户端（概念）

**PKCE（Proof Key for Code Exchange，读作 "pixy"）** 是授权码模式的增强，专治"SPA / 移动端没有 `client_secret`"的场景，思路很巧：

1. 客户端发起前，本地生成一个随机 `code_verifier`，算它的 SHA-256 得 `code_challenge`。
2. 第②步把 `code_challenge` 一起发给授权服务器（它记下来）。
3. 第⑤步换 token 时，附上**原始的 `code_verifier`**。授权服务器对它做 SHA-256，比对当初的 `code_challenge`——一致才发 token。

效果：即便 `code` 在回调里被截获，攻击者**没有 `code_verifier`**（它从没离开过发起的那个客户端），换不出 token。等于用"一次性动态密钥"替代了"固定 client_secret"。

我们是"有后端的 Web 应用"，`client_secret` 能安全落地，所以本例没上 PKCE。但现在的最佳实践是**授权码模式一律加 PKCE**（连有 secret 的也加，多一层防护，OAuth 2.1 直接把它列为默认）。GitHub 也支持。这是个值得自己加的加分练习。

---

## 💻 实践练习

### 主练习：给 blog-api 接 GitHub 登录

在 `solutions/blog/blog-api/` 上完成：

1. schema：`User.password` 改 `String?`，加 `githubId String? @unique`；写迁移
2. `config`：加可选的 `GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL`（没配不影响启动）
3. `auth/oauth/oauth-state.store.ts`：一次性 `state` 存储
4. `auth/oauth/github-oauth.provider.ts`：`isConfigured / getAuthorizeUrl / exchangeCodeForToken / fetchGithubUser`
5. `auth/oauth/dto/github-callback.dto.ts`：`code / state / error / error_description` 全可选
6. `AuthService.loginWithGithub` + `uniqueUsername`（三步绑定）
7. `AuthController`：`GET /auth/github`（@Res 302）+ `GET /auth/github/callback`
8. `AuthModule` providers 加 `GithubOAuthProvider / OAuthStateStore`

先去 GitHub 建一个 OAuth App（**Settings → Developer settings → OAuth Apps → New**），
**Authorization callback URL** 填 `http://localhost:3000/auth/github/callback`，拿到 Client ID / Secret 填进 `.env`。

跑起来：

```bash
cd ../blog-db && docker compose up -d && cd -
cp .env.example .env          # 填上 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET
pnpm install && pnpm prisma:generate && pnpm prisma:migrate

pnpm start:dev
# 浏览器打开 http://localhost:3000/auth/github → 跳 GitHub 授权 → 回调拿到我们的 token
```

手动验证（不接真 GitHub 也能验前半段）：

```bash
# 没配 secret 时 → 503（注释掉 .env 的 GITHUB_* 再试）
curl -si localhost:3000/auth/github | head -1            # 配了 → 302 Location: github.com/...

# state 校验：伪造一个 state → 401 OAUTH_STATE_INVALID
curl -s 'localhost:3000/auth/github/callback?code=x&state=fake' | jq '{code}'

# 用户拒绝授权（GitHub 带 error 回来）→ 401 OAUTH_FAILED
curl -s 'localhost:3000/auth/github/callback?error=access_denied' | jq '{code}'
```

### 加分练习：自己想答案再看

1. **加 PKCE**：发起时生成 `code_verifier/challenge`，换 token 时附 verifier。对"有后端"的我们，它额外防住了什么？
2. **state 绑定会话**：现在 `state` 是全局一次性表。改成存进用户的 cookie/session，能多防住什么攻击？
3. **邮箱关联的风险边界**：如果接的第三方**不保证邮箱已验证**，第 2 步的自动关联会变成什么漏洞？该怎么改（强制走"手动绑定"流程）？
4. **多家登录**：再接一个 Google 登录。`githubId` 该抽象成 `oauth_accounts` 表（一个用户多个第三方）吗？画一下表结构。
5. **token 存不存**：我们拿完 GitHub `access_token` 就丢了。什么场景下需要**保存**它（带刷新）？（提示：要持续读用户的 GitHub 数据时。）

### 验收清单

```bash
pnpm prisma:generate && pnpm exec tsc --noEmit && echo "OK types"
pnpm test:unit    # 41（含 OAuthStateStore 一次性 + loginWithGithub 三步绑定）
pnpm test:e2e     # oauth 8（302/state/换号/绑定/幂等）+ posts 33 + auth 16
pnpm test:e2e 2>&1 | grep -iE 'OAUTH|state|github|302|绑定'
```

> 本仓库 e2e 用 monkey-patch 把 `GithubOAuthProvider` 的两个出网方法换成假的，**不连真 GitHub** 也能跑通从 `/auth/github` 取 `state` 到回调建号的全链路。

---

## ⚠️ 常见误区

- **以为 OAuth 是登录协议**：它是**授权**框架。"用第三方登录"是借它来做。严格的身份层是 OpenID Connect（OIDC）。
- **让前端直接拿 code 换 token**：`client_secret` 进前端 = 公开。换 token 必须在后端。
- **用隐式模式（Implicit Flow）**：已弃用。token 进 URL、无 secret。一律用授权码模式（SPA/移动端 + PKCE）。
- **不校验 state**：等于不防 OAuth CSRF，受害者会被静默登进攻击者账号。`state` 必须随机 + 一次性。
- **拿邮箱/用户名当身份锚点**：它们会变。用第三方那个**永不变的数字 id**（`githubId`）。
- **盲目按邮箱自动关联**：只信**已验证**的邮箱。第三方不保证 verified 时自动并号 = 账号劫持。
- **第三方用户没密码却建 `NOT NULL`**：`password` 要可空；账号密码登录路径要兜住 null（`?? DUMMY_HASH`）。
- **把 GitHub 的 access_token 当会话凭证**：用完即弃。用户在**我们站点**的会话靠**我们自己**的 JWT+refresh。
- **state 用内存 Map 还上多副本**：单实例才行。多副本/生产放 Redis 带 TTL。

---

## ✅ 今日产出

- [ ] 能说清 OAuth 2.0 四角色，以及它解决的是"授权委托"而非"登录"
- [ ] 能完整画出授权码模式的 8 步，并指出哪一跳传 secret、哪一跳传 code
- [ ] 能解释 `client_secret` 为什么只能在后端，以及隐式模式为什么被弃用
- [ ] 理解 `state` 如何防 OAuth CSRF，且必须一次性消费
- [ ] blog-api 跑通 GitHub 登录：`/auth/github` → 回调 → 发我们自己的 token
- [ ] 想清楚第三方用户的建号/绑定策略和"无密码用户"的处理
- [ ] 单测（41）+ 集成测（oauth 8 / posts 33 / auth 16）全绿
- [ ] 提交到 GitHub，commit message 写明 "day 34 oauth: github login (authorization code flow)"

---

## 📚 延伸阅读

- [OAuth 2.0 Simplified — Aaron Parecki](https://aaronparecki.com/oauth-2-simplified/)（最好的入门，作者是 OAuth 工作组成员）
- [RFC 6749 — The OAuth 2.0 Authorization Framework](https://datatracker.ietf.org/doc/html/rfc6749)（原始规范）
- [RFC 7636 — PKCE](https://datatracker.ietf.org/doc/html/rfc7636)
- [OAuth 2.1 草案](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1)（强制 PKCE、删除隐式模式，看清趋势）
- [GitHub Docs — Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [OpenID Connect 官网](https://openid.net/developers/how-connect-works/)（OAuth 之上的标准身份层）
- [OWASP — OAuth 安全要点（含 state / redirect_uri 校验）](https://cheatsheetseries.owasp.org/cheatsheets/OAuth_Cheat_Sheet.html)

---

[⬅️ Day 33](../day-33/) | [➡️ Day 35](../day-35/)
