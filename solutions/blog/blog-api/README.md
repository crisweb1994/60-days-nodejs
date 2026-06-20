# Blog API — NestJS + Prisma + PostgreSQL（阶段二里程碑 v1.0）

> 演进路线：Day 20 内存版里程碑 → Day 27 接入 PostgreSQL → Day 28 分页/搜索 → Day 29 并发控制 → Day 30 OpenAPI 文档（v1.0）→ Day 32 JWT 认证 → Day 33 RBAC 授权 → **Day 34 OAuth/GitHub 登录**。各天细节见下方对应小节与 `days/` 下的 README。

Day 16–19 的知识点整合成一个能跑、能交接、能在切 PostgreSQL 时不返工的完整项目（Day 20 里程碑）。**Day 27 兑现了当初的承诺**：把内存仓储换成 Prisma + PostgreSQL，Service / Controller / DTO / Filter 一行未改——见下方「Day 27 更新」。**Day 28** 给列表加 cursor 分页和全文搜索——见「Day 28 更新」。

## Day 27 更新：接入 PostgreSQL + Prisma

Day 20 留了个伏笔——所有 Repository 方法都返回 `Promise`，Service 只依赖 `PostsRepository` 接口。Day 27 把这个伏笔兑现：

- 新增 `PrismaService`（`extends PrismaClient implements OnModuleInit / OnModuleDestroy`）+ 全局 `PrismaModule`
- 新增 `PrismaPostsRepository implements PostsRepository`：负责领域实体 ↔ DB 行的映射（防腐层）
- `posts.module.ts` 把 `POSTS_REPOSITORY` 的 `useClass` 从 `InMemoryPostsRepository` 换成 `PrismaPostsRepository`——**只动这一行**
- 测试拆成两层：`posts.service.unit.test.ts`（mock 仓储，不连库）+ `posts.e2e.test.ts`（真 PG）

与 `blog-prisma` 的分工：`blog-prisma` 是 Day 25/26 的独立 playground（`db pull` 映射 blog-db 的 7 张表）；`blog-api` 这里是把 Prisma 当作 **schema 的唯一真相**，用 `prisma migrate` 建自己的 `posts` 表（独立 `blog_api` schema），两者复用同一个 PG 实例但互不干扰。

## Day 28 更新：分页 / 搜索 / 排序

在 Day 27 的 Prisma 基础上，给列表加三种访问方式（`GET /posts` 不变，新增两条）：

- `GET /posts`：**offset 分页**（沿用），能跳页 + 给总数，适合后台表格
- `GET /posts/feed`：**cursor / keyset 分页**，稳定不漂移、深翻不掉速，适合信息流
- `GET /posts/search`：**全文搜索**，`$queryRaw` + `websearch_to_tsquery` + `ts_rank` 相关度排序

配套：`PostsRepository` 接口加 `findByCursor` / `search`（Prisma 与 InMemory 两个实现都补齐）；`src/posts/cursor.ts` 做不透明游标编解码；可选的搜索索引放在 `prisma/sql/001_search_indexes.sql`（表达式 / trigram 索引 Prisma 的 schema 表达不了，独立于 `migrate` 管理）。

详细讲解见 [Day 28 README](../../../days/day-28/)。

## Day 29 更新：事务与并发控制

给 Post 加并发控制，并引入第一张需要**多写事务**的关联表：

- `Post` 加 `version`（乐观锁）+ `viewCount`（原子计数）；新增 `post_revisions` 修订表
- `PATCH /posts/:id` 支持可选 `version`：带上即做**乐观锁**（`WHERE version=?`，不一致 → 409 `VERSION_CONFLICT`）；不带则 last-write-wins
- `update` 现在是**交互式事务**：乐观锁更新 + 同事务写一条修订快照，要么都成要么都不成
- `POST /posts/:id/view`：浏览计数**原子自增**（`{ increment: 1 }`），可交换写无需锁
- `GET /posts/:id/revisions`：修订历史（新 → 旧）

事务 / 隔离级别的纯演示在 Day 26 的 `blog-prisma`；这里是把乐观锁 + 原子操作 + 事务用进真实业务。

详细讲解见 [Day 29 README](../../../days/day-29/)。

## Day 30 更新：OpenAPI 文档 + 封版 v1.0

阶段二里程碑。不加新业务，给整套 API 配一份可交互、跟代码走的文档：

- 接入 `@nestjs/swagger`：`main.ts` 装配 → `GET /docs`（Swagger UI）、`GET /docs-json`（OpenAPI spec）
- 所有请求 DTO 加 `@ApiProperty`；query DTO 自动渲染成查询参数；`UpdatePostDto` 改用 `@nestjs/swagger` 的 `PartialType`（保留 @ApiProperty 继承）
- `common/decorators/api-envelope.decorator.ts`：`@ApiEnvelope` / `@ApiErrorEnvelope`——用 `$ref` 把**统一响应外壳 + data 模型**拼出来，让文档如实反映 `TransformInterceptor` 包的那层
- `posts/dto/post-response.dto.ts`：文档专用响应模型（与领域 `Post` 接口分离）
- `debug/boom` 用 `@ApiExcludeEndpoint()` 从文档隐藏

详细讲解见 [Day 30 README](../../../days/day-30/)。

## Day 32 更新：JWT 认证（注册 / 登录）

阶段三第一刀落到 blog-api。新增 `auth` 模块，**只做认证、暂不保护 posts**（那是 Day 33 RBAC）：

- 新增 `users` + `refresh_tokens` 两张表（refresh 只存 sha256 哈希、可撤销）
- `POST /auth/register`：bcrypt 哈希密码（`bcryptjs`），唯一性预检 + P2002 兜底
- `POST /auth/login`：**防用户枚举**（统一错误 + 常量时间比对）
- **Access（短 JWT，无状态）+ Refresh（不透明随机、存哈希、可撤销、刷新即轮换）** 双 Token
- `JwtAuthGuard` + `@CurrentUser()` 保护 `GET /auth/me`；验签**固定算法**（防 alg 攻击）
- 配置加 `JWT_ACCESS_SECRET`（必填，缺了启动即崩）/ `JWT_ACCESS_TTL` / `REFRESH_TTL_DAYS`
- Swagger 加 `addBearerAuth()`，`/docs` 右上角可 Authorize

详细讲解见 [Day 32 README](../../../days/day-32/)。

## Day 33 更新：RBAC 授权

给 posts 加权限——这是 Day 32 留的尾（认证了但没保护资源）：

- `Post` 加可空 `authorId`（FK→User，删用户置空）；创建时作者=当前登录用户
- **写接口需登录**：`POST/PATCH/DELETE /posts` 加 `@UseGuards(JwtAuthGuard)`；**读接口保持公开**
- **资源级权限**：改/删要是**作者本人或 admin**（在 `PostsService.assertCanModify` 判，因为要先查出文章）
- **纯角色 RBAC**：`@Roles('admin')` + `RolesGuard`（Reflector 读元数据）；示例端点 `GET /auth/users`（仅 admin）
- 一个跨模块 DI 坑：`@UseGuards` 在控制器所在模块实例化守卫 → `AuthModule` 必须 re-export `JwtModule`，否则启动报错

详细讲解见 [Day 33 README](../../../days/day-33/)。

## Day 34 更新：OAuth 2.0 / GitHub 第三方登录

在自建账号体系之外，再接一条"用 GitHub 登录"的路径——授权码模式（Authorization Code Flow）：

- 新增 `auth/oauth/`：`GithubOAuthProvider`（所有打 GitHub 的 HTTP 收在这一层）、`OAuthStateStore`（防 CSRF 的一次性 `state`）、`GithubCallbackDto`
- `GET /auth/github`：生成 `state` → **302 跳转** GitHub 授权页（`@Res()` 手动发，绕过统一 envelope）；没配 client id/secret → 503 `OAUTH_NOT_CONFIGURED`
- `GET /auth/github/callback`：校验 `state`（一次性消费）→ 后端拿 `code` + `client_secret` 换 token → 读 `/user` → **发我们自己的 JWT + refresh**
- **`client_secret` 只在后端**（`exchangeCodeForToken`）出现，绝不下发前端——这是授权码模式 vs 已弃用的隐式模式的安全核心
- `User.password` 改**可空**（纯第三方用户无密码）、新增 `githubId`（唯一，身份锚点）；`loginWithGithub` 三步绑定：按 `githubId` 命中 → 按已验证邮箱关联老账号 → 否则建号
- 配置加可选的 `GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL`（不配不影响启动，仅禁用 GitHub 登录）

详细讲解见 [Day 34 README](../../../days/day-34/)。

## Day 36 更新：Redis 缓存（Cache-Aside）

给读得最猛的接口加一层 Redis 缓存，把数据库挡在后面。**只接 Cache-Aside（旁路缓存）一种策略**——它是「缓存可随时消失」的：Redis 整个宕机，API 照常工作，只是退回直连数据库变慢一点。这条「优雅降级」是整个缓存层的设计主轴：

- 新增 `src/cache/`：`RedisService`（包 `ioredis`，每条命令 `try/catch`，出错当未命中、绝不抛 500；`error` 事件必须接否则进程崩；`maxRetriesPerRequest: 1` + `enableOfflineQueue: false` 快失败）+ 全局 `CacheModule`
- `PostsService` 的 `findOne` / `findAll` 走 Cache-Aside（查缓存 → miss 查库 → `SET EX` 回填）；`create` / `update` / `remove` 写后失效（单篇 `DEL` + 列表按前缀 `SCAN` 清）；`incrementView` 故意不失效（`viewCount` 容忍 TTL 内陈旧，换 `findOne` 的缓存不被浏览量刷废）
- **击穿守卫** `coalesce`：同一 key 的并发未命中共享一次 DB 查询（单进程内有效，多实例要换 Redis 分布式锁）
- **可观测**：`X-Cache: HIT|MISS|BYPASS` + `X-Cache-Key` 响应头。命中状态产生于单例 service、要写到每请求的响应头——用 `AsyncLocalStorage`（CLS）穿透（`src/common/request-context.ts` + 中间件 + `cache-header.interceptor.ts`）
- **不缓存** `search` / `feed`：高基数 + 强时效，缓存命中率趋近 0
- 配置加 `REDIS_URL`（默认 localhost，连不上不阻塞启动）+ `POST_CACHE_TTL` / `LIST_CACHE_TTL`；`solutions/blog/blog-db/docker-compose.yml` 加了 `redis` 服务（关持久化）
- 新增 `test/cache.e2e.test.ts`：命中 / 更新失效 / 删除失效 / 列表失效 / 负结果五组用例（Redis 没起则 skip）
- 新增 `test/api.e2e.test.ts`：端到端「接口联调」，把认证 / CRUD / 缓存 / 分页搜索 / 乐观锁 / RBAC / Token 轮换 / 优雅降级串成一条用户旅程逐段断言（含「停 Redis 仍 200 + X-Cache=BYPASS」的降级用例，无 docker 时自动 skip）

详细讲解见 [Day 36 README](../../../days/day-36/)。

## Day 37 更新：Redis 进阶（排行榜 + 分布式锁 + 缓存三坑）

在 Day 36 的缓存基础上，把「留到以后」的几件事兑现，并加两个 Redis 招牌用法：

- 新增 `src/cache/redis-lock.service.ts`：分布式锁（`SET NX EX` 抢锁 + Lua 脚本安全释放 + `withLock` 包装）。`RedisService` 补 `setNx` / `eval` / ZSET 命令（`zincrby`、`zrem`、`zrevrangeWithScores`）
- 新增 `src/posts/trending.service.ts`：Sorted Set 排行榜。浏览时 `ZINCRBY` 加分、删除时 `ZREM` 摘榜；新增 `GET /posts/trending`（ZSET 取 Top N，不可用时回退 DB `ORDER BY view_count`）；仓储加 `findTopByViewCount` 兜底
- 缓存三坑对策落到 `PostsService.findOne`：**击穿** = 进程内 `coalesce` + 跨进程分布式锁（带双重检查）；**穿透** = 负缓存（404 写短 TTL 哨兵）；**雪崩** = TTL 随机抖动（`jitteredTtl`）
- config 加 `CACHE_TTL_JITTER` / `NEGATIVE_CACHE_TTL` / `LOCK_TTL`
- 新增 `test/redis-advanced.e2e.test.ts`：排行榜排序 / DB 兜底 / 锁互斥+安全释放 / 负缓存

详细讲解见 [Day 37 README](../../../days/day-37/)。

## 涵盖今日产出

- [x] 目录按 `common / config / feature / health` 重组
- [x] `PostsRepository` 接口 + `InMemoryPostsRepository` 实现，Service 通过 `POSTS_REPOSITORY` token 注入
- [x] `@nestjs/config` 接入，启动时 zod 校验环境变量（缺/错变量首秒崩）
- [x] `CommonModule` 全局挂载 Filter / Interceptor / Pipe + Middleware
- [x] `requestId` 在响应头 / 响应体 / 日志三处一致
- [x] `/health` 端点 + `enableShutdownHooks`
- [x] `QueryPostDto` 支持分页 / 排序 / 关键字 / 状态过滤，`limit` 有上限（最大 100）
- [x] E2E + 单元测试全绿（Day 34：posts 33 + auth 16 + oauth 8 = 57 个 E2E，外加 41 个单元测试；e2e 用 `--test-concurrency=1` 串行跑）

## 目录结构

```
prisma/
├── schema.prisma                        # Post/PostRevision(D29) + User/RefreshToken(D32) + githubId(D34)
├── migrations/                          # 历次建表/改表 SQL（append-only，提交到版本库）
└── sql/001_search_indexes.sql           # Day 28：FTS / trigram 索引（手动应用，见下）
src/
├── main.ts                              # 只做装配：bootstrap / CORS / shutdown
├── app.module.ts                        # 装配 Config / Common / Health / Posts
├── prisma/                              # Day 27：数据库基础设施
│   ├── prisma.module.ts                 # @Global，导出 PrismaService
│   └── prisma.service.ts                # extends PrismaClient + 生命周期钩子
├── common/                              # 横切关注点，不依赖任何 feature
│   ├── common.module.ts                 # @Global 注册 APP_PIPE / APP_INTERCEPTOR(×2) / APP_FILTER + middleware
│   ├── constants/error-codes.ts         # 错误码常量表
│   ├── decorators/
│   │   ├── request-id.decorator.ts
│   │   └── api-envelope.decorator.ts    # Day 30：@ApiEnvelope / @ApiErrorEnvelope（文档化响应外壳）
│   ├── exceptions/business.exception.ts
│   ├── filters/
│   │   ├── all-exceptions.filter.ts     # 全局兜底
│   │   └── business-exception.filter.ts # 控制器级，仅接 BusinessException
│   ├── interceptors/
│   │   ├── timing.interceptor.ts        # 慢请求探测（最外层）
│   │   └── transform.interceptor.ts     # 成功响应外壳（内层）
│   ├── middleware/
│   │   ├── request-id.middleware.ts     # x-request-id 注入
│   │   └── http-logger.middleware.ts    # 访问日志（排除 /health）
│   └── validators/is-slug.validator.ts
├── config/
│   ├── config.validation.ts             # zod env schema
│   └── configuration.ts                 # env → 强类型 AppConfig
├── health/
│   ├── health.module.ts
│   └── health.controller.ts             # GET /health
├── auth/                                # Day 32：认证
│   ├── auth.module.ts                   # JwtModule.registerAsync + 注入 ConfigService
│   ├── auth.controller.ts               # register/login/refresh/logout/me/users + github/callback(Day34)
│   ├── auth.service.ts                  # bcrypt + 防用户枚举 + 出口脱敏 + listUsers + loginWithGithub(Day34)
│   ├── tokens.service.ts                # access(JWT) + refresh(随机 / 存哈希 / 轮换)
│   ├── guards/jwt-auth.guard.ts         # 认证：校验 Bearer，挂 req.user
│   ├── guards/roles.guard.ts            # Day 33：纯角色 RBAC（Reflector 读 @Roles）
│   ├── decorators/current-user.decorator.ts
│   ├── decorators/roles.decorator.ts    # Day 33：@Roles('admin')
│   ├── oauth/                           # Day 34：OAuth / GitHub 登录
│   │   ├── github-oauth.provider.ts     # 打 GitHub 的 HTTP（换 token / 拉资料），唯一用 client_secret 处
│   │   ├── oauth-state.store.ts         # 防 CSRF 的一次性 state（内存版，生产用 Redis）
│   │   └── dto/github-callback.dto.ts   # 回调 query：code / state / ō;:>op21Aerror
ª│   └── dto/                             # register / login / refresh / auth-response
└── posts/
    ├── posts.module.ts                  # POSTS_REPOSITORY token → PrismaPostsRepository
    ├── posts.controller.ts              # /posts(offset) + /posts/feed(cursor) + /posts/search(FTS)
    ├── posts.service.ts                 # 业务规则：findAll / feed / search / CRUD
    ├── cursor.ts                        # Day 28：游标 encode/decode（base64url，不透明 token）
    ├── dto/
    │   ├── create-post.dto.ts
    │   ├── update-post.dto.ts           # PartialType(CreatePostDto)
    │   ├── query-post.dto.ts            # page/limit/sortBy/order/keyword/tag/status/cursor
    │   ├── search-post.dto.ts           # Day 28：全文搜索参数 q/page/limit/status
    │   ├── post-meta.dto.ts
    │   └── post-response.dto.ts         # Day 30：OpenAPI 响应模型（文档专用，与领域 Post 分离）
    ├── entities/post.entity.ts          # 领域实体 id: string (UUID v4)
    └── repositories/
        ├── posts.repository.ts          # interface + Symbol token（含 findByCursor/search）
        ├── in-memory-posts.repository.ts  # 内存实现（保留，可一行切回；含游标 + 朴素搜索）
        └── prisma-posts.repository.ts     # Prisma 实现：映射 + keyset 分页 + FTS($queryRaw)
```

## 运行

前置：`blog-db` 的 PostgreSQL 要先起来（Day 21）：

```bash
cd ../blog-db && docker compose up -d && cd -
```

然后：

```bash
pnpm install
cp .env.example .env                # 默认连 blog-db 的 PG，schema=blog_api

pnpm prisma:generate                # 从 schema.prisma 生成 Prisma Client
pnpm prisma:migrate                 # 建 blog_api schema + posts 表（首次需要）

pnpm start:dev                      # http://localhost:3000
#   API 文档：http://localhost:3000/docs（UI）  /docs-json（OpenAPI spec）
pnpm build                          # 输出到 dist/
```

### 测试（两层）

```bash
pnpm test:unit                      # 单元测试：mock 仓储，不连库，毫秒级
pnpm test:e2e                       # 集成测试：起真 PG，跑整条 HTTP→DB 链路
pnpm test                           # 两层都跑（需要 PG）
```

> ⚠️ `pnpm test:e2e` 会清空 `posts` / `users` / `refresh_tokens` 表。Day 33 起用 `--test-concurrency=1` **串行**跑——auth.e2e 和 posts.e2e 共用 `users` 表，并行会互相清掉对方的测试用户。请让 `DATABASE_URL` 指向一次性的库/schema（如 `blog_api_test`），**别指向有数据的库**。

## 接口列表

所有接口都返回统一外壳。成功 `{ code: 0, data, message: "ok", requestId, timestamp }`，失败 `{ code, data: null, message, errors?, category?, path, requestId, timestamp }`。

> 完整可交互文档见 `GET /docs`（Swagger UI），原始 OpenAPI spec 见 `GET /docs-json`。下表是速查。

| Method | Path | 说明 | 成功状态码 |
|--------|------|------|-----------|
| POST   | `/auth/register` | 注册（bcrypt + 返回双 Token） | 201 |
| POST   | `/auth/login` | 登录 | 200 |
| POST   | `/auth/refresh` | 用 refresh 换新 access（轮换） | 200 |
| POST   | `/auth/logout` | 登出（作废 refresh） | 200 |
| GET    | `/auth/me` | 当前用户（需 Bearer access token） | 200 |
| GET    | `/auth/users` | 列出所有用户（**仅 admin**） | 200 |
| GET    | `/auth/github` | 发起 GitHub 登录（**302** 跳授权页） | 302 |
| GET    | `/auth/github/callback` | GitHub 回调（校验 state → 发本系统 Token） | 200 |
| GET    | `/health` | 健康检查（不进访问日志） | 200 |
| GET    | `/posts` | 列表 + offset 分页 + 过滤 | 200 |
| GET    | `/posts/feed` | 列表 + cursor 分页（信息流） | 200 |
| GET    | `/posts/search` | 全文搜索（相关度排序） | 200 |
| GET    | `/posts/:id` | 按 UUID 查单条 | 200 |
| GET    | `/posts/:id/revisions` | 修订历史（新 → 旧） | 200 |
| POST   | `/posts` | 创建文章（**需登录**，作者=当前用户） | 201 |
| POST   | `/posts/:id/view` | 浏览计数 +1（公开） | 200 |
| PATCH  | `/posts/:id` | 局部更新（**需登录 + 作者本人或 admin**） | 200 |
| DELETE | `/posts/:id` | 删除（**需登录 + 作者本人或 admin**） | 200 |
| GET    | `/posts/debug/boom` | 故意抛 `Error`，验证 500 脱敏 | 500 |

### `GET /posts` 查询参数

| 参数 | 类型 | 默认 | 限制 |
|------|------|------|------|
| `page` | int | 1 | ≥ 1 |
| `limit` | int | 20 | 1–100 |
| `sortBy` | enum | `createdAt` | `createdAt` / `updatedAt` / `title` |
| `order` | enum | `desc` | `asc` / `desc` |
| `keyword` | string | — | 长度 ≤ 100，匹配 `title` / `content`（不区分大小写，ILIKE） |
| `tag` | string | — | 精确匹配 |
| `status` | enum | — | `draft` / `published` / `archived` |

### `GET /posts/feed` 查询参数（cursor 分页）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `limit` | int | 20 | 1–100，每页条数 |
| `cursor` | string | — | 上一页返回的 `nextCursor`；第一页不传 |
| `sortBy` | enum | `createdAt` | `createdAt` / `updatedAt` / `title` |
| `order` | enum | `desc` | `asc` / `desc` |
| `keyword` / `tag` / `status` | — | — | 同 `/posts` |

响应 `data` 形如 `{ items, pageInfo: { nextCursor, hasMore, limit } }`（注意是 `pageInfo` 不是 `pagination`）。`nextCursor` 为 `null` 表示到底了。非法 `cursor` → 400 `VALIDATION_ERROR`。

### `GET /posts/search` 查询参数（全文搜索）

| 参数 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `q` | string | **必填** | 搜索词，1–100，按 `websearch_to_tsquery` 解析 |
| `page` | int | 1 | ≥ 1 |
| `limit` | int | 20 | 1–100 |
| `status` | enum | — | `draft` / `published` / `archived` |

按 `ts_rank` 相关度降序返回。响应 `data` 形如 `{ items, pagination: { page, limit, total } }`。`q` 缺失 → 400。

### `POST /posts` 请求体

```jsonc
{
  "title": "Hello Day 20",                    // 必填，1-100
  "slug": "hello-day-20",                     // 必填，小写字母/数字/连字符，最长 80
  "content": "a long enough content body",    // 必填，≥ 10
  "tags": ["nestjs"],                         // 可选，最多 10 项，每项 1-20
  "status": "draft",                          // 必填，枚举
  "meta": {                                   // 可选嵌套对象
    "seoTitle": "Day 20 milestone",
    "seoDescription": "整合 Day 16-19..."
  }
}
```

未声明的字段（如 `isAdmin: true`）会被 `forbidNonWhitelisted` 直接拒绝。

## 错误码表

| code | HTTP | 含义 | 触发条件 |
|------|------|------|----------|
| `VALIDATION_ERROR` | 400 | 参数校验失败 | DTO 校验未通过 / 非法 query / 非法 UUID |
| `POST_NOT_FOUND` | 404 | 文章不存在 | `id` 查不到 |
| `SLUG_TAKEN` | 409 | slug 已被占用 | 创建或更新 slug 时撞名 |
| `POST_ARCHIVED` | 409 | 文章已归档 | 对 `status: archived` 的文章发起 `PATCH` |
| `VERSION_CONFLICT` | 409 | 版本冲突（乐观锁） | `PATCH` 带的 `version` 与当前不一致（被并发修改） |
| `EMAIL_TAKEN` | 409 | 邮箱已注册 | 注册时邮箱重复 |
| `USERNAME_TAKEN` | 409 | 用户名已占用 | 注册时用户名重复 |
| `INVALID_CREDENTIALS` | 401 | 邮箱或密码错误 | 登录失败（不区分邮箱是否存在）|
| `INVALID_REFRESH_TOKEN` | 401 | refresh 无效/过期 | 刷新时 refresh 不存在/已撤销/已过期 |
| `UNAUTHORIZED` | 401 | 未认证 | 受保护接口缺少/无效的 access token |
| `FORBIDDEN` | 403 | 无权限 | 改/删非自己的文章（非 admin）；访问 admin-only 接口 |
| `OAUTH_STATE_INVALID` | 401 | state 无效 | GitHub 回调 `state` 缺失/伪造/已用过（防 CSRF/重放）|
| `OAUTH_FAILED` | 401 | OAuth 失败 | 用户拒绝授权，或换 token / 拉资料失败 |
| `OAUTH_NOT_CONFIGURED` | 503 | 未配置 OAuth | 未设 `GITHUB_CLIENT_ID/SECRET` 就访问 `/auth/github` |
| `INTERNAL_ERROR`（占位） | 500 | 服务端错误 | 任何未捕获异常，响应固定文案 `服务器内部错误` |

> 业务错误（`POST_NOT_FOUND` / `SLUG_TAKEN` / `POST_ARCHIVED`）走控制器级 `BusinessExceptionFilter`，响应多一个 `category: 'business'` 字段，便于前端按维度统计。

## 手动验证（验收清单）

```bash
# 1) 启动失败保护（zod env 校验）
PORT=abc pnpm start
# stderr: 环境变量校验失败：PORT: Expected number, ...

# 2) 健康检查不进日志
curl http://localhost:3000/health
# 日志里看不到这条请求

# 3) 请求 ID 三处一致
curl -i http://localhost:3000/posts | grep -i x-request-id
# 响应头有 x-request-id；响应体 json.requestId 一致；日志能搜到

# 4) 上游 requestId 被尊重
curl -s -H 'x-request-id: trace-001' http://localhost:3000/posts | jq .requestId
# → "trace-001"

# 5) 校验错误结构化
curl -s -X POST http://localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"x"}' | jq
# code = "VALIDATION_ERROR"，errors 是 [{ field, messages }] 数组

# 6) 多余字段被拒
curl -s -X POST http://localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"a","slug":"a","content":"long enough","status":"draft","isAdmin":true}'
# 400 + VALIDATION_ERROR

# 7) 创建并查询
curl -s -X POST http://localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"NestJS guide","slug":"nestjs-guide","content":"long enough content","status":"published"}' \
  | jq .data.id
# → UUID v4

curl -s 'http://localhost:3000/posts?keyword=nest&sortBy=title&order=asc&limit=10' | jq

# 8) slug 撞名
curl -s -X POST http://localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"dup","slug":"nestjs-guide","content":"long enough content","status":"draft"}' | jq
# 409 + code: "SLUG_TAKEN" + category: "business"

# 9) 500 脱敏（响应不含 "boom!" 字样）
curl -i http://localhost:3000/posts/debug/boom
# message: "服务器内部错误"，stack 只在服务端日志里

# 10) limit 上限
curl -i 'http://localhost:3000/posts?limit=99999'
# 400 + VALIDATION_ERROR

# 11) 游标分页：第一页 → 拿 nextCursor → 翻下一页（Day 28）
C=$(curl -s 'http://localhost:3000/posts/feed?limit=2&sortBy=title&order=asc' | jq -r '.data.pageInfo.nextCursor')
curl -s "http://localhost:3000/posts/feed?limit=2&sortBy=title&order=asc&cursor=$C" | jq '.data'

# 12) 全文搜索（Day 28）
curl -s 'http://localhost:3000/posts/search?q=nestjs' | jq '.data.items[].title'
```

> **可选：搜索索引**（数据量大才需要，教学数据不建也能跑）。表达式 / trigram 索引 Prisma schema 表达不了，独立用 psql 应用：
>
> ```bash
> psql "postgresql://blog:blog_dev_pwd@localhost:5432/blog" \
>   -c "SET search_path TO blog_api;" -f prisma/sql/001_search_indexes.sql
> ```

## 设计要点回顾

- **`POSTS_REPOSITORY` Symbol token**：Service 不直接依赖 `InMemoryPostsRepository`，Day 21 切换到 Prisma 时只改 `posts.module.ts` 一行 `useClass`。所有 Repository 方法都返回 `Promise`，调用方零改动。
- **UUID v4 主键**：测试隔离友好，跨表关联和分库都无痛。`ParseUUIDPipe({ version: '4' })` 把非法 ID 挡在 Service 之外。
- **`CommonModule` 用 `@Global` + `APP_*`**：所有横切组件能注入容器内任何 provider；`main.ts` 不再 `useGlobalPipes`，避免 ValidationPipe 跑两遍。
- **Interceptor 注册顺序 = 执行顺序**：`TimingInterceptor` 必须排在 `TransformInterceptor` 前面，才能测到真实总耗时。
- **`requestId` 中间件**：尊重上游传入的 `x-request-id`，否则生成 UUID；同时写入 `req.headers` 和响应头，被 Filter / Interceptor / Logger 三处共用。
- **`HttpLoggerMiddleware` 排除 `/health`**：探针高频，日志没价值；状态码维度 log/warn/error 分级，方便采集系统按 level 过滤。
- **错误码常量表 `ErrorCodes`**：拼错变量名会触发 TS 报错，比 grep 字符串安全得多。
- **`enableShutdownHooks`**：容器化部署的最低要求，否则 k8s 滚动更新会切断请求 + 泄漏连接。
- **zod env 校验**：缺/错环境变量在 `pnpm start` 第一秒就崩，而不是请求进来才崩。

## Day 27 兑现回顾

Day 20 当初的预期，Day 27 逐条对照：

1. ✅ 新建 `posts/repositories/prisma-posts.repository.ts implements PostsRepository`
2. ✅ `posts.module.ts` 的 `useClass: InMemoryPostsRepository` 改成 `useClass: PrismaPostsRepository`——只动这一行
3. ✅ Service / Controller / DTO / Filter **一行未改**，验收场景全部沿用

唯一"多出来"的工作不在抽象漏了，而在**两个本就不同的世界之间做映射**：领域实体的 `meta?: PostMeta`（具名对象）↔ DB 的 `JSONB`、`status` 联合类型 ↔ DB 的 `VARCHAR`。这部分逻辑全部收在 `PrismaPostsRepository` 一个文件里，正是 Repository 模式想要的效果。

详细讲解见 [Day 27 README](../../../days/day-27/)。
