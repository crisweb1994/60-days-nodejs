# Day 32 — JWT 认证实战

> 把 Day 31 的概念落地到 blog-api：bcrypt 存密码、注册/登录、Access + 可撤销 Refresh 双 Token、一个 JWT 守卫保护 `/auth/me`。
> 边界：Day 32 只做**认证**（你是谁），**不保护 posts**——给 posts 加守卫 + 角色是 Day 33 的 RBAC。所以 posts 业务代码和它的 e2e 用例不变。

## 📋 今日目标

- 用 **bcrypt** 哈希密码，搞懂"慢哈希 + salt + cost"为什么是密码存储的正确姿势
- 实现注册 / 登录，并堵住**用户枚举**（统一错误 + 常量时间比对）
- 实现 **Access Token（无状态 JWT）+ Refresh Token（不透明、库里存哈希、可撤销）**，含**轮换**
- 写一个 **JwtAuthGuard** 保护接口，用 `@CurrentUser()` 取当前用户
- 想清楚 **token 存哪**（HttpOnly Cookie vs localStorage）的权衡
- 把这些干净地接进 NestJS（`JwtModule`、全局 `PrismaModule`、统一错误外壳）

> 配套代码：`solutions/blog/blog-api/src/auth/`。新增 `users` / `refresh_tokens` 两张表、`auth` 模块（service / tokens / guard / controller / dto）。

---

## 📖 核心知识点

### 1. 密码存储：为什么必须 bcrypt（而不是 md5/sha256）

铁律：**密码永远只存哈希，绝不存明文，也不存可逆加密**。但用哪种哈希很关键：

- **快哈希（md5 / sha1 / sha256）不行**：它们设计得就是快——攻击者拿到库后，用 GPU 每秒能试几十亿次，常见密码秒破。还怕彩虹表。
- **慢哈希（bcrypt / scrypt / argon2）才对**：故意慢、且自带 **salt**（每个密码一个随机盐，相同密码哈希也不同，干掉彩虹表），还有 **cost（工作因子）**可调——机器越快就把 cost 调高，让暴力破解始终昂贵。

bcrypt 一条哈希长这样，**盐和 cost 都编码在里面**：

```
$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy
└┬┘└┬┘└──────────┬─────────┘└──────────────┬──────────────┘
 算法 cost=10      salt(22)                  hash
```

代码就两个调用（`auth.service.ts`）：

```typescript
const hash = await bcrypt.hash(password, 10);            // 注册时：cost=10
const ok   = await bcrypt.compare(plain, user.password); // 登录时：比对
```

**几个点**：
- **cost=10** 是常见起点（每 +1 计算量翻倍）。目标是让单次哈希 ~100ms：用户无感，攻击者难受。
- **bcrypt 有 72 字节输入上限**：超长密码会被截断。要支持任意长密码，业界做法是先 sha256 预哈希再喂给 bcrypt，或直接用 **argon2id**（OWASP 当前首选）。本项目用 bcrypt 够教学。
- **本项目用 `bcryptjs`（纯 JS 实现）**：免去原生编译（`bcrypt` 是 native 模块，要 node-gyp）。算法一致，慢一点点，部署省心。生产新项目可考虑 `argon2`。

### 2. 注册 / 登录，以及怎么不泄露"这个邮箱是否注册过"

注册：查唯一 → 哈希密码 → 建用户 → 签发 token。唯一性**预检 + 写入处兜 P2002 竞态**（和 Day 27 slug 同款两道防线）。

登录有个容易忽略的安全点——**用户枚举**：如果"邮箱不存在"返回"用户不存在"、"密码错"返回"密码错误"，攻击者就能逐个探测哪些邮箱注册过。对策两条：

```typescript
// 1) 不存在和密码错，返回**同一个** INVALID_CREDENTIALS
// 2) 即使用户不存在，也跑一次 bcrypt.compare（拿一个废弃哈希），
//    让两种情况**耗时一致**，堵住"靠响应时间判断"的时序侧信道
const ok = await bcrypt.compare(dto.password, user?.password ?? DUMMY_HASH);
if (!user || !ok) throw INVALID_CREDENTIALS; // 统一错误
```

### 3. 双 Token：无状态 access + 可撤销 refresh

直接把 Day 31 的结论落地：

| | Access Token | Refresh Token |
|---|---|---|
| 形态 | **无状态 JWT** | **不透明随机串**（`randomBytes(32)`）|
| 存哪 | 不入库，验签即信 | 库里**只存 sha256 哈希** |
| 寿命 | 短（默认 15 分钟）| 长（默认 7 天）|
| 作用 | 带在 `Authorization: Bearer` 访问接口 | 过期后换新的 access |
| 能否撤销 | 不能（到 exp 前一直有效）| **能**：把库里那行 `revokedAt` 置上 |

**为什么 refresh 不也用 JWT、而用"不透明 + 存哈希"**：refresh 的核心诉求是**可撤销**（登出、改密、风控要能立刻让它失效）。JWT 天生难撤销。用随机串 + 落库，撤销就是一条 UPDATE。**只存它的 sha256 哈希**——数据库泄露也拿不到能用的 refresh（和"只存密码哈希"完全同理）。响应里把明文 refresh 给客户端一次，之后服务端只认哈希。

```typescript
// tokens.service.ts —— issue
const accessToken = await this.jwt.signAsync({ sub: user.id, role: user.role }); // JWT
const refreshToken = randomBytes(32).toString('base64url');                       // 不透明
await this.prisma.refreshToken.create({
  data: { userId: user.id, tokenHash: sha256(refreshToken), expiresAt },          // 只存哈希
});
```

### 4. Refresh 轮换（rotation）

每次用 refresh 换新 token 时，**把旧的立刻作废、发一对全新的**：

```typescript
// rotate：校验 → 旧的 revokedAt 置上 → issue 新的
if (!record || record.revokedAt || record.expiresAt <= now) throw INVALID_REFRESH_TOKEN;
await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: now } });
return issue(record.user);
```

好处：refresh 是"一次性"的，被偷的旧 refresh 一旦被正主用过就失效，缩短危害窗口。**进阶**（本项目未做，留作练习）：**重放检测**——如果一个**已作废**的 refresh 又被使用，说明它可能被盗，可以**把该用户的所有 refresh 全撤掉**，强制重新登录。

登出就是 `revoke`：把这条 refresh 置 `revokedAt`（幂等——未知/已撤销也当成功，不泄露它存不存在）。

### 5. JwtAuthGuard：保护接口

守卫从 `Authorization` 头取 Bearer token，验签通过就放行、把 payload 挂到 `req.user`：

```typescript
const token = header.slice('Bearer '.length).trim();
const payload = await this.jwt.verifyAsync<JwtPayload>(token); // 用 JwtModule 配的 secret+算法
(req as any).user = payload;                                    // { sub, role }
```

**安全关键（呼应 Day 31 §6）**：`verifyAsync` 用的是 **JwtModule 里固定配好的算法和 secret**，**不看 token header 里的 `alg`**。所以 `alg:none` / 算法混淆攻击在这里天然无效。

配 `@CurrentUser()` 参数装饰器，控制器里直接拿：

```typescript
@Get('me')
@UseGuards(JwtAuthGuard)
me(@CurrentUser() user: JwtPayload) { return this.auth.me(user.sub); }
```

> 守卫抛 `BusinessException(UNAUTHORIZED, 401)`，由控制器上的 `@UseFilters(BusinessExceptionFilter)` 接住 → 走统一错误外壳。**守卫里抛的异常，控制器的过滤器也能接到**。

### 6. 接进 NestJS：JwtModule + 全局 Prisma

```typescript
JwtModule.registerAsync({
  inject: [ConfigService],
  useFactory: (config) => ({
    secret: config.get('auth.accessSecret'),                  // access token 的信任根
    signOptions: { expiresIn: config.get('auth.accessTtl') }, // 秒
  }),
})
```

- **`registerAsync` + 注入 ConfigService**：等 env 校验通过后再取 secret（secret 必填、够长，缺了启动即崩——见 `config.validation.ts`）。
- `PrismaService` 由 Day 27 的全局 `PrismaModule` 提供，auth 模块直接注入。
- **passport 替代方案**：NestJS 官方常用 `@nestjs/passport` + `passport-jwt`（Strategy + Guard）。本项目直接用 `@nestjs/jwt` + 手写守卫——少几个依赖、最透明，正好接 Day 31 手写 JWT 的理解。生产两种都常见。

### 7. token 存客户端哪里（落地 Day 31 §8 的权衡）

本项目把 access + refresh 都**放在响应 body 里**返回，由调用方决定怎么存——这是 API 的中立做法。真实前端怎么选：

| 存法 | 风险 | 适合 |
|------|------|------|
| `localStorage` | **XSS 能直接偷** | 简单、跨域 API；但要严防 XSS |
| **HttpOnly Cookie** | JS 读不到（防 XSS 窃取），但要防 **CSRF**（`SameSite=Lax/Strict` + CSRF token）| 同站 Web |
| **access 放内存 + refresh 放 HttpOnly Cookie** | 最稳的折中：access 不落盘、刷新走 cookie | 现代 SPA 主流 |

没有银弹，是 XSS 与 CSRF 之间的权衡。要点：**别把 access 放 localStorage 又不防 XSS**。

### 8. 安全要点清单（这一天的"红线"）

- 密码**只存 bcrypt 哈希**，cost 让单次 ~100ms；响应里**永远不返回 password**（`toUserResponse` 统一脱敏）
- 登录**统一错误 + 常量时间比对**，防用户枚举
- access **短**、refresh **可撤销**且**只存哈希**、刷新**轮换**
- JWT secret **强随机**、必填、放 env（缺了启动即崩）；验签**固定算法**
- 登出**作废 refresh**（access 因为短，等它自己过期）

> 还差一道**限流**：登录 / 注册 / 刷新接口没有速率限制，挡不住在线暴力破解 / 撞库 / 用枚举刷接口。本项目本天未做，Day 35 Web 安全会补 `@nestjs/throttler`（按 IP / 账号限流）。生产环境这是必须项。

### 9. 边界：今天没保护 posts

Day 32 只交付**认证**。posts 接口仍是公开的——给它们加 `@UseGuards` + 角色校验（"只有作者/管理员能改"）是 **Day 33 RBAC**。所以本天没动 posts 业务代码，27 个 posts e2e **用例**一个没改、继续全绿（仅测试文件加了一行设置 `JWT_ACCESS_SECRET`——因为 `AppModule` 现在要求它，否则启动期 zod 校验就崩）。

---

## 💻 实践练习

### 主练习：给 blog-api 加认证

在 `solutions/blog/blog-api/` 上完成：

1. schema 加 `User` + `RefreshToken`（refresh 只存哈希），`prisma migrate dev`
2. `config`：加 `JWT_ACCESS_SECRET`（必填）/ `JWT_ACCESS_TTL` / `REFRESH_TTL_DAYS`
3. `auth/tokens.service.ts`：`issue` / `rotate` / `revoke`（access=JWT，refresh=随机+存哈希）
4. `auth/auth.service.ts`：`register` / `login`（bcrypt + 防枚举）/ `refresh` / `logout` / `me`
5. `auth/guards/jwt-auth.guard.ts` + `@CurrentUser()` 装饰器
6. `auth/auth.controller.ts`：5 个端点 + Swagger 注解（`/me` 加 `@ApiBearerAuth`）
7. `AppModule` 引入 `AuthModule`；`main.ts` 给 Swagger 加 `addBearerAuth()`

跑起来：

```bash
cd ../blog-db && docker compose up -d && cd -
cp .env.example .env        # 含 JWT_ACCESS_SECRET 示例值（仅本地够用，生产务必换强随机串）
pnpm install && pnpm prisma:generate && pnpm prisma:migrate

pnpm start:dev              # http://localhost:3000/docs 右上角能 Authorize
pnpm test:unit             # 不连库（含 bcrypt / 守卫）
pnpm test:e2e              # 连库（注册→登录→me→刷新→登出全链路）
```

手动验证：

```bash
# 注册 → 拿 token
TOKENS=$(curl -s -X POST localhost:3000/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"a@b.com","username":"alice","password":"S3cure-pass"}')
ACCESS=$(echo "$TOKENS" | jq -r '.data.accessToken')
REFRESH=$(echo "$TOKENS" | jq -r '.data.refreshToken')

curl -s localhost:3000/auth/me -H "Authorization: Bearer $ACCESS" | jq '.data'   # 当前用户
curl -s localhost:3000/auth/me | jq '{code,message}'                              # 401 UNAUTHORIZED
curl -s -X POST localhost:3000/auth/refresh -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}" | jq '.data.accessToken'                   # 换新 access
curl -s -X POST localhost:3000/auth/refresh -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}" | jq '{code}'                              # 旧的已轮换 → 401
```

### 加分练习：自己想答案再看

1. **把 cost 从 10 调到 12**，计时 `bcrypt.hash` 的耗时变化，体会"每 +1 翻倍"。
2. **实现 refresh 重放检测**：当一个已 `revokedAt` 的 refresh 又被使用，撤销该用户**全部** refresh。
3. **改成 HttpOnly Cookie 下发 refresh**（`Set-Cookie`，`HttpOnly; Secure; SameSite=Strict`），登录/刷新读 cookie；想想 CSRF 怎么防。
4. **为什么 access 用 JWT 而 refresh 用不透明串？** 反过来（access 不透明、refresh JWT）会牺牲什么？
5. **登录响应时间**：分别请求"不存在的邮箱"和"存在但密码错"，确认两者耗时接近——这就是防枚举的常量时间在起作用。

### 验收清单

```bash
pnpm prisma:generate && pnpm exec tsc --noEmit && echo "OK types"
pnpm test:unit     # 26 个（含 bcrypt 往返、JwtAuthGuard 放行/拒绝/过期/换 secret）
pnpm test:e2e      # 含注册/重复/弱密码/登录/防枚举/me鉴权/刷新轮换/登出
pnpm test:e2e 2>&1 | grep -iE 'register|login|me|refresh|logout'
```

---

## ⚠️ 常见误区

- **用 md5/sha256 存密码**：太快，拖库即破。用 bcrypt/argon2 慢哈希 + salt。
- **响应里带出 password 字段**：哪怕是哈希也别返回。统一在 `toUserResponse` 脱敏。
- **登录区分"邮箱不存在/密码错"**：泄露注册情况（用户枚举）。统一错误 + 常量时间。
- **refresh 也用不可撤销的 JWT**：登出/改密无法即时失效。用不透明串 + 落库 + 轮换。
- **refresh 明文存库**：库泄露=可直接登录。只存 sha256 哈希。
- **access token 设很长**：被盗危害大。access 短 + refresh 续期。
- **JWT secret 写死/太弱**：泄露=全线伪造。强随机、必填、放 env。
- **守卫信任 token 里的 alg**：`alg:none`/算法混淆。固定算法验签（`verifyAsync` 用模块配置）。
- **在 Day 32 就给 posts 加鉴权**：那是 Day 33 RBAC。今天只做认证，posts 保持公开、测试不变。

---

## ✅ 今日产出（注册登录功能）

- [ ] bcrypt 哈希密码，能解释慢哈希 / salt / cost
- [ ] 注册 / 登录可用，且防用户枚举（统一错误 + 常量时间）
- [ ] Access（短 JWT）+ Refresh（不透明、存哈希、可撤销、轮换）双 Token 跑通
- [ ] JwtAuthGuard 保护 `/auth/me`，`@CurrentUser()` 取当前用户
- [ ] 响应永不含 password；secret 必填且强随机
- [ ] 能说出 token 存 localStorage vs HttpOnly Cookie 的权衡
- [ ] 单测（26）+ 集成测全绿
- [ ] 提交到 GitHub，commit message 写明 "day 32 jwt auth: register/login/refresh"

---

## 📚 延伸阅读

- [NestJS — Authentication](https://docs.nestjs.com/security/authentication)（官方 passport-jwt 版，对照本项目手写守卫）
- [NestJS — @nestjs/jwt](https://github.com/nestjs/jwt)
- [OWASP — Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)（bcrypt/argon2、cost 选型）
- [OWASP — Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)（含防用户枚举）
- [Auth0 — Refresh Token Rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)（轮换 + 重放检测）
- [The Copenhagen Book — Password authentication](https://thecopenhagenbook.com/password-authentication)

---

[⬅️ Day 31](../day-31/) | [➡️ Day 33](../day-33/)
