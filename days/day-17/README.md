# Day 17 — NestJS 深入：请求生命周期

## 📋 今日目标

- 看懂 Middleware → Guard → Interceptor → Pipe → Handler → Filter 整条流水线
- 拆清楚每一层的职责边界，遇到需求知道该往哪一层放
- 自己写一个 Logger Middleware 和一个 Transform Interceptor
- 理解 `ExecutionContext` 解决了什么问题

---

## 📖 核心知识点

### 1. 完整执行顺序

一个请求从命中路由到响应返回，会按下面这个顺序走，**任何一层都可以让请求短路**：

```
HTTP Request
   │
   ▼
┌──────────────┐
│  Middleware  │   Express 风格函数，最早执行
└──────┬───────┘
       ▼
┌──────────────┐
│    Guard     │   返回 false / 抛异常 → 拒绝请求
└──────┬───────┘
       ▼
┌──────────────────┐
│ Interceptor pre  │   handler 调用前
└──────┬───────────┘
       ▼
┌──────────────┐
│     Pipe     │   参数转换 + 校验，失败抛 BadRequestException
└──────┬───────┘
       ▼
┌──────────────┐
│   Handler    │   Controller 方法
└──────┬───────┘
       ▼
┌──────────────────┐
│ Interceptor post │   handler 返回后，通过 RxJS pipe 包装响应
└──────┬───────────┘
       ▼
┌──────────────────┐
│ Exception Filter │   任何一层抛异常都会跳到这里
└──────┬───────────┘
       ▼
   HTTP Response
```

记不住顺序时，看一个口诀就够：「**中卫拦管器，控转管异**」（中间件 → 卫兵 → 拦截器 → 管道 → 控制器 → 拦截器 → 异常过滤器）。

需要特别注意三点：

- **Interceptor 包住 Pipe 和 Handler**，所以拦截器看到的「响应」其实是 handler 的返回值。
- **Filter 不在主流水线上**，它是「捕获兜底」，任何阶段抛异常都跳到它。
- **Middleware 在 Guard 之前**，但它拿不到当前匹配到的 Controller/Handler 元数据，这点经常被搞混。

### 2. Middleware — Express 风格的早期拦截

Middleware 是离平台（Express/Fastify）最近的一层，写法和 Express 完全一样。先把 import 备齐——这是新手最容易卡的一步：`NestMiddleware / Injectable` 来自 `@nestjs/common`，而 `Request / Response / NextFunction` 来自 `@types/express`（通过 `import ... from 'express'` 引入）。

```ts
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

// 函数式 middleware
export function logger(req: Request, res: Response, next: NextFunction) {
  console.log(`[${req.method}] ${req.originalUrl}`);
  next();
}

// 类式 middleware（推荐，可注入依赖）
@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  // 直接用 NestJS 内置 Logger，前缀自动带上类名，比 console.log 更可控
  private readonly logger = new Logger(LoggerMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    const start = Date.now();
    res.on('finish', () => {
      // originalUrl 而非 url：挂载子路由时 url 会被重写，originalUrl 才是完整请求路径
      this.logger.log(`${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - start}ms)`);
    });
    next();
  }
}
```

注册方式不是装饰器，而是在 Module 里实现 `NestModule.configure`，这里同样要把 `NestModule / MiddlewareConsumer / RequestMethod` 从 `@nestjs/common` 引进来：

```ts
import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';

@Module({ /* ... */ })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(LoggerMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');   // 对所有路由生效
  }
}
```

> **「类型名称对不上、是不是版本问题？」** 常有人在不同文章里看到 `use` 的参数写成 `req: any, res: any`，或是 `FastifyRequest / FastifyReply`，和这里的 `Request / Response / NextFunction` 对不上，怀疑是不是 NestJS 版本问题。其实不是——`@nestjs/common` 只提供 `NestMiddleware` 这个接口，**HTTP 相关类型完全由底层平台决定**：
> - **Express 平台**（Nest 默认）：`import { Request, Response, NextFunction } from 'express'`，类型来自 `@types/express`，Express 4 与 5 之间这几个类型稳定一致。
> - **Fastify 平台**：没有 `Request/Response/NextFunction`，要换成 `FastifyRequest / FastifyReply`，而且中间件写法也不同（走 Fastify 的 `addHook` 风格，没有 `implements NestMiddleware` 那一套）。
> - `NestMiddleware` 接口本身把参数声明成 `any`，显式标成 Express 类型只是为了拿到自动补全和类型检查，不是强制的。

**关键限制**：Middleware 跑的时候，Nest 还没决定要把请求交给哪个 handler，所以它**拿不到 `ExecutionContext`**——不知道当前是哪个 Controller 的哪个方法、上面有什么自定义装饰器。需要这些信息？用 Guard 或 Interceptor。

适合 Middleware 的活：

- 全局请求日志（不关心是哪个 handler）
- `helmet`、`cors`、`compression` 这种 Express 生态现成的中间件
- 请求体预处理（multipart 解析、签名校验）

不适合的：依赖路由元数据的逻辑、需要修改响应内容的逻辑、需要 RxJS 流控的逻辑。

### 3. Guard — 「能不能进」的看门人

Guard 只回答一个问题：**这个请求能不能继续？** 返回 true 放行，返回 false 自动 `403 Forbidden`，抛异常则按异常类型走。

```ts
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new UnauthorizedException('缺少 token');

    try {
      req.user = this.jwt.verify(token);
      return true;
    } catch {
      throw new UnauthorizedException('token 无效');
    }
  }
}

// 使用
@UseGuards(JwtAuthGuard)
@Controller('posts')
export class PostsController {}
```

Guard 和 Middleware 看起来都能拦请求，区别在于：

| | Middleware | Guard |
|---|---|---|
| 能拿到 `ExecutionContext` 吗 | ❌ | ✅ |
| 知道是哪个 Controller/Handler 吗 | ❌ | ✅ |
| 能读自定义装饰器（如 `@Roles()`）吗 | ❌ | ✅ |
| 跑的时间点 | 路由匹配之后、Guard 之前 | Pipe 之前 |
| 推荐用途 | 平台级处理 | 权限决策 |

**Roles 装饰器** 就是一个典型组合——用 `SetMetadata` 写元数据，Guard 用 `Reflector` 读：

```ts
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>('roles', [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!required) return true;        // 没标注 = 公开
    const { user } = ctx.switchToHttp().getRequest();
    return required.some(r => user.roles.includes(r));
  }
}

// 用法
@Roles('admin')
@Delete(':id')
remove(@Param('id') id: string) {}
```

### 4. Interceptor — 围绕 handler 的「环绕通知」

Interceptor 借鉴了 AOP（面向切面编程）里的「环绕通知」概念：你能在 handler 调用**前后**插逻辑，还能修改返回值，甚至直接终止调用。

```ts
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, { data: T }> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<{ data: T }> {
    const start = Date.now();
    return next.handle().pipe(
      map(data => ({ data, meta: { tookMs: Date.now() - start } })),
    );
  }
}
```

几个关键点：

- `next.handle()` 返回的是 `Observable`——这才是 Nest 内部传递「handler 结果」的形式。
- 在 `next.handle()` **之前**写的代码 = handler 调用前执行（用来记录开始时间、读缓存）。
- 在 `.pipe(...)` 里的操作 = handler 调用后执行（用来包装响应、记录耗时）。
- 想短路 handler？直接 `return of(cachedValue)`，`next.handle()` 不会被调用。

典型用途：

- **统一响应封装**：`{ data, code, message }` 这种格式不该写在每个 Controller 里。
- **响应缓存**：handler 调用前先查缓存，命中就不走业务。
- **超时控制**：`.pipe(timeout(5000))`，5 秒未完成抛 `RequestTimeoutException`。
- **审计日志**：记录调用者、参数、返回值、耗时。

**和 Middleware 的对比**：Middleware 能监听 `res.on('finish')` 也能做日志，但 Middleware 改不了响应体——`res.send()` 已经发出去了。Interceptor 是在响应**发送之前**操作 Observable，所以能改内容。

### 5. Pipe — 参数的「转换 + 校验」

Pipe 干两件事，可以只做一件：

- **transform**：把输入转成期望的类型（字符串 `"42"` → 数字 `42`）。
- **validate**：检查输入合不合法，不合法就抛 `BadRequestException`。

内置 Pipe 已经覆盖了 90% 场景：

| Pipe | 作用 |
|------|------|
| `ParseIntPipe` | string → number，失败抛 400 |
| `ParseFloatPipe` | string → float |
| `ParseBoolPipe` | `'true'/'false'` → boolean |
| `ParseUUIDPipe` | 校验是不是合法 UUID |
| `ParseArrayPipe` | 逗号分隔字符串 → 数组 |
| `ParseEnumPipe` | 校验值是否在枚举里 |
| `ValidationPipe` | 用 `class-validator` 装饰器校验 DTO |
| `DefaultValuePipe` | 给可选参数兜底默认值 |

```ts
// 参数级
@Get(':id')
findOne(@Param('id', ParseIntPipe) id: number) {}

// 给 ParseIntPipe 自定义异常状态码
@Get(':id')
findOne(
  @Param('id', new ParseIntPipe({ errorHttpStatusCode: 422 })) id: number,
) {}

// 默认值 + 转换组合
@Get()
list(
  @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
) {}

// 全局 ValidationPipe（main.ts）
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,            // 自动剥离 DTO 里没声明的字段
  forbidNonWhitelisted: true, // 多余字段直接报错
  transform: true,            // 让 @Type(() => Number) 生效
}));
```

`transform: true` 是个**特别关键的开关**：没开它，query 里的 `?page=2` 永远是字符串 `"2"`，DTO 上的 `@IsInt()` 校验会失败。开了之后 `class-transformer` 会先把字段转成目标类型再校验。Day 18 详谈。

### 6. Exception Filter — 异常的兜底翻译官

任何一层抛出的异常，最终都会跳到 Exception Filter。Nest 自带一个默认 filter，已经会把 `HttpException` 体系转成对应 HTTP 响应。绝大多数项目只在以下两种情况自己写 Filter：

1. **统一错误响应格式**——希望所有错误都返回 `{ code, message, traceId, timestamp }`。
2. **接管非 HttpException**——把 Prisma/TypeORM 的特定错误转成业务语义的 HTTP 错误。

```ts
@Catch()                       // 不传参 = 捕获所有
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = exception instanceof HttpException
      ? exception.getResponse()
      : '服务器内部错误';

    res.status(status).json({
      code: status,
      message,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}

// 注册
app.useGlobalFilters(new AllExceptionsFilter());
```

`@Catch()` 可以指定捕获哪类异常：`@Catch(HttpException)` 只接 HTTP，`@Catch(PrismaClientKnownRequestError)` 只接 Prisma。**Nest 会从最具体的 filter 开始匹配**，所以你可以写多个 filter 分别处理不同异常源，最后用 `@Catch()` 做兜底。

**一个反直觉的点**：filter 接管后，handler 后面的 Interceptor.post 不会执行。换句话说，如果你的统一响应封装写在 Interceptor 里，错误响应**不会**经过它——这正是为什么响应封装应该写在 Interceptor，错误封装应该写在 Filter，两者各管一半。

### 7. ExecutionContext — 跨层共享的上下文

Guard、Interceptor、Filter 都接收一个 `ExecutionContext` 参数，它是 `ArgumentsHost` 的增强版，能干这些事：

```ts
ctx.switchToHttp().getRequest();   // 拿 Express/Fastify Request
ctx.switchToHttp().getResponse();
ctx.switchToRpc().getData();       // 微服务模式
ctx.switchToWs().getClient();      // WebSocket 模式

ctx.getHandler();                  // 当前 handler 函数
ctx.getClass();                    // 当前 Controller 类
```

为什么要这套抽象？因为 NestJS 不止支持 HTTP——同一个 Guard/Interceptor 可能在 HTTP、WebSocket、RPC 三种场景都要用。`ExecutionContext` 提供了一个统一入口，让你按当前协议拿对应对象。如果你只做 HTTP，每次都写 `ctx.switchToHttp().getRequest()` 即可。

### 8. 在哪一层注册：四个粒度

Pipe / Guard / Interceptor / Filter 都支持四种注册粒度，从粗到细：

```ts
// 1. 全局（main.ts）
app.useGlobalPipes(new ValidationPipe());
app.useGlobalGuards(new JwtAuthGuard());
app.useGlobalInterceptors(new TransformInterceptor());
app.useGlobalFilters(new AllExceptionsFilter());

// 2. 全局但通过模块注册（可注入依赖）
@Module({
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }],
})
export class AppModule {}

// 3. Controller 级
@UseGuards(JwtAuthGuard)
@Controller('posts')
export class PostsController {}

// 4. 方法级
@UseGuards(AdminGuard)
@Delete(':id')
remove() {}
```

**选哪一种？**

- 跨整个应用都要用 → 全局，且通过 `APP_GUARD/APP_INTERCEPTOR/APP_FILTER` 注入版本（能依赖容器里的其他 provider）。
- 整个 Controller 都要 → Controller 级。
- 只有少数方法需要 → 方法级。

直接 `new XxxGuard()` 全局注册的写法**拿不到 DI 容器里的依赖**——这是新手做 JWT 鉴权时最常踩的坑：在 `main.ts` 里 `new JwtAuthGuard()` 时，构造函数注入的 `JwtService` 是 `undefined`，必须改用 `APP_GUARD` 写法。

---

## 💻 实践练习

### 练习 1：Logger Middleware

实现一个全局日志中间件：
- 记录 `method url status duration` 四个字段
- `/health` 路径不打日志
- 用 `res.on('finish')` 拿最终 status，不要在 next() 之前打日志

### 练习 2：Transform Interceptor

实现统一响应封装：
- 所有成功响应自动包成 `{ data, meta: { tookMs } }`
- 不破坏现有的错误响应（错误走 Exception Filter）

### 练习 3：Roles 装饰器 + Guard

实现一个简易角色系统：
- `@Roles('admin')` 标注到方法上
- `RolesGuard` 用 `Reflector` 读元数据
- 假设 `req.user.roles` 已经被前置的 AuthGuard 填好

完成后用 curl 验证：

```bash
# 未登录访问受保护接口 → 401
curl http://localhost:3000/posts -X DELETE

# 普通用户删管理员资源 → 403
curl -H "Authorization: Bearer USER_TOKEN" http://localhost:3000/posts/1 -X DELETE

# 管理员 → 200
curl -H "Authorization: Bearer ADMIN_TOKEN" http://localhost:3000/posts/1 -X DELETE
```

---

## ⚠️ 常见误区

- **想在 Middleware 里读自定义装饰器**：拿不到。改用 Guard 或 Interceptor。
- **在 `main.ts` 用 `new JwtAuthGuard()` 全局注册**：构造函数注入的依赖是 `undefined`。改用 `APP_GUARD` provider。
- **响应封装写在 Filter 里**：错误响应会被双重封装，且成功响应根本不经过 Filter。封装写 Interceptor，错误格式化写 Filter。
- **在 Interceptor 里 `throw new Error()`**：异常会被吞掉，因为 Interceptor 工作在 RxJS Observable 里。要么 `throw new HttpException(...)`，要么 `return throwError(() => new Error(...))`。
- **`ValidationPipe` 没开 `transform: true`**：query string 还是字符串，`@IsInt()` 永远过不了。
- **Filter 写得太具体，又没有兜底**：未匹配的异常会变成默认 500，且不走你的格式化。永远在最外层放一个 `@Catch()` 兜底。

---

## ✅ 今日产出

- [ ] 画出请求生命周期顺序图，能背下来六层名字
- [ ] 实现 LoggerMiddleware 并在 AppModule 配置生效
- [ ] 实现 TransformInterceptor 并全局注册
- [ ] 实现 Roles + RolesGuard 组合，并用 curl 验证三种场景
- [ ] 故意在 handler 抛一个非 HttpException，观察默认 filter 的行为，再写一个自定义 Filter 接管

---

## 📚 延伸阅读

- [NestJS - Middleware](https://docs.nestjs.com/middleware)
- [NestJS - Guards](https://docs.nestjs.com/guards)
- [NestJS - Interceptors](https://docs.nestjs.com/interceptors)
- [NestJS - Pipes](https://docs.nestjs.com/pipes)
- [NestJS - Exception Filters](https://docs.nestjs.com/exception-filters)
- [NestJS - Execution Context](https://docs.nestjs.com/fundamentals/execution-context)
- [RxJS 操作符速查](https://rxjs.dev/guide/operators)（Interceptor 用得上 `map / tap / catchError / timeout`）

---

[⬅️ Day 16 — NestJS 入门](../day-16/) | [➡️ Day 18 — 数据验证与 DTO](../day-18/)
