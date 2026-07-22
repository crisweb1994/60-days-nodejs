# SaaS 任务管理平台 — Day 51 实时通信

这是 Day 46 起的 **SaaS 任务管理平台** 弧线配套代码目录。Day 46 这里只有设计产出；Day 47 开始，它变成一个可以启动的 Next.js + tRPC + Prisma 工程。

这仍然是一个**普通的协作型 SaaS**，不是企业级多租户：用户注册，建工作区，邀请成员，在项目里管理任务。数据归属沿用 Day 46 的设计：`Task -> Project -> Workspace`，能看见 = 你是工作区成员。

Day 48 补上用户与团队；Day 49 补上项目和任务核心业务；Day 50 补上看板读模型、列表筛选分页和拖拽排序后端支持；Day 51 增加 SSE 实时事件流，用来同步任务变更和在线用户。

## 当前包含

```
solutions/saas/
├── src/
│   ├── app/
│   │   ├── api/trpc/[trpc]/route.ts  # tRPC HTTP 入口
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── env.ts                        # 环境变量校验
│   └── server/
│       ├── db.ts                     # Prisma Client 单例
│       ├── trpc.ts                   # tRPC 初始化
│       ├── auth/                     # 密码、session、RBAC
│       ├── domain/                   # 领域规则（状态机、游标）
│       ├── realtime/                 # SSE 事件类型、事件总线、编码
│       └── routers/
│           ├── _app.ts               # 根 router
│           ├── auth.ts               # 注册/登录/me/logout
│           ├── health.ts             # health.ping
│           ├── projects.ts           # 项目 CRUD
│           ├── tasks.ts              # 任务 CRUD/状态/标签/评论
│           └── workspaces.ts         # 工作区/成员/邀请
│   └── app/api/realtime/             # 工作区 SSE 订阅接口
├── prisma/
│   └── schema.prisma                 # Day 46 数据模型
├── docs/                             # Day 46 架构设计与 ADR
├── docker-compose.yml                # PostgreSQL + Redis
├── .env.example
├── next.config.mjs
├── package.json
└── tsconfig.json
```

## 本地启动

```bash
cd solutions/saas
cp .env.example .env
docker compose up -d
pnpm install
pnpm prisma:generate
pnpm prisma:push
pnpm dev
```

打开首页：

```text
http://localhost:3000
```

验证 tRPC + Prisma + PostgreSQL：

```bash
curl "http://localhost:3000/api/trpc/health.ping"
```

数据库正常时，返回数据里会看到：

```json
{
  "result": {
    "data": {
      "json": {
        "ok": true,
        "database": "up"
      }
    }
  }
}
```

## 常用命令

```bash
pnpm dev              # 启动 Next.js 开发服务
pnpm build            # 生产构建
pnpm typecheck        # TypeScript 检查
pnpm prisma:generate  # 生成 Prisma Client
pnpm prisma:push      # 把 schema 同步到本地数据库
pnpm prisma:migrate   # 生成正式 migration
pnpm prisma:studio    # 打开 Prisma Studio
```

## Day 48 API 快速试跑

注册并保存 httpOnly cookie：

```bash
curl -i -c /tmp/saas-cookie.txt \
  -X POST "http://localhost:3000/api/trpc/auth.register" \
  -H "content-type: application/json" \
  --data '{"json":{"email":"owner@example.com","password":"password123","name":"Owner"}}'
```

创建工作区：

```bash
curl -b /tmp/saas-cookie.txt \
  -X POST "http://localhost:3000/api/trpc/workspaces.create" \
  -H "content-type: application/json" \
  --data '{"json":{"name":"Acme Team","slug":"acme-team"}}'
```

查看当前用户：

```bash
curl -b /tmp/saas-cookie.txt \
  "http://localhost:3000/api/trpc/auth.me"
```

## Day 49/50 API 快速试跑

创建项目：

```bash
curl -b /tmp/saas-cookie.txt \
  -X POST "http://localhost:3000/api/trpc/projects.create" \
  -H "content-type: application/json" \
  --data '{"json":{"workspaceSlug":"acme-team","key":"ENG","name":"Engineering"}}'
```

创建任务：

```bash
curl -b /tmp/saas-cookie.txt \
  -X POST "http://localhost:3000/api/trpc/tasks.create" \
  -H "content-type: application/json" \
  --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","title":"Ship Day 49","priority":"HIGH","labelNames":["backend","day49"]}}'
```

状态流转：

```bash
curl -b /tmp/saas-cookie.txt \
  -X POST "http://localhost:3000/api/trpc/tasks.transition" \
  -H "content-type: application/json" \
  --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","number":1,"expectedVersion":1,"status":"TODO"}}'
```

读取看板：

```bash
curl -g -b /tmp/saas-cookie.txt \
  "http://localhost:3000/api/trpc/tasks.board?input={\"json\":{\"workspaceSlug\":\"acme-team\",\"projectKey\":\"ENG\"}}"
```

读取列表视图：

```bash
curl -g -b /tmp/saas-cookie.txt \
  "http://localhost:3000/api/trpc/tasks.listView?input={\"json\":{\"workspaceSlug\":\"acme-team\",\"projectKey\":\"ENG\",\"limit\":20,\"sortField\":\"updatedAt\",\"sortDirection\":\"desc\"}}"
```

拖拽排序 / 跨列移动：

```bash
curl -b /tmp/saas-cookie.txt \
  -X POST "http://localhost:3000/api/trpc/tasks.reorder" \
  -H "content-type: application/json" \
  --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","number":1,"expectedVersion":1,"status":"TODO"}}'
```

## Day 51 SSE 实时事件

打开工作区事件流：

```bash
curl -N -b /tmp/saas-cookie.txt \
  "http://localhost:3000/api/realtime/workspaces/acme-team/events"
```

另开终端创建任务：

```bash
curl -b /tmp/saas-cookie.txt \
  -X POST "http://localhost:3000/api/trpc/tasks.create" \
  -H "content-type: application/json" \
  --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","title":"Realtime card"}}'
```

SSE 终端会收到 `task.created`。任务更新、拖拽、删除和评论也会发布对应事件。

## 设计文档阅读顺序

1. `prisma/schema.prisma`：数据模型，重点看 `User / Workspace / Membership / Project / Task`
2. `docs/architecture.md`：组件、时序、ER、部署拓扑
3. `docs/api-design.md`：授权、分页、错误、幂等、REST/tRPC 映射
4. `docs/decisions/ADR-*`：关键架构决策

## 当前边界

OAuth 还没有接真实 Provider；邀请 token 现在直接从 API 返回，方便本地练习，生产里应该通过邮件发送。Day 51 的实时事件总线是单实例内存版，适合本地开发和单实例部署；多实例需要 Redis Pub/Sub，离线可见通知留给 Day 52。
=======
# SaaS 任务管理平台 — 配套设计（Day 46 起）

这是 Day 46 起的 **SaaS 任务管理平台** 弧线的配套代码目录。和 `solutions/blog`（Day 17-45 的博客）平行——博客练的是「单体 CRUD + 缓存 + 队列 + 部署」基本功，这一弧线练的是「**一个带团队协作的普通 SaaS 从 0 到 1**」：从架构设计（Day 46）到脚手架（Day 47）、用户与团队（Day 48），往后到通知、实时、计费。

这是一个**普通的 SaaS**，不是企业级多租户：用户注册 → 建工作区（团队）→ 邀请成员 → 在项目里管任务。数据归属走「项目属于工作区、能看见 = 你是成员」这条朴素链子，**不**做 `orgId` 冗余 + RLS 那套租户隔离机器（见 `docs/decisions/ADR-001`）。

Day 46 是**规划与架构设计**，所以这个目录里**现在全是设计产出，没有可运行代码**——脚手架是 Day 47 的事。

## 目录结构

```
solutions/saas/
├── README.md                 # 你在这里
├── prisma/
│   └── schema.prisma         # 数据模型（User/Workspace/Membership/Project/Task/...）
└── docs/
    ├── architecture.md       # 系统架构、组件/时序/ER 图、部署拓扑
    ├── api-design.md         # 资源建模、授权、游标分页、错误、幂等
    └── decisions/            # 关键决策记录（ADR）
        ├── ADR-001-collaboration-model.md    # 工作区/团队协作模型（不做多租户）
        ├── ADR-002-sync-before-realtime.md   # 同步优先，实时后置
        ├── ADR-003-api-style-trpc-vs-rest.md # API 风格
        ├── ADR-004-soft-delete.md            # 软删除策略
        └── ADR-005-public-ids-uuid.md         # 公开 ID 用 UUID
```

## 怎么读

按这个顺序，每篇都为下一篇铺路：

1. **`prisma/schema.prisma`** — 先看数据模型。带着「**一个项目属于一个工作区、能看见 = 你是成员**」这条归属链读，它是整套授权设计的物理体现。
2. **`docs/architecture.md`** — 看组件怎么切、一个请求怎么穿过系统、部署长什么样。尤其 §3 的「创建任务时序」，它把鉴权 + 授权讲透了。
3. **`docs/api-design.md`** — 看接口契约。资源怎么分、分页怎么定、错误长什么样、幂等和乐观锁各管什么并发问题。
4. **`docs/decisions/ADR-*`** — 看每个「为什么」。这些是 Day 46 最重要的产出：架构图会演进，但「为什么这么选」的推理是 durable 的。

## 这版的设计立场（一张表速览）

| 决策点 | 选择 | 一句话理由 | 详见 |
|---|---|---|---|
| 协作模型 | 工作区（团队）+ 成员身份，**不做**多租户隔离 | 威胁模型里没有「跨租户互不信任」，不付那个税 | ADR-001 |
| 实时协作 | 同步优先，实时后置 | YAGNI，把 CRDT 推到真需要时 | ADR-002 |
| API 风格 | 内部 tRPC，外部留 REST | 端到端类型省掉一整类接口 bug | ADR-003 |
| 删除策略 | 内容软删可恢复，账号硬删 | 卖「单条可恢复」的粒度 | ADR-004 |
| 公开 ID | UUID 主键 + 项目内编号对外 | 不可枚举 + 人好念 | ADR-005 |

> 这些立场彼此咬合：协作模型（001）定了「能看见 = 是成员」，授权就顺着 `Task → Project → Workspace` 这条链做；项目内编号（005）配合软删除（004）支撑「误删可恢复」。读到后面会发现没有哪个决策是孤立的——这就是架构设计的味道。

