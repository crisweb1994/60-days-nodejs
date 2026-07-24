# Day 55 - SaaS 任务管理平台部署上线

前 54 天解决的是“功能能不能工作”，今天解决的是另一类问题：这套代码能不能被稳定地构建、迁移、发布、观察和回滚。

上线不是把 `pnpm dev` 搬到服务器。开发模式会热更新、依赖完整源码，数据库常靠 `db push` 临时同步，进程退出后也没有人负责拉起。生产系统必须把这些隐含条件变成明确的发布协议。

## 今日目标

- 用多阶段 Dockerfile 产出可重复构建的 Next.js 生产镜像
- 将 Web、BullMQ worker 和数据库迁移拆成三个独立进程
- 用生产 Compose 在本机还原一次完整发布
- 建立 CI 校验链路，理解 CI 和 CD 的边界
- 掌握云平台、域名、HTTPS、健康检查和回滚的基本做法
- 做一轮上线前性能与安全检查

今天的参考实现位于 `solutions/saas`。

---

## 1. 先确定部署单元

这个项目并不只有一个 Next.js 进程：

```text
浏览器
  |
  v
Web 进程（Next.js + tRPC）
  |              |
  v              v
PostgreSQL      Redis / BullMQ
                    |
                    v
              Mail worker 进程
```

另外还有一个短命进程：

```text
Migration job -> prisma migrate deploy -> 执行完成后退出
```

因此，实际部署拓扑是：

```text
同一份代码、同一个版本
├── Web：node server.js
├── Worker：node dist/mail-worker.cjs
└── Migration：pnpm prisma:deploy（一次性任务）
```

Web 和 worker 可以共用一个运行镜像，因为它们来自同一次构建；但它们不能塞进同一个容器里。两个进程的扩缩容、故障恢复和资源消耗完全不同：

- Web 根据 HTTP 请求量扩容。
- Worker 根据队列积压扩容。
- Web 重启不应该顺手杀掉正在处理邮件的 worker。
- Worker 崩溃不应该让网站健康检查跟着失败。

“一个容器一个主要进程”不是形式主义，它让平台能够准确判断谁坏了、该重启谁。

### 为什么不直接只部署到 Vercel

Vercel 很适合标准 Next.js 页面和短时 Serverless 请求，但 BullMQ worker 是常驻进程：即使没有 HTTP 请求，它也必须持续监听 Redis。把 Web 放到 Vercel、worker 放到 Railway/Fly/Render 在技术上可行；如果想减少平台数量，则可以让 Web 和 worker 都运行在支持常驻容器的平台上。

判断标准不是“Next.js 就必须上 Vercel”，而是：系统有没有请求之外仍需持续运行的工作。

---

## 2. Dockerfile 在解决什么

参考实现使用四个构建阶段：

```text
base
  |
  +-- deps       安装完整依赖、生成 Prisma Client
       |
       +-- builder     构建 Next standalone 和 worker bundle
       |
       +-- migration   保留 Prisma CLI，专门执行迁移

runner             只接收运行产物，以非 root 用户启动
```

文件：`solutions/saas/Dockerfile`

### 2.1 为什么要多阶段构建

构建阶段需要 TypeScript、esbuild、Prisma CLI、源码和各种开发依赖；运行阶段只需要构建产物和被追踪到的生产依赖。

如果把所有东西留在最终镜像里，会产生三个问题：

1. 镜像更大，拉取和发布更慢。
2. 编译器、包管理器和源码都扩大了攻击面。
3. 运行环境和构建环境混在一起，很难判断某个文件究竟是不是生产必需品。

多阶段构建把最终镜像变成一个明确的交付物，而不是开发目录的压缩包。

### 2.2 Next.js standalone

`next.config.mjs` 开启了：

```js
output: "standalone"
```

`next build` 会根据服务端引用关系追踪运行所需文件，生成：

```text
.next/standalone/
├── server.js
├── node_modules/
└── .next/server/
```

静态资源不在 standalone 目录中，镜像还要单独复制 `.next/static`。漏掉这一行时，HTML 可能正常返回，但 JS 和 CSS 会 404，页面看起来像“服务起来了，前端却坏了”。

### 2.3 Prisma 和 Alpine

Prisma Client 不只是 JavaScript，它还需要与容器系统匹配的查询引擎。不要在 macOS 上生成 Client 后把整个 `node_modules` 复制进 Linux 镜像；应当在镜像构建阶段执行安装和 `prisma generate`。

Alpine 使用 musl libc，因此镜像显式安装：

```dockerfile
RUN apk add --no-cache libc6-compat openssl
```

pnpm 还会把依赖放进虚拟存储目录。手写 `node_modules/.prisma` 的复制路径很容易随着 pnpm 布局或 Prisma 版本变化而失效。这里让 Next 的 output file tracing 收集 Web 所需的 Prisma 运行文件，再通过真实镜像启动来验证，而不是猜路径。

### 2.4 Worker 为什么单独打包

Next 构建只关心页面和服务端路由，不会自动把一个独立的 TypeScript worker 变成可执行文件。项目增加了：

```json
{
  "build:worker": "esbuild src/server/notifications/mail-worker.ts --bundle --platform=node --target=node20 --format=cjs --outfile=.worker/mail-worker.cjs --external:@prisma/client"
}
```

业务代码和 BullMQ 相关依赖被打进 CommonJS 文件，`@prisma/client` 保持外部依赖，与 Next standalone 中的 Prisma Client 共用。最终同一镜像可以用两个命令启动：

```bash
node server.js
node dist/mail-worker.cjs
```

### 2.5 非 root 运行

最终镜像创建 `nextjs` 用户，并在 `USER nextjs` 后启动进程。容器隔离不等于可以放心使用 root；一旦应用存在远程执行漏洞，非 root 至少能减少攻击者在容器内能做的事情。

可以这样检查：

```bash
docker compose -f docker-compose.prod.yml exec web id
```

预期 uid 是 `1001`，而不是 `0`。

---

## 3. 构建时变量与运行时变量

环境变量最容易出现“本地正常，换变量后页面仍显示旧值”的问题，因为变量分两类。

### 构建时变量

`NEXT_PUBLIC_*` 会进入浏览器静态资源。它的值在 `next build` 时基本已经确定。修改后通常需要重新构建镜像：

```text
NEXT_PUBLIC_APP_NAME -> docker build --build-arg -> Next 静态资源
```

不要把密钥放进 `NEXT_PUBLIC_*`。这个前缀的含义就是“允许发给浏览器”。

### 运行时变量

数据库连接、Redis 连接和 Session 密钥由服务端进程启动时读取：

```text
DATABASE_URL
REDIS_URL
SESSION_SECRET
```

这些值由 Compose 或云平台注入，不应写进镜像。仓库只提交变量名和示例格式：

```text
solutions/saas/.env.production.example
```

生产密钥不要复用示例值。可以生成一个随机 Session 密钥：

```bash
openssl rand -base64 48
```

Session 密钥变更会使现有登录态失效，因此轮换前要知道它不是一个毫无影响的配置修改。

---

## 4. 数据库迁移必须成为发布步骤

开发时的 `prisma db push` 适合快速同步本地 schema，但它没有完整、可审查的迁移历史。生产环境应提交 migration，并运行：

```bash
pnpm prisma migrate deploy
```

Day 55 新增第一份基线：

```text
prisma/migrations/
├── migration_lock.toml
└── 20260724000000_init/
    └── migration.sql
```

这份初始 migration 可以直接用于空数据库。如果某个已有数据库过去一直使用 `prisma db push`，表已经存在但没有 `_prisma_migrations` 历史，直接执行会因为重复建表失败。应先备份并确认现有结构与基线 SQL 一致，再使用 `prisma migrate resolve --applied 20260724000000_init` 标记基线；结构不一致时要先写修复迁移，不能为了“让命令变绿”盲目标记。

### 为什么迁移不放进 Web 启动命令

假设 Web 扩容为三个实例，每个实例启动时都执行迁移：

```text
web-1 --┐
web-2 --+--> 同时争抢数据库 schema
web-3 --┘
```

即使 Prisma 有迁移锁，这种方式仍让应用启动时间和数据库变更耦合，失败状态也难以判断。更稳妥的顺序是：

```text
1. 构建镜像
2. 启动一次 migration job
3. migration 成功
4. 发布 Web
5. 发布 worker
6. 做健康检查和业务冒烟
```

迁移失败时，旧版本服务仍应继续运行，新版本不要进入流量。

### 可回滚代码，不等于可回滚数据库

镜像回滚很快，但数据库迁移可能已经删列或重写数据。生产迁移应尽量采用 expand/contract：

1. 先增加新列或新表，让新旧代码都能工作。
2. 发布写入新结构的代码并完成数据回填。
3. 确认旧代码不再使用旧结构。
4. 后续版本再删除旧列。

不要在同一次发布里既删旧列，又让新代码立即依赖这个破坏性变化。否则镜像虽然能回滚，旧代码也已经没有可用的数据库结构。

---

## 5. 用生产 Compose 还原一次发布

开发 Compose 只启动 PostgreSQL 和 Redis；生产演练文件还包含 migration、Web 和 worker：

```text
solutions/saas/docker-compose.prod.yml
```

准备变量：

```bash
cd solutions/saas
cp .env.production.example .env.production
```

至少替换 `POSTGRES_PASSWORD` 和 `SESSION_SECRET`，然后启动：

```bash
docker compose \
  --env-file .env.production \
  -f docker-compose.prod.yml \
  up -d --build
```

默认映射到 `3100`，不会占用日常开发服务的 `3000`：

```bash
curl "http://localhost:3100/api/trpc/health.ping"
```

查看状态和日志：

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs migrate
docker compose -f docker-compose.prod.yml logs web
docker compose -f docker-compose.prod.yml logs worker
```

正确状态应当是：

- `migrate` 以退出码 0 结束。
- PostgreSQL、Redis 和 Web 为 healthy。
- worker 日志出现 `listening queue=notification-mail`。
- Web 健康接口返回 `ok: true` 和 `database: up`。

停止演练：

```bash
docker compose -f docker-compose.prod.yml down
```

需要连数据卷一起重置时才使用：

```bash
docker compose -f docker-compose.prod.yml down -v
```

`-v` 会删除演练数据库，不应对真实生产环境随手执行。

---

## 6. 健康检查不是首页能打开就够了

当前探针请求：

```text
GET /api/trpc/health.ping
```

它会执行 `SELECT 1`，所以同时验证 Next 服务和 PostgreSQL。Dockerfile 的 `HEALTHCHECK` 使用这个接口，Compose 和云平台可以据此判断容器是否可以接流量。

需要理解两个概念：

- **Liveness**：进程还活着吗？失败通常意味着应该重启。
- **Readiness**：现在能接请求吗？失败时应先移出流量，不一定立刻重启。

本项目现阶段只有一个带数据库检查的健康接口，适合作为 readiness。更成熟的实现会拆成：

```text
/health/live   只检查 Node 事件循环和进程状态
/health/ready  检查数据库，并按业务需要检查 Redis
```

不要让 liveness 强依赖偶发抖动的外部服务。数据库短暂超时就重启所有 Web 实例，可能把一个小故障放大成重启风暴。

worker 没有 HTTP 端口，健康状态可由平台的进程退出码、重启次数、队列积压和失败任务数判断。
生产 Compose 因此显式关闭 worker 继承到的 Web HTTP 探针；云平台部署 worker 时也要覆盖镜像级 HTTP 健康检查，改用进程状态和队列指标。

---

## 7. CI 和 CD 分别负责什么

### CI：证明这个提交可以成为候选版本

参考工作流：

```text
solutions/saas/.github/workflows/ci.yml
```

它会启动 PostgreSQL 和 Redis service containers，然后执行：

```text
pnpm install --frozen-lockfile
pnpm prisma:generate
pnpm prisma:deploy
pnpm typecheck
pnpm build
docker build --target runner
```

这几步分别防止：

- lockfile 与 package.json 不一致。
- Prisma Client 没有生成或 migration 无法落库。
- TypeScript 合同被破坏。
- Next 页面或 worker 无法构建。
- Dockerfile 只是“看起来合理”，实际镜像构建失败。

Day 56 才补系统化测试策略，所以今天的 CI 还没有完整单元测试、集成测试和 E2E；不能把“build 绿了”描述成“业务已经全部正确”。

> GitHub Actions 只读取仓库根目录的 `.github/workflows/*.yml`。为了让每天的答案保持自包含，示例工作流放在 `solutions/saas/.github/workflows`。真正启用时，应把它移动到仓库根 `.github/workflows/saas-ci.yml`，工作目录配置保持为 `solutions/saas`。

### CD：把已经验证的版本发布出去

一个实用的 CD 流程是：

```text
CI 通过
  -> 用 commit SHA 构建并推送镜像
  -> migration job
  -> 发布 Web
  -> 发布 worker
  -> readiness 通过
  -> 业务冒烟
  -> 标记发布成功
```

镜像标签应优先使用不可变标识：

```text
registry.example.com/saas:git-a1b2c3d
```

`latest` 可以作为方便人查看的别名，但不要只依赖 `latest`。当线上出问题时，必须能准确回答“正在运行哪个提交”和“要回滚到哪个镜像”。

---

## 8. 云平台部署

这套架构适合 Railway、Fly.io、Render、ECS、Kubernetes 等支持常驻容器和多服务的平台。第一次上线不必急着上 Kubernetes；两个常驻服务加两个托管中间件，Railway/Fly 这类平台更省运维成本。

建议建立两个服务：

| 服务 | 镜像 | 启动命令 | 对公网 |
|---|---|---|---|
| Web | runner | `node server.js` | 是 |
| Worker | runner | `node dist/mail-worker.cjs` | 否 |

再配置：

- 托管 PostgreSQL，注入 `DATABASE_URL`。
- 托管 Redis，注入 `REDIS_URL`；TLS 服务通常使用 `rediss://`。
- 两个服务使用同一个 `SESSION_SECRET`、数据库和 Redis。
- Web 配置 `/api/trpc/health.ping` 健康检查。
- worker 禁止 scale-to-zero，否则没有请求时邮件队列也不会被消费。
- 发布前运行一次 `migration` 构建目标或在受控 CI job 中执行 `pnpm prisma:deploy`。

不要把 Web 和 worker 分别从不同 commit 构建。队列消息格式属于跨进程合同，版本漂移会让 Web 生产的新任务无法被旧 worker 正确消费。

### 连接池要按总实例数计算

数据库最大连接数不是每个实例都能使用的额度。粗略计算：

```text
总连接上限 >= Web 实例数 × 每实例连接池
             + Worker 实例数 × 每实例连接池
             + migration/运维预留
```

如果使用 Neon、Supabase 等带连接池代理的服务，要区分应用连接串和迁移直连串。迁移涉及 DDL，某些 transaction pooler 模式不适合执行迁移。最稳妥的做法是遵循供应商给 Prisma 的连接建议，并在预发布环境先跑一次。

---

## 9. 域名、DNS 与 HTTPS

上线顺序建议先用平台默认域名验证，再绑定自己的域名：

```text
平台默认域名可访问
  -> 健康检查通过
  -> 绑定 app.example.com
  -> 配置 DNS
  -> 等证书签发
  -> 验证 HTTPS 和 Cookie
```

常见 DNS 记录：

- 子域名通常使用 `CNAME` 指向平台提供的目标地址。
- 根域名可能使用 `A/AAAA`，或 DNS 服务商提供的 ALIAS/ANAME flattening。

HTTPS 通常在云平台的负载均衡层终止，容器内部仍监听 HTTP `3000`。这不代表公网使用 HTTP，而是：

```text
浏览器 --HTTPS--> 平台 TLS 入口 --HTTP/私网--> Web 容器
```

绑定域名后至少检查：

```bash
curl -I http://app.example.com
curl -I https://app.example.com
curl "https://app.example.com/api/trpc/health.ping"
```

HTTP 应跳转 HTTPS，证书域名应匹配，健康接口应返回 200。

当前 Session Cookie 在生产环境会设置 `Secure`，因此必须通过 HTTPS 做最终登录验证。只测健康接口不能发现 Cookie 域、Secure、SameSite 或反向代理配置问题。

---

## 10. 上线前的性能检查

性能优化先找瓶颈，不要先加缓存。对这套项目，第一轮检查按以下顺序更有效。

### 10.1 前端产物

`pnpm build` 会输出路由体积。关注 First Load JS 是否突然增长，检查大依赖是否被错误引入客户端组件。Day 55 当前首页 First Load JS 约 114 kB，后续应把它作为回归基线，而不是追求一个脱离业务的绝对数字。

### 10.2 数据库查询

高频路径包括：

- 工作区内的项目列表。
- 项目看板按 `projectId + status + order` 查询。
- 任务列表分页、筛选和排序。
- 通知按接收人、已读状态和创建时间查询。

schema 已为这些路径建立联合索引。上线后仍要用慢查询日志或 `EXPLAIN ANALYZE` 验证实际 SQL 是否命中索引；“schema 里有索引”不等于“查询一定使用索引”。

### 10.3 Redis 和队列

观察：

- waiting 数量是否持续增长。
- failed 任务是否突然增加。
- 单任务耗时和重试次数。
- worker 重启次数。

队列积压通常说明 worker 容量不足、外部邮件服务变慢，或任务持续失败。单纯增加并发可能触发邮件供应商限流，需要结合下游配额调整。

### 10.4 SSE 的单实例边界

Day 51 的实时事件总线是内存实现。单 Web 实例时可以工作；多个 Web 实例后，连接在 A 实例、更新落在 B 实例时，A 收不到 B 的内存事件。

因此当前版本有两种诚实选择：

1. Web 暂时保持单实例，接受容量上限。
2. 扩容前把事件总线改成 Redis Pub/Sub 或专门的实时消息系统。

这比“先开三个实例再看为什么偶尔不同步”便宜得多。

---

## 11. 上线前的安全检查

- 生产环境没有提交 `.env.production`，仓库里只有 example。
- `SESSION_SECRET` 使用随机值且至少 32 字节。
- 数据库和 Redis 不直接暴露公网，或已启用 TLS、IP 白名单和强密码。
- Web 容器以非 root 用户运行。
- 只对外暴露 Web，worker、PostgreSQL、Redis 都留在私网。
- 日志不输出密码、Cookie、Session token 和完整数据库连接串。
- 平台设置 CPU、内存限制和合理的重启策略。
- 依赖安装使用 frozen lockfile。
- 数据库有自动备份，并做过恢复演练。

备份“任务显示成功”不等于可以恢复。真正可靠的标准是：在隔离环境中从备份恢复，并验证关键表和业务流程。

---

## 12. 发布后的业务冒烟

健康检查只能证明服务和数据库可连，不能证明核心业务可用。至少跑一次：

1. 注册或登录。
2. 创建工作区。
3. 创建项目。
4. 创建任务并切换状态。
5. 给其他成员分配任务，产生通知。
6. 确认 worker 消费邮件任务，通知状态变为 `SENT`。
7. 刷新页面，确认数据持久化。

冒烟失败时先停止继续放量，保留容器日志、请求 ID、镜像 SHA 和 migration 输出，再决定修复还是回滚。不要在证据还没收集时反复重启，重启常常会抹掉最有用的现场。

---

## 13. 回滚策略

最小可行回滚方案需要保存：

- 当前镜像 SHA。
- 上一个稳定镜像 SHA。
- 本次 migration 内容和执行结果。
- 发布开始与结束时间。
- 发布期间的错误率和延迟基线。

代码回滚流程：

```text
停止继续发布
  -> 将 Web 切回旧镜像
  -> 将 worker 切回同一旧镜像
  -> 验证 readiness
  -> 跑核心业务冒烟
  -> 继续观察错误率和队列积压
```

如果 migration 与旧代码不兼容，不能盲目切旧镜像。这就是前面要采用 expand/contract 的原因：发布设计本身决定了回滚是不是可行。

---

## 14. 本次参考实现的文件变化

| 文件 | 作用 |
|---|---|
| `next.config.mjs` | 开启 standalone 输出 |
| `package.json` | 增加 worker 构建、生产启动和 migrate deploy 脚本 |
| `Dockerfile` | deps / builder / migration / runner 多阶段镜像 |
| `.dockerignore` | 避免把本地依赖、密钥和构建产物送进构建上下文 |
| `docker-compose.prod.yml` | PostgreSQL、Redis、migration、Web、worker 的生产演练 |
| `.env.production.example` | 本地演练与云平台变量清单 |
| `prisma/migrations/*` | 可审查、可重复执行的数据库基线 |
| `.github/workflows/ci.yml` | PostgreSQL/Redis、迁移、类型、构建和镜像校验 |

---

## 15. 本次实跑记录

2026-07-24 在 macOS + Docker Desktop 29.2.1 上使用全新 Compose 项目和生产数据卷验证，结果如下：

- `prisma validate`、`pnpm typecheck`、`pnpm build` 全部通过。
- Next standalone 与 worker bundle 均在 Alpine 容器内完成构建，worker bundle 约 1.6 MB。
- runner 镜像约 179 MB，运行用户为 `nextjs`，uid/gid 均为 1001。
- migration 容器首次应用 `20260724000000_init` 后以 0 退出，再次启动显示没有待执行迁移。
- PostgreSQL、Redis、Web 均健康；worker 保持运行且不再误用 Web 的 HTTP 探针。
- `health.ping` 返回 `ok: true`、`database: up`。
- API 冒烟完成两个用户注册、邀请入组、创建项目、创建并分配任务、状态流转和看板读取。
- BullMQ worker 消费了 `OPS-1` 的邮件任务，通知记录最终为 `SENT`。
- 浏览器完成生产环境登录，仪表盘和看板显示同一条任务，控制台没有 warning/error。

实跑过程中发现并修正了一个静态审查不容易察觉的问题：Web 与 worker 共用 runner 镜像时，worker 会继承 Dockerfile 中面向 Web 的 HTTP `HEALTHCHECK`。worker 不监听 3000 端口，因此 Compose 必须对它执行 `healthcheck.disable: true`，否则业务进程明明正常，容器仍会被标成 unhealthy。

首次容器构建还遇到 npm 与 Prisma 二进制下载速度不稳定。Dockerfile 保留官方源作为默认值，Compose 通过 `NPM_REGISTRY` 和 `PRISMA_ENGINES_MIRROR` 提供可覆盖的构建参数。这两个变量只影响构建下载，不属于应用运行配置，也不应改变 lockfile 中锁定的包版本和完整性校验。

---

## 实践练习

### 练习一：完成本地生产发布

```bash
cd solutions/saas
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
docker compose -f docker-compose.prod.yml up -d --build
curl "http://localhost:3100/api/trpc/health.ping"
```

记录镜像大小、容器健康状态、migration 输出和 worker 启动日志。

### 练习二：验证故障边界

依次停止 Redis 和 PostgreSQL，观察：

- Web 健康状态如何变化。
- worker 是否退出或重连。
- Redis 恢复后积压任务是否继续消费。
- PostgreSQL 恢复后 Web 是否需要重启。

不要只记录“坏了”，要记录故障发生到被探针发现的时间、日志内容和恢复步骤。

### 练习三：设计一次可回滚字段变更

假设要把 `Task.description` 拆成 `descriptionJson`。写出至少两次发布：第一次如何兼容读写，如何回填，第二次何时删除旧列。目标是让任一阶段都能把 Web 和 worker 回滚到前一个镜像。

---

## 今日产出

- [ ] 能画出 Web、worker、migration、PostgreSQL、Redis 的部署拓扑
- [ ] `pnpm typecheck` 与 `pnpm build` 通过
- [ ] 生产镜像构建成功，Web 以非 root 用户运行
- [ ] migration job 成功退出，Web 和 worker 随后启动
- [ ] 健康接口和注册、工作区、项目、任务、通知链路冒烟通过
- [ ] 能解释构建时变量与运行时变量的差别
- [ ] 能解释为什么 worker 不能只放在 Vercel Serverless 中
- [ ] 写下域名、HTTPS、镜像标签、回滚和数据库备份方案
- [ ] 将 CI 文件移动到仓库根工作流目录并在 GitHub 上跑绿

---

[上一天：Day 54](../day-54/) | [下一天：Day 56](../day-56/)
