# Day 16 — NestJS 入门：架构与核心概念

## 📋 今日目标

- 理解 IoC（控制反转）和 DI（依赖注入）到底解决了什么问题
- 看懂装饰器在 NestJS 里到底做了什么，不再把它当魔法
- 拆清 Module / Controller / Service 三者的职责边界
- 用 NestJS CLI 创建并跑通第一个项目

---

## 📖 核心知识点

### 1. 思维转变：从「我管对象」到「容器管对象」

写前端时，依赖通常是「拉」的——需要谁，就 import 谁、`new` 一个或直接调用：

```ts
// 调用者主动获取依赖
import { fetchUsers } from './api';
const users = await fetchUsers();
```

服务端代码生命周期更长，依赖图更深，这种「随用随取」的方式很快会暴露问题：

- 想换一个实现？所有调用点都得改。
- 想写单测？得 hack `import` 或者用 `jest.mock` 这种侵入手段。
- 想共享一个昂贵对象（数据库连接、Redis 客户端）？得自己写单例。

NestJS 的做法是把控制权交出去。你只声明「我需要一个 PostsService」，至于这个对象什么时候构造、是不是复用、要不要换成 mock，全部交给框架的 IoC 容器：

```ts
@Injectable()
class PostsController {
  // 不 new、不 import 工厂，直接在参数里「声明」需要谁
  constructor(private readonly posts: PostsService) {}
}
```

两个术语的关系：

- **IoC（Inversion of Control，控制反转）** 是思想——对象的创建和组装权从业务代码里抽出来，交给框架。
- **DI（Dependency Injection）** 是 IoC 的一种具体实现——通过构造函数、setter 或属性把依赖「注射」进来。

NestJS 默认走构造函数注入，因为它能让依赖关系一眼看清，且天然支持 `readonly` 字段。

### 2. 装饰器：NestJS「魔法」的真相

NestJS 重度使用 TypeScript 装饰器。装饰器看着神秘，本质上就是一个函数，在类定义时执行一次：

```ts
function Injectable(): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata('injectable', true, target);
  };
}

@Injectable()
class PostsService {}

// 上面这两行等价于：
Injectable()(PostsService);
```

装饰器并不参与运行时调用，它只在类加载时往类身上写一些元数据。Nest 启动时遍历所有 `@Module` 注册过的类，读取这些元数据，构造出整张依赖图。

让这套机制能跑起来的关键开关在 `tsconfig.json`：

```json
{
  "experimentalDecorators": true,    // 启用装饰器语法
  "emitDecoratorMetadata": true      // 把参数类型作为元数据写进编译产物
}
```

`emitDecoratorMetadata` 配合运行时的 `reflect-metadata`，让 Nest 能「看见」构造函数参数的类型：

```ts
@Injectable()
class PostsController {
  constructor(private posts: PostsService) {}
}

// 编译后的元数据相当于：
// Reflect.getMetadata('design:paramtypes', PostsController) === [PostsService]
```

Nest 容器拿到这个类型列表，递归解析每个依赖，最后生成实例。

这就解释了几个新手会踩的坑：

- 注入参数**必须是 class**。TS 的 `interface` 在编译后会被擦除，运行时拿不到类型，Nest 报 `Cannot read properties of undefined`。
- 想注入字符串、配置对象、第三方实例？用 `@Inject('TOKEN')` 手动指定 token，绕开类型反射。
- 入口 `main.ts` 顶部经常看到的 `import 'reflect-metadata'`（Nest 已在内部 import 过），少了它装饰器元数据系统就跑不起来。

### 3. Module — 应用的「装配清单」

Module 自己不写业务逻辑，它的作用是声明：**这一组功能涉及哪些类、和外界的边界在哪**。

```ts
@Module({
  imports: [UsersModule],          // 我要用别的模块导出的 provider
  controllers: [PostsController],  // 我负责处理的 HTTP 端点
  providers: [PostsService],       // 我内部使用的可注入对象
  exports: [PostsService],         // 我同意把哪些 provider 暴露给导入我的模块
})
export class PostsModule {}
```

四个字段的语义需要分得很清楚：

| 字段 | 含义 | 边界 |
|------|------|------|
| `providers` | 注册到容器里、本模块可注入的东西 | 默认单例 |
| `controllers` | 特殊的 provider，会被额外扫描路由元数据 | 不能 export |
| `imports` | 「我依赖谁」 | 只能拿到对方 `exports` 出来的 |
| `exports` | 「我暴露什么」 | 不写就是私有 |

一个高频坑：在 `AppModule` 的 providers 里注册了某个 Service，然后另一个模块的 Controller 想用它——直接报 `Nest can't resolve dependencies`。原因是 provider 默认有模块边界，没 export 就出不去。

正确做法是把它放进一个共享模块（如 `SharedModule`），并 `exports` 出来，然后**每个用到它的模块都 `imports SharedModule`**。即使如此，最终的实例仍然是同一个——因为 provider 默认作用域是单例，Nest 全局保持一份。

### 4. Controller — 只做翻译，不做决策

Controller 的职责非常单一：把 HTTP 请求翻译成方法调用，把方法返回值翻译成 HTTP 响应。校验、计算、持久化都不该出现在这里。

```ts
@Controller('posts')
export class PostsController {
  constructor(private readonly posts: PostsService) {}

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.posts.findOne(id);   // 一行调用，没有分支
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreatePostDto) {
    return this.posts.create(dto);
  }
}
```

常用的参数装饰器：

| 装饰器 | 取自 | 典型用途 |
|--------|------|----------|
| `@Param('id')` | URL 路径 `/posts/:id` | 资源标识 |
| `@Query('page')` | URL 查询串 `?page=2` | 分页、筛选 |
| `@Body()` | 请求体 | 创建 / 更新数据 |
| `@Headers('x-trace-id')` | 请求头 | 追踪、鉴权 |
| `@Req()` / `@Res()` | 原始 Express/Fastify 对象 | 尽量少用 |

**关于 `@Res()` 的代价值得单独提一句**：一旦你用 `@Res()` 拿到原始响应对象并自己调 `res.send()`，Nest 默认会跳过返回值处理流程——你写的拦截器、序列化、异常过滤器对这个 handler 全部失效。除非真的要做流式响应或 SSE，否则始终用 `return`，让框架接管。

### 5. Service — 业务逻辑的家

`@Injectable()` 的全部作用就是把这个类登记到 IoC 容器：「我可以被注入」。除此之外它什么都不做。

```ts
@Injectable()
export class PostsService {
  private posts: Post[] = [];

  findOne(id: number) {
    const post = this.posts.find(p => p.id === id);
    if (!post) throw new NotFoundException(`Post #${id} 不存在`);
    return post;
  }
}
```

两个容易写错的细节：

**1）抛 Nest 内置异常，而不是 `throw new Error()`。**
`NotFoundException` 会被默认异常过滤器捕获，自动转成 `404 { statusCode: 404, message: '...' }`。如果你抛裸 Error，会变成 `500 Internal Server Error`，还会把内部错误信息泄露给客户端。

**2）Service 不该「知道」HTTP 的存在——但 HttpException 是约定的例外。**
看起来在 Service 里抛 `NotFoundException` 是违反分层的，实际上 Nest 的 HttpException 体系是约定俗成的「错误信号」：业务层抛信号，传输层翻译成 HTTP。真要洁癖到极致，可以在 Service 抛自定义 DomainError，在 Controller 或 Filter 里映射成 HttpException。小项目直接抛 HttpException 完全够用，等到要支持多协议（HTTP + gRPC + 队列）再分层也不迟。

### 6. Provider 作用域：默认单例，慎用 REQUEST

默认所有 provider 都是**单例**：应用启动时构造一次，所有依赖它的地方共享同一个实例。这正是大多数情况想要的——无状态服务、连接池、缓存客户端，都不需要每次请求新建。

```ts
@Injectable()                    // 等价于 { scope: Scope.DEFAULT }，单例
export class PostsService {}

@Injectable({ scope: Scope.REQUEST })   // 每个 HTTP 请求一个新实例
export class TenantContext {}

@Injectable({ scope: Scope.TRANSIENT }) // 每次注入都新建
export class RandomTokenGen {}
```

`REQUEST` 作用域的代价不小：**整条依赖链上凡是依赖它的，都会跟着变成请求作用域**。否则一个单例 Service 注入了一个请求作用域对象，单例就被污染了。框架为了避免这种污染，会把单例升级成请求作用域。这意味着：

- 之前一份的服务，变成每个请求都重建一份；
- 升级是传染性的，最后可能整张图都成了请求作用域。

能用 `AsyncLocalStorage` 解决的场景（追踪当前用户、租户、trace id），就别动作用域。

### 7. 请求生命周期速览

一个请求进入 Nest 后会经过这条流水线（Day 17 会逐个展开）：

```
HTTP Request
  ↓
[Middleware]          Express 风格的中间件
  ↓
[Guard]               鉴权 / 权限拦截
  ↓
[Interceptor (pre)]   日志、缓存读取、统一封装的「前半段」
  ↓
[Pipe]                参数转换 + 校验（DTO 在这里被检查）
  ↓
[Handler]             你的 Controller 方法
  ↓
[Interceptor (post)]  响应转换、统一封装的「后半段」
  ↓
[Exception Filter]    只在任何环节抛错时介入
  ↓
HTTP Response
```

Day 16 实际只用到了 Pipe（`ValidationPipe`、`ParseIntPipe`）和默认的 Exception Filter。其余四个组件留到 Day 17 详谈。

### 8. 三件套的协作

把上面的概念串起来，一次 `GET /posts/42` 请求是这么走的：

```
Request → Router 匹配到 PostsController.findOne
            ↓
       ParseIntPipe 把字符串 "42" 转成 number 42
            ↓
       PostsController.findOne(42) 被调用
            ↓
       它通过构造函数注入了 PostsService（容器已经在启动时备好了实例）
            ↓
       this.posts.findOne(42) 进入业务逻辑
            ↓
       找不到？抛 NotFoundException
            ↓
       默认 ExceptionFilter 把异常转成 404 JSON 响应
```

Module 决定「谁在场」，Controller 决定「怎么进来」，Service 决定「做什么」。三者各司其职，是 NestJS 可维护性的根基。

---

## 💻 实践练习

### 练习：创建博客文章模块

1. `npx -y @nestjs/cli new blog-api` 创建项目
2. `nest g resource posts` 一键生成 module / controller / service / dto
3. 实现完整 CRUD（内存数组即可，下一阶段换 PostgreSQL）
4. 用 curl 或 Thunder Client 跑通 5 个接口
5. 故意少传字段，确认 422 校验生效；故意请求不存在的 id，确认 404 由 `NotFoundException` 触发

参考实现见 [`solutions/blog-api/`](./solutions/blog-api)，里面是去掉冗余模板后的最小可用版本，包含全局 `ValidationPipe`、分页、`author/tag` 过滤。

---

## ⚠️ 常见误区

- **在 Controller 里写业务**：if/else 一多就是信号，挪到 Service。
- **`new SomeService()`**：手动 new 等于绕过容器，单例和测试替换都没了。
- **忘记 `exports`**：跨模块注入失败 90% 是这个原因。
- **用 interface 作为注入类型**：TS 接口运行时不存在，必须用 class 或 `@Inject('TOKEN')`。
- **为方便改成 `Scope.REQUEST`**：会传染整条依赖链，性能和心智负担都涨。
- **用 `@Res()` 后忘记 `return`**：Nest 一直等不到 handler 返回值，请求挂起到超时。

---

## ✅ 今日产出

- [ ] 用自己的话讲清 IoC / DI / 装饰器三者的关系
- [ ] 用 NestJS CLI 创建项目并跑通 `pnpm start:dev`
- [ ] 实现 Posts 模块的完整 CRUD
- [ ] 至少触发一次 `NotFoundException` 和一次 `ValidationPipe` 422，观察响应结构

## 📚 延伸阅读

- [NestJS 官方文档 - First Steps](https://docs.nestjs.com/first-steps)
- [NestJS 官方文档 - Controllers](https://docs.nestjs.com/controllers)
- [NestJS 官方文档 - Providers](https://docs.nestjs.com/providers)
- [NestJS 官方文档 - Modules](https://docs.nestjs.com/modules)
- [NestJS 官方文档 - Injection Scopes](https://docs.nestjs.com/fundamentals/injection-scopes)
- [TypeScript Handbook - Decorators](https://www.typescriptlang.org/docs/handbook/decorators.html)
- [reflect-metadata proposal](https://github.com/rbuckton/reflect-metadata)

---

[⬅️ Day 15 — 阶段一总结](../day-15/) | [➡️ Day 17 — NestJS 请求生命周期](../day-17/)
