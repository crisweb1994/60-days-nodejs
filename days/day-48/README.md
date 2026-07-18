# Day 48 — 用户系统与团队管理

> Day 47 把 SaaS 工程壳跑起来了：Next.js 能启动，tRPC 能接请求，Prisma 能连 PostgreSQL。今天开始把 Day 46 设计里最关键的协作边界落进代码：**谁是用户、用户怎么登录、用户属于哪些工作区、在某个工作区里是什么角色**。
>
> 这一天的重点不是任务 CRUD，而是先把「人」和「团队」建稳。因为后面的项目、任务、评论、通知，每一个写操作都会问同一个问题：**当前用户是不是这个工作区的成员？角色够不够？**
>
> 一句话目标：实现邮箱注册/登录、httpOnly cookie session、工作区 CRUD、成员列表、邀请接受和基础 RBAC。

## 📋 今日目标

- 实现 **邮箱 + 密码** 注册/登录，并用 httpOnly cookie 保存 session
- 实现 `auth.me` / `auth.logout`，让服务端能从请求 cookie 解析当前用户
- 实现工作区创建、列表、详情、更新
- 实现成员列表与角色修改，守住「至少保留一个 OWNER」不变量
- 实现邀请创建与接受：邀请 token 只给指定邮箱使用
- 建立 RBAC 基础工具：`OWNER > ADMIN > MEMBER > VIEWER`

> 配套代码：`solutions/saas/`。新增 `src/server/auth/`（密码哈希、session cookie、RBAC）、`authRouter`、`workspacesRouter`，并挂到根 tRPC router。OAuth 今天只讲边界，不接真实 Provider；真实 OAuth 需要 GitHub/Google client id、callback URL 和 state 校验，适合单独一天做。

---

## 📖 核心知识点

### 1. 用户系统的核心不是「登录框」，而是服务端身份

注册/登录只是入口。真正重要的是：每个后续请求进入服务端时，服务端能得到一个可信的 `ctx.user`。

今天的链路是：

```text
auth.login / auth.register
  -> 校验邮箱密码
  -> 创建签名 session token
  -> Set-Cookie: saas_session=...; HttpOnly; SameSite=Lax

后续请求
  -> createTRPCContext 读取 Cookie
  -> 校验签名和过期时间
  -> 查 User
  -> ctx.user = 当前用户
```

注意 cookie 是 **httpOnly**。前端 JavaScript 读不到它，XSS 就没法直接偷走 session。后面做页面客户端请求时，只要同源请求自动带 cookie，服务端就能恢复身份。

### 2. 密码：只存哈希，不存明文

Day 48 的参考实现用 Node 内置 `crypto.scrypt`：

```text
scrypt:<salt>:<derived-key>
```

登录时不比较明文密码，而是用同一个 salt 重新推导 key，再用 `timingSafeEqual` 比较。这样数据库泄露时，攻击者拿到的是不可直接登录的哈希。

生产里常用 bcrypt / argon2；这里用 scrypt 是因为 Node 内置、足够教学，且不需要额外 native 依赖。

### 3. Session：签名 token，不是裸 userId

cookie 里不能直接放 `userId=...`。那样用户自己改 cookie 就能冒充别人。

今天的 session token 结构是：

```text
base64url(payload).hmac_sha256(payload, SESSION_SECRET)
```

服务端每次读取 cookie 都重新计算签名。签名不对、过期、用户不存在，全部视为未登录。真实生产还会把 session 存进数据库或 Redis，以支持主动踢下线、设备管理和 token 轮换；Day 48 先用签名 cookie 把主链路跑通。

### 4. Membership 才是权限的载体

不要把角色挂在 User 上。一个用户可以是 A 工作区的 OWNER、B 工作区的 VIEWER，所以角色必须挂在：

```text
User x Workspace = Membership(role)
```

这就是 Day 46 数据模型今天开始发挥作用的地方。所有工作区操作都先走：

```text
当前 userId + workspaceSlug
  -> 查 Workspace
  -> 查 Membership(userId, workspaceId)
  -> 没有成员关系：403
  -> 有成员关系：看 role 是否够
```

### 5. RBAC：先做四档，不做细粒度 ACL

今天的角色顺序：

```text
OWNER > ADMIN > MEMBER > VIEWER
```

最低权限规则：

| 操作 | 最低角色 |
|---|---|
| 看工作区 / 看成员 | VIEWER |
| 更新工作区资料 | ADMIN |
| 邀请成员 | ADMIN |
| 修改成员角色 | OWNER |
| 创建工作区 | 任意已登录用户，创建者自动 OWNER |

MVP 先不上「按项目授权」「按字段授权」这种细粒度 ACL。不是它不重要，而是它会把权限模型复杂度直接翻倍。先把工作区级 RBAC 做对，后面项目/任务都会复用这套判断。

### 6. OWNER 不变量：至少留一个

权限系统里最容易被忽略的是不变量，不是按钮显示。

今天最重要的不变量是：

```text
一个工作区必须至少保留一个 OWNER
```

所以修改成员角色时，如果目标成员是 OWNER，且要降级，服务端必须先数这个工作区还有几个 OWNER。只有一个时拒绝操作。前端可以禁按钮，但真正的规则一定写在服务端。

### 7. 邀请：先发 token，再接受

邀请不是直接创建 Membership。正确流程是：

```text
ADMIN/OWNER 发邀请 -> Invitation(email, role, token, expiresAt)
被邀请人登录对应邮箱账号 -> acceptInvite(token)
服务端校验 token / 过期 / 邮箱一致 -> 创建 Membership
```

邮箱一致这条很关键。否则任何拿到 token 的登录用户都能加入工作区。Day 48 还没有真实邮件发送，所以 `invite` 会把 token 返回给调用方，方便本地烟测；生产里 token 应该进邮件，不该直接展示在管理页面里。

---

## 改动清单（Day 48 参考答案）

| 文件 | 是什么 |
|---|---|
| `src/server/auth/password.ts` | 新增：scrypt 密码哈希与校验 |
| `src/server/auth/session.ts` | 新增：签名 session token、cookie 读写 |
| `src/server/auth/rbac.ts` | 新增：角色等级比较 |
| `src/server/routers/auth.ts` | 新增：注册、登录、当前用户、登出 |
| `src/server/routers/workspaces.ts` | 新增：工作区 CRUD、成员、邀请、接受邀请 |
| `src/server/trpc.ts` | 更新：context 解析 cookie，提供 `protectedProcedure` |
| `src/server/routers/_app.ts` | 更新：挂载 `auth` / `workspaces` router |
| `package.json` | 更新：新增 `cookie` 与类型依赖 |

---

## 💻 实践练习

> tRPC mutation 用 POST；query 用 GET。下面用 cookie jar 保存 httpOnly cookie，模拟浏览器会话。

1. **启动依赖和应用**

   ```bash
   cd solutions/saas
   cp .env.example .env
   docker compose up -d
   pnpm install
   pnpm prisma:push
   pnpm dev
   ```

2. **注册并保存 cookie**

   ```bash
   curl -i -c /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/auth.register" \
     -H "content-type: application/json" \
     --data '{"json":{"email":"owner@example.com","password":"password123","name":"Owner"}}'
   ```

3. **查看当前用户**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     "http://localhost:3000/api/trpc/auth.me"
   ```

4. **创建工作区**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/workspaces.create" \
     -H "content-type: application/json" \
     --data '{"json":{"name":"Acme Team","slug":"acme-team"}}'
   ```

5. **邀请成员**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/workspaces.invite" \
     -H "content-type: application/json" \
     --data '{"json":{"slug":"acme-team","email":"member@example.com","role":"MEMBER"}}'
   ```

6. **验证 RBAC**

   - 未登录调用 `workspaces.list` 应返回 401
   - MEMBER 调用 `workspaces.update` 应返回 403
   - 唯一 OWNER 把自己降级应返回 403

---

## ✅ 今日产出

- [ ] 能注册/登录，并通过 httpOnly cookie 保持会话
- [ ] `auth.me` 能从 cookie 恢复当前用户
- [ ] 登录用户能创建工作区，创建者自动成为 OWNER
- [ ] 成员列表、角色修改、邀请创建和接受可用
- [ ] 服务端守住 RBAC 与「至少一个 OWNER」不变量
- [ ] 能说清 User / Workspace / Membership 三者关系
- [ ] 提交 Day 48 代码到 GitHub

---

[⬅️ Day 47](../day-47/) | [➡️ Day 49](../day-49/)
