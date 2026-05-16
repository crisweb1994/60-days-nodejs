# Blog API — Day 17 请求生命周期实战

在 Day 16 的 CRUD 基础上加入完整流水线：**Middleware → Guard → Interceptor → Pipe → Handler → Filter**。

## 📂 目录结构

```
src/
├── main.ts                              # 全局 Pipe / Interceptor / Filter 注册
├── app.module.ts                        # configure() 挂 LoggerMiddleware + APP_GUARD
├── app.controller.ts                    # /, /health（@Public）
├── app.service.ts
├── common/
│   ├── middleware/
│   │   └── logger.middleware.ts         # 练习 1：请求日志
│   ├── interceptors/
│   │   └── transform.interceptor.ts     # 练习 2：统一响应包装
│   ├── filters/
│   │   └── all-exceptions.filter.ts     # 异常兜底
│   ├── guards/
│   │   ├── auth.guard.ts                # 假登录（读 x-user 头）
│   │   └── roles.guard.ts               # 练习 3：角色校验
│   └── decorators/
│       ├── public.decorator.ts          # @Public()
│       └── roles.decorator.ts           # @Roles('admin')
└── posts/
    ├── posts.module.ts
    ├── posts.controller.ts              # 应用 @Public / @Roles
    ├── posts.service.ts
    ├── entities/post.entity.ts
    └── dto/
        ├── create-post.dto.ts
        ├── update-post.dto.ts
        └── query-post.dto.ts
```

## 🚀 启动

```bash
cd days/day-17/solutions/blog-api
pnpm install
pnpm start:dev
```

启动后会看到类似日志：

```
[Nest] LOG [NestApplication] Nest application successfully started
🚀 Day 17 Blog API: http://localhost:3000
```

每次请求会被 `LoggerMiddleware` 打印一行：

```
[Nest] LOG [HTTP] GET /posts 200 312b 1.84ms - ::1 "curl/8.4.0"
```

## 🔐 鉴权约定（演示用）

真实项目里会解 JWT，这里偷个懒：直接读两个请求头来填充 `req.user`。

| 请求头 | 含义 |
|--------|------|
| `x-user` | 用户 id（必填，没填就 401） |
| `x-user-roles` | 逗号分隔的角色，例如 `admin,editor` |

打了 `@Public()` 的路由完全跳过鉴权。

## 🧪 端到端验证

### 验证 1：LoggerMiddleware

```bash
# 访问 / 和 /posts，终端能看到日志
curl http://localhost:3000/
curl http://localhost:3000/posts

# 健康检查被 exclude，不会有日志
curl http://localhost:3000/health
```

### 验证 2：TransformInterceptor 响应包装

```bash
curl -s http://localhost:3000/posts | jq .
```

输出（注意 `data` + `meta.tookMs` 结构）：

```json
{
  "data": {
    "data": [ { "id": 1, "title": "Hello NestJS Pipeline", ... } ],
    "pagination": { "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
  },
  "meta": {
    "tookMs": 2,
    "timestamp": "2026-05-11T..."
  }
}
```

> Service 返回里也叫 `data` 字段，所以外层会出现两层 `data`，这是预期的。要避免可以让 Service 直接返回数组。

### 验证 3：AuthGuard 拦截未登录

```bash
# 缺 x-user 头 → 401
curl -i -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"x","content":"x","author":"x"}'

# 期望响应（来自 AllExceptionsFilter 的统一格式）：
# HTTP/1.1 401 Unauthorized
# { "code": 401, "message": "未登录（缺少 x-user 请求头）", "path": "/posts", "timestamp": "..." }
```

### 验证 4：登录后可以创建

```bash
curl -s -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -H 'x-user: u1' \
  -d '{"title":"My Post","content":"hello","author":"u1"}' | jq .
```

### 验证 5：RolesGuard — 普通用户删不掉

```bash
# 普通用户尝试删除 → 403
curl -i -X DELETE http://localhost:3000/posts/1 \
  -H 'x-user: u1' \
  -H 'x-user-roles: editor'

# 期望：
# HTTP/1.1 403 Forbidden
# { "code": 403, "message": "需要以下角色之一: [admin]，当前: [editor]", ... }
```

### 验证 6：admin 可以删

```bash
curl -i -X DELETE http://localhost:3000/posts/1 \
  -H 'x-user: u1' \
  -H 'x-user-roles: admin'

# HTTP/1.1 200 OK
# { "data": { "deleted": true, "id": 1 }, "meta": { ... } }
```

### 验证 7：ValidationPipe 校验失败

```bash
# 缺 content/author → 400
curl -i -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -H 'x-user: u1' \
  -d '{"title":"only title"}'

# 多余字段被 forbidNonWhitelisted 拒绝
curl -i -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -H 'x-user: u1' \
  -d '{"title":"a","content":"b","author":"c","evil":"x"}'
```

### 验证 8：Filter 兜底未知异常

```bash
curl -i http://localhost:3000/posts/debug/boom

# Service 抛了普通 Error，AllExceptionsFilter 接住转成：
# HTTP/1.1 500
# { "code": 500, "message": "服务器内部错误", "path": "/posts/debug/boom", ... }
```

终端能看到错误栈日志，但响应里不会泄露细节——这是分级处理的目的。

## 💡 关键决策回顾

- **全局 Guard 用 `APP_GUARD` provider**，不用 `app.useGlobalGuards(new XxxGuard())`。后者拿不到 DI 容器里的 `Reflector`。
- **Guard 注册顺序**：`AuthGuard` 在前填充 `req.user`，`RolesGuard` 在后读取——Nest 按 providers 数组顺序执行。
- **响应封装放 Interceptor，错误格式化放 Filter**。Filter 接管后不会再经过 Interceptor，两者各管一半，互不打架。
- **`@Get('debug/boom')` 必须写在 `@Get(':id')` 之前**。路由按注册顺序匹配，否则 `'debug'` 会落到 `:id` 上被 `ParseIntPipe` 拦掉。
- **`@Public()` 用 `getAllAndOverride`**：先看 handler 再看 class，让方法级标注能覆盖类级标注。

## 🔜 下一步

Day 18 会用 `class-validator` 深入 DTO 设计：嵌套对象校验、自定义校验器、`@Transform` 数据清洗。
