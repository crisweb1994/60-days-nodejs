# Day 20 Solution — Blog API（无数据库版 · 里程碑）

Day 16–19 的知识点整合成一个能跑、能交接、能在 Day 21 切 PostgreSQL 时不返工的完整项目。

## 涵盖今日产出

- [x] 目录按 `common / config / feature / health` 重组
- [x] `PostsRepository` 接口 + `InMemoryPostsRepository` 实现，Service 通过 `POSTS_REPOSITORY` token 注入
- [x] `@nestjs/config` 接入，启动时 zod 校验环境变量（缺/错变量首秒崩）
- [x] `CommonModule` 全局挂载 Filter / Interceptor / Pipe + Middleware
- [x] `requestId` 在响应头 / 响应体 / 日志三处一致
- [x] `/health` 端点 + `enableShutdownHooks`
- [x] `QueryPostDto` 支持分页 / 排序 / 关键字 / 状态过滤，`limit` 有上限（最大 100）
- [x] E2E 覆盖 6 类验收场景 + 分页/查询/health/UUID 校验，共 12 个用例全绿

## 目录结构

```
src/
├── main.ts                              # 只做装配：bootstrap / CORS / shutdown
├── app.module.ts                        # 装配 Config / Common / Health / Posts
├── common/                              # 横切关注点，不依赖任何 feature
│   ├── common.module.ts                 # @Global 注册 APP_PIPE / APP_INTERCEPTOR(×2) / APP_FILTER + middleware
│   ├── constants/error-codes.ts         # 错误码常量表
│   ├── decorators/request-id.decorator.ts
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
└── posts/
    ├── posts.module.ts                  # POSTS_REPOSITORY token 绑定 InMemory 实现
    ├── posts.controller.ts              # 用 ParseUUIDPipe 校验路径参数
    ├── posts.service.ts                 # 业务规则，全部 async
    ├── dto/
    │   ├── create-post.dto.ts
    │   ├── update-post.dto.ts           # PartialType(CreatePostDto)
    │   ├── query-post.dto.ts            # page/limit/sortBy/order/keyword/tag/status
    │   └── post-meta.dto.ts
    ├── entities/post.entity.ts          # id: string (UUID v4)
    └── repositories/
        ├── posts.repository.ts          # interface + Symbol token
        └── in-memory-posts.repository.ts
```

## 运行

```bash
pnpm install
cp .env.example .env                # 按需修改

pnpm start:dev                      # http://localhost:3000
pnpm test                           # 12 个 E2E 用例
pnpm build                          # 输出到 dist/
```

## 接口列表

所有接口都返回统一外壳。成功 `{ code: 0, data, message: "ok", requestId, timestamp }`，失败 `{ code, data: null, message, errors?, category?, path, requestId, timestamp }`。

| Method | Path | 说明 | 成功状态码 |
|--------|------|------|-----------|
| GET    | `/health` | 健康检查（不进访问日志） | 200 |
| GET    | `/posts` | 列表 + 分页 + 过滤 | 200 |
| GET    | `/posts/:id` | 按 UUID 查单条 | 200 |
| POST   | `/posts` | 创建文章 | 201 |
| PATCH  | `/posts/:id` | 局部更新 | 200 |
| DELETE | `/posts/:id` | 删除 | 200 |
| GET    | `/posts/debug/boom` | 故意抛 `Error`，验证 500 脱敏 | 500 |

### `GET /posts` 查询参数

| 参数 | 类型 | 默认 | 限制 |
|------|------|------|------|
| `page` | int | 1 | ≥ 1 |
| `limit` | int | 20 | 1–100 |
| `sortBy` | enum | `createdAt` | `createdAt` / `updatedAt` / `title` |
| `order` | enum | `desc` | `asc` / `desc` |
| `keyword` | string | — | 长度 ≤ 100，匹配 `title` / `content`（不区分大小写） |
| `tag` | string | — | 精确匹配 |
| `status` | enum | — | `draft` / `published` / `archived` |

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
```

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

## 通向 Day 21

Day 21 接入 PostgreSQL 时，预期只需：

1. 新建 `posts/repositories/prisma-posts.repository.ts implements PostsRepository`
2. `posts.module.ts` 的 `{ provide: POSTS_REPOSITORY, useClass: InMemoryPostsRepository }` 改成 `useClass: PrismaPostsRepository`
3. 本目录下 12 个 E2E 用例**一行不改**重新跑，全绿

如果届时需要改 Service / Controller / DTO / Filter，那就是今天的抽象漏了。
