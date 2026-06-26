# API 设计 — SaaS 任务管理平台

> Day 46 产出。这份文档定的是**接口契约的形状**，不是某一个框架的具体写法。
> 资源建模、URL、分页、错误、幂等这些是「无论用 REST 还是 tRPC 都要定死」的东西；
> 最后一节给出 tRPC / REST 两条路的映射，落地选哪条看 `decisions/ADR-003`。

---

## 1. 设计原则（先于端点）

端点表之前，四条贯穿全局的原则。它们比任何一个 URL 都重要：

1. **归属与权限由服务端解析，不来自请求体**。任何写操作的「这项目属于哪个工作区、你有没有权限」都由「请求里的资源 id → 查库」推出，前端不传归属、传了也忽略。这是防越权的第一道闸（`architecture.md` §3 第 ② 步）。
2. **资源是名词，关系是嵌套**。`/workspaces/:slug/projects/:key/tasks/:number` —— URL 本身就是资源的「地址」，从左到右是包含关系。任务用项目内编号（`ENG-42`）做对外 id，对人友好；UUID 留给内部关联和防枚举。
3. **列表一律游标分页，不用 offset**。深翻页（offset 10000）在 PG 里要扫过前 10000 行，越往后越慢；游标（keyset）用索引直接定位，翻到哪页都快（Day 28 已讲透）。offset 只留给「跳页」这种真需要随机访问的场景。
4. **写操作幂等靠 `Idempotency-Key`**。用户网卡抖动连点两次「创建任务」，不该建出两张卡。客户端给每个写请求带一个唯一 key，服务端 24h 内见到同一个 key 就返回第一次的结果。

---

## 2. 鉴权与授权

```
请求                          服务端做的事
─────────────────────────────────────────────────────────
Cookie: session=...     →   ① 验 session，得 userId
                            ② 从 URL 的资源 id 查出 workspaceId
                            ③ 查 Membership(userId, workspaceId)：
                                 不存在 → 403（不是这工作区的人）
                                 存在   → 取 role，用于授权
                            ④ 后续查询只在这工作区的数据范围内
```

- 鉴权用 **httpOnly cookie session**（不是 localStorage 里的 token）。XSS 偷不到 cookie，比裸 JWT in localStorage 安全。Day 32/34 那套 JWT 机制可以复用，只是 token 装进 cookie 而非返回给前端 JS。
- `workspaceId` 解析结果进**请求上下文**（tRPC 的 `ctx` / NestJS 的 `Request`），所有后续查询都从 ctx 取，不在 handler 里重复传。
- 授权判断就是一句话：**「你是这个资源所在工作区的成员吗？你的角色够做这个动作吗？」** 顺着 `Task → Project → Workspace` 这条归属链回溯到工作区，再查成员身份。不需要在数据层做任何隔离——应用层把好这道关就够。

---

## 3. 资源与端点

> 下面用 REST 表示。`{ws}` = 工作区 slug；任务用 `{number}`（如 `42`，对应 `ENG-42`）。
> 所有 `/workspaces/{ws}/...` 都要求「请求者是该工作区成员」，否则 403。

### 工作区与成员

| 方法 | 路径 | 作用 | 最低角色 |
|---|---|---|---|
| `POST` | `/workspaces` | 创建工作区（创建者自动成 OWNER） | 任意已登录用户 |
| `GET` | `/workspaces/{ws}` | 工作区详情 | 成员 |
| `PATCH` | `/workspaces/{ws}` | 改名 / 改头像 | ADMIN |
| `GET` | `/workspaces/{ws}/members` | 成员列表（游标分页） | 成员 |
| `PATCH` | `/workspaces/{ws}/members/{userId}` | 改成员角色 | OWNER |
| `DELETE` | `/workspaces/{ws}/members/{userId}` | 移除成员 | ADMIN（不能移 OWNER） |
| `POST` | `/workspaces/{ws}/invitations` | 发邀请（邮箱 + 角色） | ADMIN |
| `POST` | `/invitations/{token}/accept` | 凭 token 接受邀请 | 任意已登录用户 |

> 角色变更是授权最敏感的操作——OWNER 只能是 OWNER 自己降级、且永远至少留一个 OWNER（应用层 + 测试都要守）。这条规则比端点本身更值得写进测试。

### 项目

| 方法 | 路径 | 作用 | 最低角色 |
|---|---|---|---|
| `GET` | `/workspaces/{ws}/projects` | 项目列表 | 成员 |
| `POST` | `/workspaces/{ws}/projects` | 建项目（指定 key） | ADMIN |
| `GET` | `/workspaces/{ws}/projects/{key}` | 项目详情 | 成员 |
| `PATCH` | `/workspaces/{ws}/projects/{key}` | 改名 / 归档 | ADMIN |
| `DELETE` | `/workspaces/{ws}/projects/{key}` | 删项目（软删，可恢复） | ADMIN |

### 任务

| 方法 | 路径 | 作用 | 最低角色 |
|---|---|---|---|
| `GET` | `/workspaces/{ws}/projects/{key}/tasks` | 任务列表（游标 + 过滤） | 成员 |
| `POST` | `/workspaces/{ws}/projects/{key}/tasks` | 建任务（返回 number） | 成员 |
| `GET` | `/workspaces/{ws}/projects/{key}/tasks/{number}` | 任务详情（含评论） | 成员 |
| `PATCH` | `/workspaces/{ws}/projects/{key}/tasks/{number}` | 改字段（带 `If-Match` 乐观锁） | 成员 |
| `POST` | `/workspaces/{ws}/projects/{key}/tasks/{number}/comments` | 发评论 | 成员 |
| `DELETE` | `/workspaces/{ws}/.../tasks/{number}` | 删任务（软删） | assignee / ADMIN |

「分给我的任务」这类**跨项目视图**走顶层快捷端点，避免前端逐项目拉：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/me/tasks` | 分配给我的、跨工作区/项目的任务（游标） |
| `GET` | `/workspaces/{ws}/inbox` | 工作区内 @ 到我的动态 |

---

## 4. 列表：游标分页、过滤、排序

### 游标分页

列表响应固定形状：

```jsonc
// GET /workspaces/acme/projects/ENG/tasks?status=IN_PROGRESS&limit=20
{
  "data": [ { "id": "...", "number": 42, "title": "...", /* ... */ } ],
  "nextCursor": "eyJjIjoiMjAyNi0wNi0yNlQwOTozMDowMFoiLCJpIjoi..."} , // base64
  "hasMore": true
}
```

- 游标编码的是 `(createdAt, id)` 这个稳定的排序键对（Day 28 的 keyset）。`hasMore` 比「总条数」便宜得多——算总数要 `COUNT(*)` 全扫，列表接口永远别返回 total，除非业务必需。
- 翻下一页：`?cursor={nextCursor}`。游标对客户端是不透明字符串，别解析它、别自己拼——服务端改排序规则时才不会把前端写死。

### 过滤与排序

```
GET .../tasks?status=IN_PROGRESS&assignee=me&priority=HIGH&label=bug&sort=-createdAt
```

- 过滤参数都是字段名直接做 query key，值的白名单在 DTO（zod）层校验——`status` 不在枚举里直接 400，绝不拼进原始 SQL（防注入的老规矩）。
- `sort=-createdAt`：`-` 前缀表倒序，和 GitHub API 一致。可排序字段白名单化，不能让客户端按任意列排（否则逼出全表扫）。

---

## 5. 错误信封：统一一种形状

所有错误（4xx/5xx）长一个样，前端只需写一个错误处理分支：

```jsonc
{
  "error": {
    "code": "TASK_NOT_FOUND",          // 机器可读，前端 switch 用
    "message": "任务 ENG-999 不存在",   // 人可读，可直接展示
    "details": { "workspace": "acme", "number": 999 }
  }
}
```

HTTP 状态码用对的语义，别什么都 400/500：

| 场景 | 状态码 | code 示例 |
|---|---|---|
| 没登录 | 401 | `UNAUTHENTICATED` |
| 登录了但不是这工作区成员 / 角色不够 | 403 | `FORBIDDEN` / `INSUFFICIENT_ROLE` |
| 资源不存在 | 404 | `TASK_NOT_FOUND` |
| 参数不合法 / 枚举越界 | 400 | `VALIDATION_ERROR`（带字段级 details） |
| 乐观锁冲突（别人先改了） | 409 | `VERSION_CONFLICT` |
| 幂等键命中（重复提交） | 200 | 返回首次结果，`Idempotent-Replay: true` 响应头 |
| 限流 | 429 | `RATE_LIMITED`（带 `Retry-After`） |
| 服务端炸了 | 500 | `INTERNAL`（细节进日志，不回前端） |

> 403 vs 404 的安全取舍：**查一个你没权限的资源，返回 403 还是 404，看泄露存在性可不可接受**。在这套「团队协作」模型里，工作区成员之间本来就是互相可见的，所以一般直接 403（「你不是这工作区成员」）即可，不必像多租户那样统一伪装成 404。但「查别人工作区里的东西」仍建议 404——别向工作区外的人确认资源存在。

---

## 6. 幂等与乐观锁

两个容易混、但解决完全不同并发问题的机制：

- **`Idempotency-Key`（创建类幂等）**：解决「客户端重试」。用户连点两次「建任务」，两次请求带同一个 key，服务端第二次直接返回第一次建出的那张卡。key → 结果存 Redis（24h TTL）。适用于所有 POST 创建。
- **`If-Match: {version}`（更新类乐观锁）**：解决「服务端并发改」。两人同时改一张卡，各自带着读到的 `version`，第二个 PATCH 的 `WHERE version = ?` 命中 0 行 → 409 `VERSION_CONFLICT`，让前端刷新后重试。这是 Day 29 的乐观锁，这里直接用在任务更新上。

一句话区分：**幂等防「同一个请求被发多次」，乐观锁防「不同请求改同一份数据」**。

---

## 7. 限流

- **按用户 + 按工作区**两维限流。单按用户，一个活跃团队里的正常协作也会被误杀；加一维工作区级额度（如每工作区每分钟 600 次写），把「一个用户刷」和「一个团队正常用」分开。
- 写操作比读操作限得更紧（写更贵、更易滥用）。登录/注册端点单独更紧的额度（防爆破），Day 35 已有 `@nestjs/throttler`，多实例要换成 Redis 计数（Day 37 诚实清单留的口）。
- 超额返回 429 + `Retry-After`，别直接 500。

---

## 8. 落地：REST 还是 tRPC

上面这套用 REST 描述，但**契约本身和框架无关**。两条落地路的差别在 `decisions/ADR-003`，这里只给映射：

| 设计要素 | REST 表示 | tRPC 表示 |
|---|---|---|
| 建任务 | `POST /workspaces/{w}/projects/{k}/tasks` | `tasks.create({ workspaceSlug, projectKey, input })` |
| 列表分页 | query string + `nextCursor` | 同样，input 里带 `cursor?` |
| 错误 | HTTP 状态码 + error 信封 | `TRPCError` 的 code（404→NOT_FOUND 等）映射到同一套 code |
| 类型 | OpenAPI → codegen 前端类型 | **天然端到端类型**，无需 codegen |
| 鉴权 ctx | 中间件注入 `req.user` | `createContext` 注入 `ctx` |

无论选哪条，本文件的**资源划分、分页形状、错误 code、幂等键**这些契约都不变——这正是把设计层和实现层分开的价值：换框架不换契约。
