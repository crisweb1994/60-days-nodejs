# Day 20 — 🏆 里程碑：NestJS 博客 API（无数据库版）

## 📋 今日目标

- 把 Day 16–19 的零散知识点拧成一个能跑、能演示、能交接的完整项目
- 用 **Repository 抽象** 把"内存存储"和"业务逻辑"切开，为 Day 21 换 PostgreSQL 留下接口
- 把 Middleware / Guard / Interceptor / Pipe / Filter 五层全部接齐，不再是孤立例子
- 引入 `@nestjs/config` 管理环境变量，告别硬编码端口和密钥
- 接上健康检查、优雅关闭、统一日志，让项目具备最小可上线形态
- 输出一份能直接给前端的 README（接口列表、错误码、curl 样例）

---

## 📖 核心知识点

### 1. 里程碑的意义：从"会写"到"能交付"

Day 16–19 每天都解决了一个孤立问题：装配（Module/DI）、流水线（生命周期）、校验（DTO）、错误（Filter）。这些知识点单独看都不复杂，但放到一个项目里就会暴露第二层问题：

- 多个 Filter / Interceptor 之间的执行顺序不直观
- DTO、Entity、Repository 三者的边界容易糊
- 全局 provider 和 feature 模块的 import 关系一旦写乱就解不开
- 内存数据怎么写才能"明天换数据库时不返工"

里程碑不是把代码堆起来，而是把这些**整合期才会暴露的设计问题**正面处理掉。判断今天有没有真正完成的标准只有一个：**Day 21 切换到 PostgreSQL 时，Controller / DTO / Filter / Interceptor 一行不用改**。

### 2. 推荐目录结构与分层意图

`nest g resource` 默认生成的扁平结构在三五个模块时还可以，再大就找不到东西。直接按职责分层：

```
src/
├── main.ts                       # 应用入口，只装配，不写业务
├── app.module.ts                 # 根模块，组装 feature + common + config
│
├── common/                       # 跨 feature 复用的横切关注点
│   ├── filters/
│   │   └── all-exceptions.filter.ts
│   ├── interceptors/
│   │   ├── transform.interceptor.ts
│   │   └── timing.interceptor.ts
│   ├── middleware/
│   │   ├── request-id.middleware.ts
│   │   └── http-logger.middleware.ts
│   ├── decorators/
│   │   ├── request-id.decorator.ts
│   │   └── roles.decorator.ts
│   ├── guards/
│   │   └── roles.guard.ts
│   ├── exceptions/
│   │   └── business.exception.ts
│   ├── constants/
│   │   └── error-codes.ts
│   └── common.module.ts          # 把上面这一堆按 APP_* 注册到全局
│
├── config/
│   ├── configuration.ts          # 把 env 映射成强类型对象
│   └── config.validation.ts      # 用 Joi/Zod 校验 env
│
├── posts/                        # feature 模块：文章
│   ├── posts.module.ts
│   ├── posts.controller.ts
│   ├── posts.service.ts
│   ├── dto/
│   │   ├── create-post.dto.ts
│   │   ├── update-post.dto.ts
│   │   └── query-post.dto.ts
│   ├── entities/
│   │   └── post.entity.ts
│   └── repositories/
│       ├── posts.repository.ts          # 抽象接口
│       └── in-memory-posts.repository.ts# 内存实现
│
└── health/
    └── health.controller.ts      # /health 端点
```

三条分层规则：

1. **`common/` 不依赖任何 feature**。它是"通用工具箱"，任何 feature 都能 import；反过来不行，否则就是循环依赖的开始。
2. **每个 feature 自成闭环**：dto / entity / repository / service / controller 五件套都在自己目录下。删除一个 feature 等于删除一个目录。
3. **`main.ts` 只做装配**：`NestFactory.create`、`useContainer`、`enableShutdownHooks`、`listen`。任何业务代码出现在 `main.ts` 都是异味。

### 3. Repository 抽象：今天的内存数组，明天的数据库

这是整个里程碑里**最值钱**的一个设计。直接在 Service 里维护 `private posts: Post[] = []` 看起来快 30 行代码，代价是 Day 21 换 Prisma 时 Service 要重写。

正确的做法是定义一个 token + 接口：

```typescript
// posts/repositories/posts.repository.ts
export const POSTS_REPOSITORY = Symbol('POSTS_REPOSITORY');

export interface PostsRepository {
  create(data: Omit<Post, 'id' | 'createdAt' | 'updatedAt'>): Promise<Post>;
  findById(id: string): Promise<Post | null>;
  findBySlug(slug: string): Promise<Post | null>;
  findMany(query: FindPostsQuery): Promise<{ items: Post[]; total: number }>;
  update(id: string, patch: Partial<Post>): Promise<Post | null>;
  remove(id: string): Promise<boolean>;
}
```

内存实现：

```typescript
// posts/repositories/in-memory-posts.repository.ts
@Injectable()
export class InMemoryPostsRepository implements PostsRepository {
  private readonly store = new Map<string, Post>();

  async create(data) {
    const post: Post = {
      id: randomUUID(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    };
    this.store.set(post.id, post);
    return post;
  }
  // ... 其余方法同样 async，返回 Promise
}
```

模块里绑定：

```typescript
// posts/posts.module.ts
@Module({
  controllers: [PostsController],
  providers: [
    PostsService,
    { provide: POSTS_REPOSITORY, useClass: InMemoryPostsRepository },
  ],
})
export class PostsModule {}
```

Service 通过 token 注入：

```typescript
@Injectable()
export class PostsService {
  constructor(
    @Inject(POSTS_REPOSITORY) private readonly repo: PostsRepository,
  ) {}
}
```

**关键的三个细节**：

- 接口方法**全部返回 Promise**，哪怕内存版同步就能拿到结果。Service 里 `await` 写好，Day 21 换实现时调用方零改动。
- ID 用 `randomUUID()` 而不是自增 number。数据库的主键策略也是 UUID 时迁移最顺，自增 ID 会在分布式 / 分库时回头来咬你。
- `findMany` 返回 `{ items, total }` 而不是裸数组。**分页接口的标准形态从第一天就定好**，后面无痛接 `LIMIT/OFFSET` 或 `cursor`。

### 4. ConfigModule：环境变量的"翻译层"

`process.env.PORT` 散落在代码里是项目长期变烂的起点之一。`@nestjs/config` 做的事情其实只有两件：加载 `.env` + 暴露一个可注入的 `ConfigService`。但要用对，需要再加两层：

**第一层：强类型 configuration 函数**

```typescript
// config/configuration.ts
export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  env: process.env.NODE_ENV ?? 'development',
  cors: {
    origin: process.env.CORS_ORIGIN?.split(',') ?? ['http://localhost:5173'],
  },
  pagination: {
    defaultLimit: parseInt(process.env.PAGE_LIMIT ?? '20', 10),
    maxLimit: 100,
  },
});

export type AppConfig = ReturnType<typeof configuration>;
```

注入时不用字符串 key：

```typescript
constructor(private readonly config: ConfigService<AppConfig, true>) {}
// this.config.get('port', { infer: true }) → number
```

**第二层：env 校验**

```typescript
// config/config.validation.ts
import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().regex(/^\d+$/).default('3000'),
  CORS_ORIGIN: z.string().optional(),
});
```

`ConfigModule.forRoot({ validate: env => envSchema.parse(env) })`。**启动失败比运行时失败便宜得多**，缺一个必填环境变量应该在 `pnpm start` 的第一秒就报错，而不是请求进来才崩。

### 5. CommonModule：把横切关注点装进容器

Day 17 / 19 学过两种全局注册方式：`app.useGlobalXxx()` 和 `APP_XXX` provider。**项目里统一用 provider 形式**，理由是它能注入容器里的依赖（Logger、ConfigService、Repository），且测试时可以方便替换。

```typescript
// common/common.module.ts
@Global()
@Module({
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_INTERCEPTOR, useClass: TimingInterceptor },
    { provide: APP_INTERCEPTOR, useClass: TransformInterceptor },
    { provide: APP_PIPE, useFactory: () => new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        exceptionFactory: (errors) => new BadRequestException({
          code: 'VALIDATION_ERROR',
          message: '请求参数校验失败',
          errors: errors.map(e => ({
            field: e.property,
            messages: Object.values(e.constraints ?? {}),
          })),
        }),
      }),
    },
  ],
  exports: [],
})
export class CommonModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestIdMiddleware, HttpLoggerMiddleware)
      .exclude({ path: 'health', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
```

两个非常关键的点：

- **`@Global()` 不是用来导出 service 的偷懒装饰器**。这里加它是因为下面的 `APP_*` provider 需要在整个应用里生效。普通 service 仍然应该走 `imports/exports` 显式声明。
- **Interceptor 的注册顺序就是执行顺序**。上面 `TimingInterceptor` 先，意味着它在最外层，能测到包括其他 Interceptor 在内的总耗时。`TransformInterceptor` 在内层，只包装真正的 handler 返回值。**记错这个顺序，统计的耗时会偏小**。

### 6. 请求 ID：贯穿日志、响应、异常的"线索"

可观测性的第一颗螺丝。中间件生成一次，所有后续环节都用同一个：

```typescript
// common/middleware/request-id.middleware.ts
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.headers['x-request-id'] = id;
    res.setHeader('x-request-id', id);
    next();
  }
}
```

- **优先用上游传下来的 ID**。微服务调用链里，网关或前一个服务已经生成了 ID，你只是接力者。
- **写回响应头**，前端报 bug 时可以一并提供，后端按 ID 查日志秒级定位。
- 在 Filter 和 Interceptor 里读 `req.headers['x-request-id']`，写入响应体的 `requestId` 字段。整条链路一个 ID 贯穿。

更进一步可以用 `AsyncLocalStorage` 让 Service 层不通过 `req` 也能拿到当前 requestId（Day 35 左右会接 Pino + ALS）。

### 7. 完整的请求路径：一次 POST /posts 走完所有环节

口头说"五层都接齐"没意义，盯着一次真实请求看才直观。`POST /posts` 带一个非法字段：

```
HTTP Request
   │  POST /posts  Body: { title: "x", evil: true }  Headers: { x-request-id: undefined }
   ▼
RequestIdMiddleware    → 生成 uuid，写入 req.headers / res header
   ▼
HttpLoggerMiddleware   → res.on('finish') 注册，准备记录最终状态
   ▼
(无 Guard，公开接口)
   ▼
TimingInterceptor.pre  → 记 start = Date.now()
   ▼
TransformInterceptor.pre → 透传
   ▼
ValidationPipe         → forbidNonWhitelisted 触发，evil 字段非法
                          抛 BadRequestException({ code: 'VALIDATION_ERROR', errors: [...] })
   ▼
                ┌──── 异常路径 ────┐
                ▼                  ▼
        Interceptor.post 跳过   AllExceptionsFilter
                                  │
                                  │  status = 400
                                  │  payload.code = 'VALIDATION_ERROR'
                                  │  写入 { code, data:null, message, errors, requestId, timestamp }
                                  ▼
                              res.status(400).json(...)
   ▼
HttpLoggerMiddleware → 'POST /posts 400 12ms reqId=...'
   ▼
HTTP Response
```

走完这条链能验证三件事：

1. `requestId` 同时出现在响应头、响应体、日志里 → **可观测性闭环**
2. 校验错误的 `code` 字段是 `'VALIDATION_ERROR'`，不是裸 `400` → **业务码体系生效**
3. `errors` 数组带字段名和原因 → **DTO 校验 + Filter 透传 + Interceptor 不干扰** 三方协作正确

如果有一项不对，就回到对应章节定位。这是里程碑天最该花时间反复跑的事，不是堆代码。

### 8. 查询接口的通用形态：分页 + 排序 + 过滤

CRUD 里 `findMany` 最容易写烂。每加一个过滤条件改一次 Service 签名，很快不可维护。一开始就把通用结构定好：

```typescript
// posts/dto/query-post.dto.ts
export class QueryPostDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 20;

  @IsOptional() @IsIn(['createdAt', 'updatedAt', 'title'])
  sortBy?: 'createdAt' | 'updatedAt' | 'title' = 'createdAt';

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';

  @IsOptional() @IsString() @MaxLength(100)
  keyword?: string;

  @IsOptional() @IsEnum(PostStatus)
  status?: PostStatus;

  @IsOptional() @IsString()
  tag?: string;
}
```

Repository 接受这个 DTO 直接落地：

```typescript
async findMany(query: QueryPostDto) {
  let items = Array.from(this.store.values());

  if (query.keyword) {
    const kw = query.keyword.toLowerCase();
    items = items.filter(p =>
      p.title.toLowerCase().includes(kw) ||
      p.content.toLowerCase().includes(kw),
    );
  }
  if (query.status) items = items.filter(p => p.status === query.status);
  if (query.tag) items = items.filter(p => p.tags?.includes(query.tag));

  items.sort((a, b) => {
    const dir = query.order === 'asc' ? 1 : -1;
    return a[query.sortBy] > b[query.sortBy] ? dir : -dir;
  });

  const total = items.length;
  const start = (query.page - 1) * query.limit;
  return { items: items.slice(start, start + query.limit), total };
}
```

为什么强调"形态"而不是"代码"：

- **`{ items, total }` 是契约**，前端用 `total` 算页码，缺一不可；返回 `Post[]` 会逼前端再调一次 `count`。
- **`limit` 必须有上限**（这里是 100）。没有上限的接口等同于给攻击者写了一个 DoS 入口：`?limit=10000000` 直接打爆内存。
- 排序字段必须**白名单校验**（`@IsIn`）。直接拼 `sortBy` 到未来的 SQL 里就是注入漏洞。

### 9. 健康检查与优雅关闭

`/health` 是部署、k8s 探针、负载均衡都要的最小接口：

```typescript
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
```

- **不要让 `/health` 经过鉴权中间件**——上面 `CommonModule` 已经把它从 logger 中排除，鉴权同理。
- 暂时不依赖数据库，所以不查 DB。接上 PostgreSQL 之后会加 `db: 'ok'` 字段（用 `@nestjs/terminus`）。
- **不要在 `/health` 里做任何耗时操作**，它会被高频探测。

优雅关闭对应的代码很短，影响很大：

```typescript
// main.ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();          // 让 Nest 监听 SIGTERM/SIGINT
await app.listen(port);
```

开启后，Service 实现 `OnApplicationShutdown` 就能在进程退出时收尾（关闭连接池、flush 日志缓冲）。**容器化部署如果不开这个，k8s 滚动更新时正在处理的请求会被一刀切断**，连接池里的连接也不会还给 PostgreSQL。

### 10. 错误码表：一份给前端看的文档

业务码不是 Filter 里的实现细节，它是**契约**，必须文档化。在 `common/constants/error-codes.ts` 里集中维护：

```typescript
export const ErrorCodes = {
  // 通用
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED:     'UNAUTHORIZED',
  FORBIDDEN:        'FORBIDDEN',
  NOT_FOUND:        'NOT_FOUND',
  INTERNAL_ERROR:   'INTERNAL_ERROR',

  // 文章
  POST_NOT_FOUND:   'POST_NOT_FOUND',
  SLUG_TAKEN:       'SLUG_TAKEN',
  POST_ARCHIVED:    'POST_ARCHIVED',
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
```

抛错时用这个常量而不是裸字符串：

```typescript
throw new BusinessException(ErrorCodes.SLUG_TAKEN, `slug "${slug}" already exists`, HttpStatus.CONFLICT);
```

**改名字时一处出错全项目报错**，比满世界找拼写错误的字符串安全得多。

README 里给前端列一张表：

| code | HTTP | 含义 | 触发条件 |
|------|------|------|----------|
| VALIDATION_ERROR | 400 | 参数校验失败 | DTO 校验未通过 |
| POST_NOT_FOUND | 404 | 文章不存在 | id 查不到 |
| SLUG_TAKEN | 409 | slug 已被占用 | 创建时 slug 重复 |
| POST_ARCHIVED | 409 | 文章已归档 | 对已归档文章发起编辑 |
| INTERNAL_ERROR | 500 | 服务端错误 | 任何未捕获异常 |

### 11. 测试策略：E2E 是里程碑的验收手段

单元测试覆盖 Service / Repository 的边界，**E2E 才能证明所有层装配正确**。Nest 的 `Test.createTestingModule` + supertest 已经够用：

```typescript
// test/posts.e2e.test.ts
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  await app.init();
});

it('POST /posts 422 时返回结构化错误', async () => {
  const res = await request(app.getHttpServer())
    .post('/posts')
    .send({ title: 'x' });          // 缺字段
  expect(res.status).toBe(400);
  expect(res.body.code).toBe('VALIDATION_ERROR');
  expect(res.body.errors).toBeInstanceOf(Array);
  expect(res.headers['x-request-id']).toBeDefined();
});
```

至少覆盖六个场景：

1. 正常创建 → 201 + `code: 0` + 完整 Post
2. 字段缺失 → 400 + `VALIDATION_ERROR`
3. 多余字段 → 400 + `VALIDATION_ERROR`
4. 重复 slug → 409 + `SLUG_TAKEN`
5. 不存在的 id → 404 + `POST_NOT_FOUND`
6. 故意 `throw new Error('boom')` → 500 + `INTERNAL_ERROR`，响应**不含 stack**

E2E 跑绿的那一刻，里程碑才算完成。**不要靠肉眼 curl 验**——明天一改东西就忘了上次确认过哪些场景。

### 12. 整合期最容易踩的坑

写单个章节时没事，今天把它们拼起来才会暴露：

- **`APP_INTERCEPTOR` 同时注册多个但顺序写反**：`TransformInterceptor` 排在 `TimingInterceptor` 前面，统计耗时拿到的是包装后的对象，不是 handler 真正的执行时间。
- **`ValidationPipe` 注册了两次**（`main.ts` 一次 + `APP_PIPE` 一次）：校验跑两遍，错误信息可能被覆盖。**全局组件只在一个地方注册**。
- **Repository 是单例，store 是 Map**：测试时不重置，case 之间数据互相污染。每个 `it` 前面 `beforeEach` 里清空，或者直接重新 `compile` 整个模块。
- **DTO 用 `interface` 而不是 `class`**：`whitelist` 失效，多余字段全部透传。Day 18 讲过的坑，整合时容易踩第二遍。
- **`enableShutdownHooks` 没开**：本地 Ctrl+C 看起来正常退出（因为没有需要清理的资源），到了容器里才发现连接泄漏。**今天就开**，不要等出问题再加。
- **CORS 配置成 `origin: '*'`**：开发期方便，上线前忘记改。`main.ts` 里读 `config.get('cors.origin')`，不同环境不同值。
- **把 `node_modules` 提交进 Git**：Day 19 的 solutions 已经踩过，注意 `.gitignore` 是从根目录生效的，子项目的 `.gitignore` 别漏。

### 13. 通往 Day 21 的桥

今天故意不接数据库，是因为**先把"非数据库"的部分做扎实，换实现时才能验证抽象是否成立**。如果你今天 Repository 接口设计得好，Day 21 只需要做三件事：

1. 写一个 `PrismaPostsRepository implements PostsRepository`
2. 在 `posts.module.ts` 里把 `useClass: InMemoryPostsRepository` 换成 `useClass: PrismaPostsRepository`
3. E2E 测试**一行不改**重新跑，全绿

如果发现需要改 Service 或 Controller，那就是今天的抽象没做到位，回头优化比积累技术债便宜得多。

---

## 💻 实践练习

### 主练习：把 Day 16–19 的代码重组成完整项目

不是重新写，是**重构 + 整合**。建议步骤：

1. **拷出 Day 19 的 `blog-api`** 到 `day-20/solutions/blog-api`，作为起点
2. 按第 2 节调整目录结构，把 `filters` / `interceptors` / `middleware` 全部归到 `common/`
3. 引入 `@nestjs/config`，把 `port` / `CORS` / `pagination` 配置外置，配 `.env.example`
4. 抽出 `PostsRepository` 接口和 `InMemoryPostsRepository` 实现，Service 改为通过 token 注入
5. 实现 `CommonModule`，把 Filter / Interceptor / Pipe / Middleware 全部按第 5 节方式注册
6. 加 `RequestIdMiddleware`，确保响应头、响应体、日志三处都有 `requestId`
7. 实现 `/health` 接口，开启 `app.enableShutdownHooks()`
8. 完善 `QueryPostDto`（分页 + 排序 + 关键字 + status 过滤），Repository 适配
9. 写 E2E 测试，覆盖第 11 节列的六个场景
10. 在 `solutions/blog-api/README.md` 里给前端列接口表 + 错误码表 + curl 样例

### 验收清单（自测）

跑一遍下面这些命令，全部符合预期才算过关：

```bash
# 1. 启动失败保护
PORT=abc pnpm start       # 应在第一秒报 env 校验错误

# 2. 健康检查不进日志
curl http://localhost:3000/health
# 日志里看不到这条请求

# 3. 请求 ID 贯穿
curl -i http://localhost:3000/posts
# 响应头有 x-request-id；响应体有 requestId；日志能搜到

# 4. 校验错误结构化
curl -X POST http://localhost:3000/posts -H 'Content-Type: application/json' -d '{"title":"x"}'
# 返回 { code: 'VALIDATION_ERROR', errors: [{ field, messages }] }

# 5. 500 错误脱敏
curl http://localhost:3000/posts/debug/boom
# 客户端只看到通用文案，服务端日志有完整 stack

# 6. 分页边界
curl 'http://localhost:3000/posts?limit=99999'
# 应被 ValidationPipe 拒绝（Max(100)）
```

---

## ⚠️ 常见误区

- **以为"能跑"就是完成**：里程碑的标准不是"功能对"，而是"Day 21 换数据库不返工"。这两者的代码距离可能差三倍。
- **`common/` 里 import 了 feature 模块**：意味着 `common` 不再通用，下一次新增 feature 时这层抽象就会破。
- **每个 feature 都自己写一遍 logger / filter**：横切关注点的全部意义就是只写一次。出现重复就是设计漏了。
- **Repository 接口里出现 SQL 概念**（`whereClause`、`orderBy` 数组）：抽象漏了。接口应该说的是业务语言（`findBySlug`、`findPublished`），不是 ORM 语言。
- **`.env` 文件提交进 Git**：经典灾难。`.env` 永远 ignore，`.env.example` 永远提交。
- **E2E 不重置 Repository**：跑顺序敏感的 case 时翻车。最简单的办法：每个测试文件单独 `Test.createTestingModule`。

---

## ✅ 今日产出

- [ ] 项目目录按 `common / config / feature / health` 重组完成
- [ ] `PostsRepository` 接口 + `InMemoryPostsRepository` 实现，Service 通过 token 注入
- [ ] `@nestjs/config` 接入，启动时校验环境变量
- [ ] `CommonModule` 全局挂载 Filter / Interceptor / Pipe + Middleware
- [ ] `requestId` 在响应头 / 响应体 / 日志三处一致
- [ ] `/health` 端点 + `enableShutdownHooks`
- [ ] `QueryPostDto` 支持分页 / 排序 / 关键字 / 状态过滤，`limit` 有上限
- [ ] E2E 覆盖第 11 节六个场景，全部绿
- [ ] `solutions/blog-api/README.md` 含接口表 + 错误码表 + curl 样例
- [ ] 代码提交到 GitHub，commit message 写明"day 20 milestone"

---

## 📚 延伸阅读

- [NestJS 官方文档 - Configuration](https://docs.nestjs.com/techniques/configuration)
- [NestJS 官方文档 - Lifecycle Events](https://docs.nestjs.com/fundamentals/lifecycle-events)
- [NestJS 官方文档 - Testing](https://docs.nestjs.com/fundamentals/testing)
- [NestJS 官方文档 - Custom providers (Symbol token)](https://docs.nestjs.com/fundamentals/custom-providers)
- [The Twelve-Factor App - Config](https://12factor.net/config)（环境变量管理的经典阐述）
- [Repository Pattern by Martin Fowler](https://martinfowler.com/eaaCatalog/repository.html)

---

[⬅️ Day 19](../day-19/) | [➡️ Day 21](../day-21/)
