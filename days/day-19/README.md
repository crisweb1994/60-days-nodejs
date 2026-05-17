# Day 19 — NestJS 异常处理与响应标准化

## 📋 今日目标

- 看清 NestJS 的异常分层：内置 `HttpException` 体系、未知异常、Node 原生错误
- 写出一个能"分而治之"的全局异常过滤器：业务错误正常返回、未知错误兜底脱敏
- 设计前后端契约友好的统一响应格式（成功 + 失败用一套外壳）
- 理解 Filter / Interceptor / Pipe 在错误路径上的协作边界，避免互相覆盖
- 给博客 API 接上业务错误码，让前端能"按 code 路由 UI"

## 📖 核心知识点

### 1. 为什么要专门做异常处理

很多人第一次写 Nest 接口都靠默认行为：抛 `NotFoundException` 框架自动返回 404，看起来一切都好。但项目稍微长大就会撞墙：

- Service 里 `throw new Error('xxx')` —— 前端拿到一坨 HTML 500 页面（默认 ExceptionHandler 返回的）
- 把数据库错误原样抛出 —— 把表名、SQL 漏给客户端
- 一会儿返回 `{ message: 'x' }`，一会儿返回 `{ error: 'x' }`，前端 try/catch 写得很难看
- 想加请求 ID、链路 ID、错误码 —— 没有统一入口

异常处理不是"出错兜个底"，而是 **服务端响应契约的另一半**。成功响应你认真设计了 schema，错误响应也该有同等的设计深度。

### 2. NestJS 异常的三层

```
                  ┌────────────────────────────────┐
   你抛的异常 ──→ │ ExceptionFilter（捕获 + 转响应）│ ──→ 客户端
                  └────────────────────────────────┘
                         ↑              ↑
                         │              │
                 业务/HTTP 异常      未知异常
                 HttpException     Error / 字符串 / 对象
                 NotFound / Conflict   数据库错、空指针、
                 BadRequest 等等       第三方包抛的怪东西
```

- **HttpException** 是 Nest 自带的语义化异常，构造时就带 `status`、`response`。属于"预期内的失败"，不需要打栈。
- **未知异常**指任何不是 `HttpException` 的东西。属于"我们写错了"，必须打栈、必须脱敏后再回给客户端。
- 中间还有一层 **Node 原生错误**（`TypeError`、第三方包抛的 `Error`），它们本质属于未知异常，但常常带可读 message，需要决定要不要透传。

把这三层混在一起处理，是异常代码最容易出 bug 的根源。

### 3. 内置 HttpException 速查

```typescript
import {
  BadRequestException,      // 400
  UnauthorizedException,    // 401
  ForbiddenException,       // 403
  NotFoundException,        // 404
  ConflictException,        // 409
  GoneException,            // 410
  PayloadTooLargeException, // 413
  UnsupportedMediaTypeException, // 415
  UnprocessableEntityException,  // 422
  InternalServerErrorException,  // 500
  BadGatewayException,      // 502
  ServiceUnavailableException,   // 503
  GatewayTimeoutException,  // 504
} from '@nestjs/common';
```

构造形态有两种：

```typescript
// 1) 字符串：response 就是这个字符串
throw new NotFoundException('Post not found');
// → { statusCode: 404, message: 'Post not found', error: 'Not Found' }

// 2) 对象：response 直接被使用，可以塞自定义字段
throw new ConflictException({
  code: 'SLUG_TAKEN',
  message: `slug "${slug}" already exists`,
  conflictField: 'slug',
});
```

`HttpException` 的内部存的就是这个 `response`，过滤器通过 `exception.getResponse()` 拿到。所以**自定义错误码体系不需要继承新的异常类**，给已有异常的 response 加 code 字段就够了。

### 4. ExceptionFilter 的本质

```typescript
interface ExceptionFilter<T = any> {
  catch(exception: T, host: ArgumentsHost): any;
}
```

就一个方法。`host` 是上下文容器，能切到 HTTP / WebSocket / RPC 不同协议，HTTP 下 `host.switchToHttp()` 拿到 `req` / `res` / `next`。

```typescript
@Catch()  // 不传 = 接所有异常
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    // ... 决定状态码、构造响应体、log
    res.status(status).json(body);
  }
}
```

`@Catch(HttpException)` 只接 `HttpException` 及其子类；`@Catch(NotFoundException, ConflictException)` 接多种。Nest 内部做的是 `exception instanceof <DecoratorArg>`，**继承关系生效**。

### 5. 作用域与匹配顺序

四种挂载方式，从外到内：

```typescript
// (a) 全局 —— useGlobalFilters（不进 DI 容器，filter 内部 inject 拿不到 provider）
app.useGlobalFilters(new AllExceptionsFilter());

// (b) 全局 + DI —— APP_FILTER provider（推荐，能注入 Logger / ConfigService）
@Module({
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})

// (c) 控制器级
@UseFilters(BusinessExceptionFilter)
@Controller('posts')

// (d) 方法级
@UseFilters(BusinessExceptionFilter)
@Post()
```

匹配规则：异常抛出后，Nest 从**最内层**向外找匹配的 filter，一旦 `@Catch()` 列表能匹配上就用它，**不会继续向外冒泡**。所以：

> 把"专门处理某类异常"的 filter 放在内层、把"兜底"的 `@Catch()` 放在外层（全局），就构成了 try/catch 链。

```
方法级 filter → 控制器级 filter → 全局 filter
   (精确)         (中等粗)         (兜底)
```

### 6. 一个合格的全局过滤器长什么样

```typescript
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // HttpException 的 response 可能是 string，也可能是对象
    const raw = isHttp ? exception.getResponse() : null;
    const payload =
      typeof raw === 'string' ? { message: raw } : (raw as Record<string, any>) ?? {};

    // 未知异常：打栈 + 脱敏
    if (!isHttp) {
      this.logger.error(
        `${req.method} ${req.url} → 500`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else if (status >= 500) {
      this.logger.error(`${req.method} ${req.url} → ${status}`, payload);
    }

    res.status(status).json({
      code: payload.code ?? status,                          // 业务码优先，回落到 HTTP 码
      message: payload.message ?? '服务器内部错误',
      errors: payload.errors,                                // 校验明细（来自 day-18）
      path: req.url,
      requestId: req.headers['x-request-id'] ?? undefined,
      timestamp: new Date().toISOString(),
    });
  }
}
```

几个细节：

- **永远不要把未知异常的 `message` 直接回给客户端**。Node 的 `error.message` 经常带文件路径、SQL 片段，是信息泄漏的常见来源。回固定文案 + log 详情。
- **500 也要 log，4xx 不需要**。`status >= 500` 是服务端责任，必须能在日志里复盘；4xx 是客户端责任，量大时刷日志没意义。
- **保留 `payload.code`**，让上层抛 `ConflictException({ code: 'SLUG_TAKEN' })` 时这个码能流到响应里。这是错误码体系的关键传导。

### 7. 统一响应格式：成功 + 失败用同一个外壳

前端最难受的是 **成功和失败的 JSON 结构完全不同**。一个好的契约长这样：

```jsonc
// 成功
{ "code": 0, "data": { ... }, "message": "ok", "requestId": "..." }

// 失败
{ "code": 40901, "data": null, "message": "slug already exists", "requestId": "..." }
```

`code === 0` 表示成功，非零表示业务失败。HTTP 状态码仍然语义化（404 / 409 / 500），但前端不靠它做主分支——它太粗。

成功侧用 **Interceptor** 包装：

```typescript
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
  intercept(ctx: ExecutionContext, next: CallHandler<T>) {
    const req = ctx.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      map((data) => ({
        code: 0,
        data,
        message: 'ok',
        requestId: req.headers['x-request-id'] as string | undefined,
        timestamp: new Date().toISOString(),
      })),
    );
  }
}
```

失败侧用 **Filter** 包装（即第 6 节）。两边字段对齐，前端一套类型就能用。

### 8. Filter 与 Interceptor 的边界

新人常踩的坑：把响应包装写进了 Interceptor，结果异常路径没经过 Interceptor，错误返回还是原生格式。

执行顺序（异常路径用粗体）：

```
Request →  Middleware → Guard → Interceptor(before)
                                     │
                                     ▼
                                   Pipe → Handler
                                     │
                          ┌──────────┴──────────┐
                          ▼                     ▼
                      正常返回              抛异常 ▲
                          │                     │
                  Interceptor(after)      ExceptionFilter
                          │                     │
                          ▼                     ▼
                       Response             Response
```

**抛异常那一刻，Interceptor 的 after 钩子就被跳过了**。所以错误响应的标准化责任在 Filter 上，不能指望 Interceptor。

唯一例外：你可以在 Interceptor 里 `catchError(rxjs)` 拦截 handler 的异常，但那样会和 Filter 职责重叠，不推荐。

### 9. 业务错误码体系

HTTP 状态码只能表达"哪类问题"，业务码用来表达"具体哪个问题"。常见做法是分段：

```
40001 → 通用参数错误
40101 → token 缺失
40102 → token 过期
40901 → 资源已存在（slug 撞了）
40902 → 状态不允许此操作（已归档不能再编辑）
50001 → 上游服务超时
```

落地有两种风格：

**(a) 字符串码**：`'SLUG_TAKEN'`、`'POST_ARCHIVED'`。可读性最好，前端用 enum 接住。

**(b) 数字码**：`40901`。运维侧好聚合统计，前端 if/else 略丑。

不管选哪种，把它**放在抛出点而不是 Filter**：

```typescript
// service 里
if (existing) {
  throw new ConflictException({ code: 'SLUG_TAKEN', message: `slug "${dto.slug}" already exists` });
}
```

Filter 不需要 if/else 一堆业务分支，它只负责把 `payload.code` 透传出去。新增业务码不需要改 Filter，这是关键。

### 10. 自定义业务异常（可选）

如果你不想每次都写 `throw new ConflictException({ code: '...', ... })`，可以封一层：

```typescript
export class BusinessException extends HttpException {
  constructor(
    public readonly bizCode: string,
    message: string,
    httpStatus: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ code: bizCode, message }, httpStatus);
  }
}

// 使用
throw new BusinessException('SLUG_TAKEN', 'slug 已存在', HttpStatus.CONFLICT);
```

不要为每种业务错误写一个子类（`SlugTakenException` / `PostArchivedException` ...）。类爆炸的代价比节省的几个字符大得多。一个 `BusinessException` + 一份码表就够。

### 11. 容易踩的坑

- **抛非 Error**：`throw 'something went wrong'` —— 字符串不是 Error，没有栈。Filter 里要 `exception instanceof Error` 兜一下。
- **异步异常**：在 `async` 函数里 `throw` 没问题，Nest 能接住；但你**手动 `setTimeout(() => throw ...)`** 抛的会逃出去成为 `uncaughtException`，进程崩溃。异步代码要么 await，要么显式上报。
- **循环引用**：`exception.getResponse()` 拿到的对象如果是某个 ORM 实体，可能含循环引用，`res.json()` 会爆。给响应体一个白名单字段拷贝，不要原样 dump。
- **Filter 里再抛异常**：会进入 Nest 的默认 ExceptionHandler，返回 500 + 默认页面。Filter 内部任何操作都要包 try/catch，至少保证能写出 fallback JSON。
- **全局 Filter 用 useGlobalFilters 注册但又 inject 依赖**：拿到 undefined。改用 `APP_FILTER` provider。
- **多个 Filter 顺序记反**：精确的放内层、兜底的放外层。Nest 是从内往外找匹配，一旦命中就停。
- **覆盖 ValidationPipe 的 exceptionFactory**：Day 18 用了结构化错误。Filter 里要保留 `payload.errors` 字段透传，不然校验明细丢了。

### 12. 与可观测性的衔接（铺垫 Day 20+）

异常处理是观测体系的入口。最少要做到：

- 给每个请求一个 `requestId`（中间件生成，写入 `req` 和响应头），Filter / Logger 都带上。
- 5xx 异常要能上报到 Sentry / Loki / 自建 collector，单纯 console.error 不够。
- 业务码维度的失败率监控比 HTTP 状态码维度有用得多——`40901` 飙升能立刻定位到 slug 冲突，`409` 飙升只知道"有冲突"。

这些 Day 20 之后会接上，今天先把入口（Filter）的字段留好。

---

## 💻 实践练习

### 练习 1：实现全局异常过滤器

基于 Day 18 的 `blog-api`：

1. 新建 `src/common/filters/all-exceptions.filter.ts`，按第 6 节实现
2. 用 `APP_FILTER` provider 注册到 `AppModule`（不要用 `useGlobalFilters`，方便后面加依赖注入）
3. 在 Controller 里加一个 `/posts/debug/boom` 路由，故意 `throw new Error('boom')`，确认：
   - 客户端收到 500 + 通用文案，**看不到 stack**
   - 服务端日志里有完整 stack

### 练习 2：统一响应外壳

1. 写 `TransformInterceptor`（第 7 节代码）并全局注册
2. 修改 Filter，让错误响应也符合 `{ code, data, message, requestId, timestamp }` 结构
3. 对比成功和失败的响应体，确保前端可以 `if (resp.code === 0)` 一把过

### 练习 3：业务错误码

1. 写 `BusinessException`（第 10 节）
2. 在 `PostsService.create` 里把 slug 冲突改成 `throw new BusinessException('SLUG_TAKEN', ...)`
3. 在 `update` 里加一条规则：`status === 'archived'` 时不允许修改，抛 `BusinessException('POST_ARCHIVED', ...)`
4. 用 curl 验证响应里 `code` 字段是字符串业务码

### 练习 4：观察 Filter 的作用域

1. 写一个专门处理 `BusinessException` 的 filter（控制器级 `@UseFilters()`）
2. 让它额外往响应里塞一个 `category: 'business'` 字段
3. 抛一个 `BusinessException`，确认走的是控制器级 filter
4. 抛一个 `Error`，确认走的是全局兜底 filter

---

## ✅ 今日产出

- [ ] 理解 HttpException / 未知异常 / 原生 Error 的处理差异
- [ ] 完成全局 `AllExceptionsFilter`，5xx 脱敏 + log，4xx 透传
- [ ] 用 Interceptor + Filter 完成成功 / 失败的统一响应外壳
- [ ] 跑通业务错误码：service 层抛、filter 层透传，前端按 code 路由
- [ ] 至少写一个专用 filter，验证作用域与匹配顺序

## 📚 延伸阅读

- [NestJS 官方文档 - Exception Filters](https://docs.nestjs.com/exception-filters)
- [NestJS 官方文档 - Interceptors](https://docs.nestjs.com/interceptors)
- [RFC 7807 - Problem Details for HTTP APIs](https://datatracker.ietf.org/doc/html/rfc7807)（标准化的错误响应格式参考）

---

[⬅️ Day 18](../day-18/) | [➡️ Day 20](../day-20/)
