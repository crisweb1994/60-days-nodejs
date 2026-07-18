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
