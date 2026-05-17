# Day 19 Solution — Blog API 异常处理与响应外壳

在 Day 18 的基础上加入：全局异常过滤器、统一响应外壳、业务错误码、控制器级 filter 演示、`requestId` 中间件。

## 涵盖练习

- **练习 1**：`AllExceptionsFilter` 用 `APP_FILTER` provider 全局注册，`GET /posts/debug/boom` 验证脱敏
- **练习 2**：`TransformInterceptor` 包成功响应外壳，Filter 包失败响应外壳，字段对齐
- **练习 3**：`BusinessException` + `BizCode` 码表，`create` 抛 `SLUG_TAKEN`、`update` 抛 `POST_ARCHIVED`
- **练习 4**：`BusinessExceptionFilter` 通过 `@UseFilters()` 挂在 `PostsController`，仅接 `BusinessException`，响应里加 `category: 'business'` 区分；其他异常冒泡到全局 filter

## 关键文件

```
src/
├── main.ts                                           # ValidationPipe（含 day-18 的 exceptionFactory）
├── app.module.ts                                     # APP_FILTER / APP_INTERCEPTOR + RequestIdMiddleware
├── common/
│   ├── exceptions/business.exception.ts             # BusinessException + BizCode 码表
│   ├── filters/
│   │   ├── all-exceptions.filter.ts                 # 全局兜底
│   │   └── business-exception.filter.ts             # 控制器级，仅接 BusinessException
│   ├── interceptors/transform.interceptor.ts        # 成功响应外壳
│   └── middleware/request-id.middleware.ts          # x-request-id 注入
└── posts/                                           # service 抛 BusinessException、controller 加 boom
```

## 运行

```bash
pnpm install
pnpm start:dev   # http://localhost:3000
pnpm test        # 7 个端到端测试，全部异常路径覆盖
```

## 响应外壳对照

```jsonc
// 成功（Interceptor 产出）
{ "code": 0, "data": { ... }, "message": "ok", "requestId": "...", "timestamp": "..." }

// HttpException（全局 Filter）
{ "code": 404, "data": null, "message": "Post #9999 not found", "path": "/posts/9999", "requestId": "...", "timestamp": "..." }

// BusinessException（控制器级 Filter，多了 category）
{ "code": "SLUG_TAKEN", "data": null, "message": "slug \"x\" 已被占用", "category": "business", "requestId": "...", "timestamp": "..." }

// 未知异常（全局 Filter，message 固定脱敏）
{ "code": 500, "data": null, "message": "服务器内部错误", "path": "/posts/debug/boom", "requestId": "...", "timestamp": "..." }

// 校验失败（ValidationPipe → BadRequestException → 全局 Filter 透传 errors）
{ "code": "VALIDATION_ERROR", "data": null, "errors": [{ "field": "slug", "messages": ["..."] }], ... }
```

## 手动验证

```bash
# 1) 成功响应外壳
curl -s http://localhost:3000/posts | jq

# 2) 未知异常脱敏（看响应里没有 "boom!" 字样，但服务端日志有完整 stack）
curl -i http://localhost:3000/posts/debug/boom

# 3) BusinessException（先创建一个，再用同一个 slug 创建第二次）
curl -s -X POST http://localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"a","slug":"dup","content":"long enough content","status":"draft"}'
curl -s -X POST http://localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"b","slug":"dup","content":"long enough content","status":"draft"}' | jq
# code 是 "SLUG_TAKEN"，category 是 "business"

# 4) requestId 透传（自带 header）
curl -s -H 'x-request-id: trace-001' http://localhost:3000/posts | jq .requestId
# → "trace-001"
```

## 设计要点回顾

- **`APP_FILTER` 而不是 `useGlobalFilters`**：filter 内部要 inject Logger / ConfigService 时，只有走 DI 通道才能拿到。
- **错误响应外壳是 Filter 的责任**：抛异常那一刻 Interceptor 的 after 钩子被跳过，Interceptor 接不到。
- **业务码放在抛出点**：Filter 用 `payload.code ?? status`，新增业务码不需要改 Filter。
- **未知异常永远用固定文案**：`error.message` 可能带文件路径、SQL 片段，是信息泄漏入口。
- **控制器级 filter 优先**：Nest 从内层向外找匹配，命中即停。`BusinessExceptionFilter` 只接 `BusinessException`，其他类型自动冒泡到全局。
