# Day 47 — 项目脚手架与基础设施

> Day 46 把 SaaS 任务管理平台的核心设计钉住了：工作区是协作单位，权限挂在 Membership 上，任务顺着 `Task -> Project -> Workspace` 回溯归属。今天开始把那份设计落成能运行的工程。
>
> 这一天不急着写业务功能。真正要完成的是一件更基础、更容易被低估的事：让项目有一个稳定的壳。它应该能启动 Next.js，能暴露 tRPC 接口，能让 Prisma 读到 Day 46 的 schema，能用 Docker Compose 拉起本地 PostgreSQL 和 Redis，还能用一条健康检查证明「前后端、接口层、数据库连接」已经接上。
>
> 一句话目标：把 `solutions/saas/` 从设计目录升级成**可运行脚手架**。

## 📋 今日目标

- 搭建 **Next.js App Router + TypeScript** 项目骨架
- 接入 **tRPC**：建立 `router / procedure / context` 三件套，并暴露 `/api/trpc/*`
- 接入 **Prisma**：复用 Day 46 的 `prisma/schema.prisma`，配置 client 单例
- 增加 **环境变量校验**：启动时尽早发现 `DATABASE_URL` 等配置缺失
- 增加 **Docker Compose 开发环境**：PostgreSQL + Redis + 持久化 volume
- 提供一个最小健康检查：`health.ping` 返回应用状态，并尝试 `SELECT 1`

> 配套代码：`solutions/saas/`。今天新增 `package.json`、Next.js 配置、`src/app` 页面与 tRPC route、`src/server` 服务端基础设施、`.env.example`、`docker-compose.yml`。Day 46 的 `prisma/schema.prisma` 原样继续作为数据模型来源。

---

## 📖 核心知识点

### 1. 脚手架不是「空项目」，而是项目的地基

很多人把脚手架理解成 `npm create next-app` 生成的一堆文件。但在真实项目里，脚手架至少要回答四个问题：

| 问题 | 今天的答案 |
|---|---|
| 应用怎么启动 | `pnpm dev` 启动 Next.js |
| API 怎么暴露 | tRPC route 挂在 `/api/trpc/[trpc]` |
| 数据库怎么连 | Prisma Client 读取 `DATABASE_URL` |
| 本地依赖怎么跑 | Docker Compose 拉起 PostgreSQL / Redis |

所以今天的重点不是页面好不好看，也不是业务 CRUD 多不多，而是**工程边界是否清楚**：配置集中在哪里、服务端代码放在哪里、API router 怎么组织、数据库连接能不能被验证。

### 2. 为什么这条弧线选 Next.js + tRPC

博客弧线用 NestJS + REST，是为了练后端基本功：Controller、DTO、Pipe、Guard、Interceptor、Filter、OpenAPI。这些很重要。

但 SaaS 产品从今天开始会有大量前后端协作：任务列表字段改一次，前端查询和后端返回都要同步；成员权限加一个状态，页面和接口都要知道。这里 tRPC 的优势很直接：**后端 router 的类型能直接推到前端**，少掉「接口文档写了但实现变了」这一类错。

今天只做 tRPC 的最小骨架：

```ts
export const appRouter = router({
  health: healthRouter,
});
```

这看起来很小，但它把后面的增长路线定好了：Day 48 加 `authRouter` / `workspaceRouter`，Day 49 加 `projectRouter` / `taskRouter`，每个模块都从这棵 router 树上长出来。

### 3. App Router 下的 tRPC route

Next.js App Router 的 API route 是 Web Fetch 风格，不是 Express 风格。tRPC 对它的适配器是 `fetchRequestHandler`：

```ts
export const GET = handleRequest;
export const POST = handleRequest;
```

这意味着同一个 `/api/trpc/[trpc]` route 可以处理：

- GET query：例如 `health.ping`
- POST mutation：后面创建任务、邀请成员会用到
- context 注入：每个 procedure 都能拿到 `prisma`

今天的 `createTRPCContext()` 只放了 Prisma。以后接认证时，这里会继续扩展成：

```ts
{ prisma, session, user, requestId }
```

### 4. Prisma 单例：为什么不能每次 new

开发环境 Next.js 会热更新。如果每次模块刷新都 `new PrismaClient()`，本地很快会堆出一串数据库连接，最后 PostgreSQL 报连接数耗尽。

所以脚手架里用了常见的 global 缓存写法：

```ts
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: ["warn", "error"] });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
```

生产环境模块生命周期稳定，不需要挂 global；开发环境热更新频繁，用 global 复用连接。

### 5. 环境变量校验：让错误早一点爆

`DATABASE_URL` 写错，不应该等到某个用户点页面、某个接口第一次查库才发现。今天新增 `src/env.ts`，用 Zod 在服务端启动路径里校验：

```ts
const serverSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});
```

这和 Day 20 的思路一样：**配置是代码的一部分**。越靠前发现，排查成本越低。

### 6. Docker Compose：本地基础设施要可复制

今天的 `docker-compose.yml` 只放两个基础服务：

- `postgres`：应用的唯一真相源
- `redis`：后续缓存、限流、队列会用

应用本身暂时不放进 compose。原因很实际：Day 47 还是开发脚手架，前端热更新交给本机 `pnpm dev` 更顺手；compose 负责那些「不该手装、不该凭记忆启动」的依赖。

本地启动顺序：

```bash
cd solutions/saas
cp .env.example .env
docker compose up -d
pnpm install
pnpm prisma:generate
pnpm prisma:push
pnpm dev
```

然后打开：

```bash
curl "http://localhost:3000/api/trpc/health.ping"
```

如果能看到 `ok: true` 且 `database: "up"`，说明 Next.js、tRPC、Prisma、PostgreSQL 已经接通。

---

## 改动清单（Day 47 参考答案）

| 文件 | 是什么 |
|---|---|
| `package.json` | 新增：Next.js / tRPC / Prisma / Zod 依赖与脚本 |
| `.env.example` | 新增：本地开发环境变量模板 |
| `docker-compose.yml` | 新增：PostgreSQL + Redis 本地开发依赖 |
| `next.config.mjs` / `tsconfig.json` | 新增：Next.js TypeScript 基础配置 |
| `src/env.ts` | 新增：服务端环境变量校验 |
| `src/server/db.ts` | 新增：Prisma Client 单例 |
| `src/server/trpc.ts` | 新增：tRPC 初始化、router/procedure 导出 |
| `src/server/routers/_app.ts` | 新增：根 router |
| `src/server/routers/health.ts` | 新增：健康检查 procedure，包含 DB ping |
| `src/app/api/trpc/[trpc]/route.ts` | 新增：tRPC HTTP 入口 |
| `src/app/page.tsx` / `src/app/layout.tsx` / `src/app/globals.css` | 新增：最小可见首页 |
| `README.md` | 更新：从 Day 46 设计索引升级为可运行脚手架说明 |

---

## 💻 实践练习

1. **跑通基础设施**

   ```bash
   cd solutions/saas
   cp .env.example .env
   docker compose up -d
   ```

   检查容器：

   ```bash
   docker compose ps
   ```

2. **生成 Prisma Client 并同步 schema**

   ```bash
   pnpm install
   pnpm prisma:generate
   pnpm prisma:push
   ```

   这里用 `db push` 是因为 Day 47 先验证脚手架，不急着维护正式 migration。真正进入可演进开发后，再用 `prisma migrate dev` 固化迁移。

3. **启动应用并验证 tRPC**

   ```bash
   pnpm dev
   curl "http://localhost:3000/api/trpc/health.ping"
   ```

   期望结果里至少包含：

   ```json
   {
     "ok": true,
     "database": "up"
   }
   ```

4. **读代码回答三个问题**

   - `src/server/trpc.ts` 里的 context 为什么要集中创建？
   - `src/server/db.ts` 为什么开发环境要把 Prisma Client 挂到 `globalThis`？
   - `src/env.ts` 为什么要在启动路径里校验环境变量，而不是在用到时再读？

5. **扩展练习**

   给 `healthRouter` 增加一个 `version` 字段，从 `package.json` 读当前版本；然后重新请求 `health.ping`，确认返回结构变化。

---

## ✅ 今日产出

- [ ] `solutions/saas` 可以 `pnpm dev` 启动
- [ ] 本地 PostgreSQL / Redis 可以通过 `docker compose up -d` 启动
- [ ] Prisma Client 可以生成，schema 可以同步到 PostgreSQL
- [ ] `/api/trpc/health.ping` 可以返回健康状态
- [ ] 能讲清 Next.js、tRPC、Prisma、Docker Compose 在这套脚手架里的分工
- [ ] 提交 Day 47 脚手架代码到 GitHub

---

[⬅️ Day 46](../day-46/) | [➡️ Day 48](../day-48/)
