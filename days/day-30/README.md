# Day 30 — 🏆 里程碑：博客系统 API 完整版

## 📋 今日目标

- 给 blog-api 装上 **Swagger / OpenAPI** 文档，`/docs` 一打开就是可交互的 API 手册
- 攻克一个真实难点：**统一响应外壳怎么如实写进文档**（返回类型 ≠ 实际 JSON）
- 学会用 `@ApiProperty` 文档化 DTO、用 `@nestjs/swagger` 的 `PartialType` 让文档可继承
- 分清**文档模型**和**领域模型**，把"线上 JSON 长什么样"和"业务对象"解耦
- 阶段二收尾：回顾 Day 16–30 把内存版 API 一路打磨成生产形态的全过程，做质量验收

> 配套代码：`solutions/blog/blog-api/`。Day 30 新增 `@nestjs/swagger`、`api-envelope.decorator.ts`、
> `post-response.dto.ts`，给所有 DTO / 路由加注解，`/docs` 提供完整可交互文档。

---

## 📖 核心知识点

### 1. 阶段二回顾：内存版 → 生产形态

这是阶段二（Day 16–30）的里程碑。回头看 blog-api 这一路长出了什么：

| 阶段 | 加了什么 |
|------|---------|
| Day 16–20 | NestJS 骨架：Module/Controller/Service、DTO 校验、统一响应外壳、异常过滤、Repository 抽象（内存实现）|
| Day 27 | 接入 **Prisma + PostgreSQL**，`useClass` 一行从内存切到 DB |
| Day 28 | **offset / cursor 分页 + 全文搜索 + 动态排序** |
| Day 29 | **事务与并发控制**：乐观锁、原子计数、修订历史 |
| **Day 30** | **OpenAPI 文档 + 质量验收**，封版 v1.0 |

今天不加新业务功能，而是给这套 API 配一份**能交接、能联调、能生成客户端**的文档——这正是"完整版"和"能跑就行"的区别。

### 2. 为什么是 OpenAPI，而不是手写一个 Markdown

手写 API 文档的问题众所周知：**会过期**。代码改了文档忘了改，比没有文档更坑。

**OpenAPI**（前身 Swagger）是一份**机器可读的 API 规范**（JSON/YAML）。它的价值在于：

- **从代码生成**，跟着代码走，不易过期（本项目就是从 DTO / 控制器的装饰器生成）
- **可交互**：Swagger UI 直接在浏览器里发请求试接口（`/docs`）
- **可派生**：拿这份 spec 能生成**前端 TS 客户端**、**Mock 服务**、**契约测试**、**Postman 集合**

`@nestjs/swagger` 做的就是：扫描你的控制器和 DTO 上的装饰器 + 类型，**生成 OpenAPI 文档**，再用 Swagger UI 渲染。

### 3. 装配：DocumentBuilder + SwaggerModule

`main.ts` 里三步（装配代码只该在 main.ts，别散到业务里）：

```typescript
const swaggerConfig = new DocumentBuilder()
  .setTitle('Blog API')
  .setDescription('… 统一响应外壳说明 …')
  .setVersion('1.0')
  .addTag('posts', '文章相关')
  .build();
const document = SwaggerModule.createDocument(app, swaggerConfig); // 扫描装饰器生成 spec
SwaggerModule.setup('docs', app, document);                        // UI 挂到 /docs
```

挂载后：
- `GET /docs` —— Swagger UI（可交互）
- `GET /docs-json` —— 原始 OpenAPI JSON（喂给代码生成器 / Postman）

> `@nestjs/swagger` v7 自带 `swagger-ui-dist`，Express 下不用再装 `swagger-ui-express`。

### 4. 文档化 DTO：@ApiProperty

光有类型，Swagger 只能猜个大概。`@ApiProperty` / `@ApiPropertyOptional` 把字段的**约束、枚举、示例、说明**写清楚：

```typescript
export class CreatePostDto {
  @ApiProperty({ minLength: 1, maxLength: 100, example: 'NestJS + Prisma 实战' })
  @IsString() @Length(1, 100)
  title!: string;

  @ApiProperty({ enum: POST_STATUSES, example: 'draft' })
  @IsEnum(POST_STATUSES)
  status!: PostStatus;

  @ApiPropertyOptional({ type: [String], maxItems: 10, example: ['nestjs', 'prisma'] })
  @IsOptional() @IsArray() /* … */
  tags?: string[];
}
```

**Query DTO 自动变成 query 参数**：`@Query() query: QueryPostDto` + DTO 字段上的 `@ApiPropertyOptional`，Swagger 自动把它们渲染成 `?page=&limit=&sortBy=…` 的查询参数，不用手写 `@ApiQuery`。

> **少样板的替代**：`@nestjs/swagger` 有个 **CLI 插件**（`nest-cli.json` 里 `"plugins": ["@nestjs/swagger"]`），能从 TS 类型 + class-validator 自动推出大部分 `@ApiProperty`，连 JSDoc 注释都能当 description。本项目**故意手写**装饰器——教学上更直观，也不依赖编译期插件（`ts-node` 跑测试时插件不生效）。生产项目想少写样板就开插件。

### 5. 核心难点：统一响应外壳怎么写进文档

这是本项目最值得学的一点。Day 19 我们用 `TransformInterceptor` 把**所有**成功响应包了一层：

```
{ code: 0, data: <真正的业务数据>, message: "ok", requestId, timestamp }
```

问题来了：控制器方法 `findOne()` 的**返回类型是 `Post`**，但**实际 JSON 是包了外壳的**。Swagger 默认按返回类型推断，会告诉调用方"响应就是一个 Post"——**错的**，少了外壳。

解法：用 `@ApiExtraModels` + `getSchemaPath` + 手写 schema，把"外壳 + data 模型"用 `$ref` 拼出来。封装成一个可复用装饰器 `@ApiEnvelope`：

```typescript
export function ApiEnvelope<TModel extends Type<unknown>>(
  model: TModel,
  options: { isArray?: boolean; status?: number } = {},
) {
  return applyDecorators(
    ApiExtraModels(model),                       // 让 model 进 components.schemas
    ApiResponse({
      status: options.status ?? 200,
      schema: {
        properties: {
          code: { type: 'number', example: 0 },
          data: options.isArray
            ? { type: 'array', items: { $ref: getSchemaPath(model) } }
            : { $ref: getSchemaPath(model) },   // ← 关键：data 指向真正的模型
          message: { type: 'string', example: 'ok' },
          requestId: { type: 'string' },
          timestamp: { type: 'string', format: 'date-time' },
        },
      },
    }),
  );
}
```

用起来一行：

```typescript
@Get(':id')
@ApiEnvelope(PostResponseDto)                  // data 是单个 Post
findOne(...) { … }

@Get(':id/revisions')
@ApiEnvelope(PostRevisionResponseDto, { isArray: true })  // data 是数组
revisions(...) { … }
```

**为什么值得封装**：外壳结构只写一次。十几个路由复用同一个 `@ApiEnvelope`，外壳哪天加字段，改一处。这就是把 Day 19 的响应规范"如实、且不重复地"写进文档。错误响应同理封了个 `@ApiErrorEnvelope`。

### 6. 文档模型 ≠ 领域模型

注意 `@ApiEnvelope(PostResponseDto)` 里用的是 **`PostResponseDto`**，不是领域的 `Post` 接口。两个原因：

1. **Swagger 只认 class**（要靠装饰器附元数据），而领域 `Post` 是 `interface`（运行时不存在，无法挂装饰器）。
2. **线上 JSON 和领域对象形状有差异**：领域 `Post.createdAt` 是 `Date`，但**序列化后 JSON 里是 ISO 字符串**。文档要描述"线上长什么样"，所以 `PostResponseDto.createdAt: string`。

所以本项目把**文档模型**（`post-response.dto.ts`，纯为 OpenAPI，从不被 `new`）和**领域模型**（`entities/post.entity.ts`）分开。这点小重复换来"文档精确描述实际响应"，值得。

> 列表响应也照此办理：`PostListResponseDto { items: PostResponseDto[]; pagination }`、`PostFeedResponseDto { items; pageInfo }`，让 `/posts`、`/posts/feed`、`/posts/search` 的嵌套结构都准确。

### 7. UpdatePostDto 的坑：PartialType 要从 @nestjs/swagger 引

`UpdatePostDto extends PartialType(CreatePostDto)` 想复用 create 的字段定义。但 `PartialType` 有两个来源：

- `@nestjs/mapped-types` 的 PartialType：只复制 **class-validator** 元数据（校验规则变可选）
- `@nestjs/swagger` 的 PartialType：复制校验规则 **+ 保留 `@ApiProperty`**

如果用前者，update 的字段在 Swagger 里**看不到**（@ApiProperty 没被继承）。所以接了 Swagger 后，`PartialType` 要从 **`@nestjs/swagger`** 引——本项目 Day 30 就把这行 import 换了。一字之差，文档差一截。

### 8. 隐藏不该暴露的端点

`/posts/debug/boom` 是验证 500 脱敏的调试端点，不该出现在对外文档里。`@ApiExcludeEndpoint()` 一挂，它就从 `/docs` 消失（路由仍在，只是不进文档）。

### 9. 生产注意

- **文档要不要对外**：内部 API 常把 `/docs` 用 `NODE_ENV` 关掉，或加一层 Basic Auth / 网关白名单。本项目教学目的常开。
- **鉴权按钮**：等 Day 31 加了 JWT，`DocumentBuilder().addBearerAuth()` + 控制器 `@ApiBearerAuth()`，Swagger UI 就有个 "Authorize" 输入框，能带 token 试受保护接口。
- **spec 当契约**：把 `/docs-json` 固化下来，可做**契约测试**（防止后端偷偷改了响应破坏前端）、生成**前端类型化客户端**（`openapi-typescript` 等）。

### 10. 里程碑质量验收（"重构"这一刀切在哪）

Day 30 不堆新功能，是**收口**。这套 API 经过 Day 27–29 的逐日构建 + 对抗式 review，本身已经比较干净，今天的"重构/优化"主要是：

- **文档层与业务层解耦**：doc DTO、`@ApiEnvelope` 装饰器都是新增的"描述层"，没动业务逻辑
- **去重**：响应外壳的 schema 只在 `@ApiEnvelope` 写一次，不在每个路由手抄
- **一致性收尾**：`main.ts` 的启动日志、标题、版本号统一成 "Blog API v1.0"

封版前的自检清单（见下方验收）：类型干净、单测 + 集成测全绿、`/docs` 能打开且响应外壳正确、所有对外端点都有 summary 和响应模型。

---

## 💻 实践练习

### 主练习：给 blog-api 加 OpenAPI 文档

在 `solutions/blog/blog-api/` 上完成：

1. `pnpm add @nestjs/swagger`
2. `main.ts`：`DocumentBuilder` + `SwaggerModule.setup('docs', …)`
3. 写 `common/decorators/api-envelope.decorator.ts`：`@ApiEnvelope` / `@ApiErrorEnvelope`（用 `getSchemaPath` + `$ref` 文档化外壳）
4. 写 `posts/dto/post-response.dto.ts`：`PostResponseDto` / `PostRevisionResponseDto` / 列表 / 游标 / 删除响应模型
5. 给请求 DTO 加 `@ApiProperty` / `@ApiPropertyOptional`；`UpdatePostDto` 的 `PartialType` 换成 `@nestjs/swagger` 的
6. 控制器：`@ApiTags` + 每个路由 `@ApiOperation` + `@ApiParam` + `@ApiEnvelope` / `@ApiErrorEnvelope`；`debug/boom` 加 `@ApiExcludeEndpoint`

跑起来：

```bash
cd ../blog-db && docker compose up -d && cd -
cp .env.example .env
pnpm install && pnpm prisma:generate && pnpm prisma:migrate

pnpm start:dev
# 打开 http://localhost:3000/docs —— 可交互文档
# http://localhost:3000/docs-json —— 原始 OpenAPI spec
```

### 加分练习：自己想答案再看

1. **不用 `@ApiEnvelope` 会怎样**：去掉它、只靠返回类型，看 `/docs` 里 `GET /posts/:id` 的响应 schema——它会少掉 `code/data/...` 外壳吗？
2. **PartialType 来源对比**：把 `UpdatePostDto` 的 `PartialType` 换回 `@nestjs/mapped-types`，看 `PATCH /posts/:id` 的请求体在 `/docs` 里还剩几个字段。
3. **从 spec 生成客户端**：把 `/docs-json` 存下来，用 `openapi-typescript` 生成前端类型，体会"文档即契约"。
4. **加鉴权预览**：`addBearerAuth()` + 给某个路由 `@ApiBearerAuth()`，看 Swagger UI 多出的 Authorize 按钮（为 Day 31 铺垫）。
5. **文档模型 vs 领域模型**：为什么 `PostResponseDto.createdAt` 是 `string` 而领域 `Post.createdAt` 是 `Date`？序列化在中间做了什么？

### 验收清单（v1.0 封版自检）

```bash
# 1. 类型 + 测试
pnpm exec tsc --noEmit && echo "OK types"
pnpm test:unit       # 20 个
pnpm test:e2e        # 27 个（需 PG）

# 2. 文档能打开、外壳正确
pnpm start:dev
#   - /docs 渲染出 posts / health 两组、10 个对外端点（debug/boom 不在）
#   - GET /posts/{id} 的 200 响应 schema 含 code/data/message/requestId/timestamp
#   - data 指向 PostResponseDto（点开能看到 version / viewCount 等字段）
#   - PATCH /posts/{id} 请求体含 title/slug/.../version（PartialType 继承生效）

# 3. spec 可导出
curl -s http://localhost:3000/docs-json | jq '.paths | keys'
```

---

## ⚠️ 常见误区

- **以为加了返回类型 Swagger 就准了**：被 `TransformInterceptor` 包了外壳后，返回类型 ≠ JSON。要用 `@ApiEnvelope` 显式描述外壳。
- **`UpdatePostDto` 用 `@nestjs/mapped-types` 的 PartialType**：@ApiProperty 不继承，update 字段在文档里消失。换成 `@nestjs/swagger` 的。
- **拿领域 interface 当文档模型**：interface 运行时不存在、挂不了装饰器；且 Date 在 JSON 里是 string。用专门的 doc DTO class。
- **每个路由手抄外壳 schema**：重复且易漂移。封装成 `@ApiEnvelope` 一处维护。
- **调试 / 内部端点也进文档**：`debug/boom` 这类用 `@ApiExcludeEndpoint()` 藏掉。
- **生产把 `/docs` 裸奔对外**：内部 API 该用 env 关掉或加鉴权。
- **`@ApiProperty` 当成校验**：它只生成文档，不做校验。校验仍靠 class-validator，两套装饰器各司其职。
- **忘了 `@ApiExtraModels`**：只在 schema 里 `$ref` 一个没被注册的 model，`/docs` 会出现 `$ref` 找不到。`@ApiEnvelope` 内部已 `ApiExtraModels(model)` 兜住。

---

## ✅ 今日产出（阶段二里程碑 · v1.0）

- [ ] `/docs` 可交互文档跑起来，覆盖全部对外端点
- [ ] 用 `@ApiEnvelope` 把统一响应外壳如实文档化（data 指向具体模型）
- [ ] 所有请求 DTO 有 `@ApiProperty`，query DTO 自动渲染成查询参数
- [ ] `UpdatePostDto` 用 `@nestjs/swagger` 的 `PartialType`，字段在文档里继承可见
- [ ] 文档模型与领域模型分离，`debug/boom` 已从文档排除
- [ ] 类型干净、单测（20）+ 集成测（27）全绿
- [ ] 阶段二回顾完成，博客 API 封版 v1.0
- [ ] 提交到 GitHub，commit message 写明 "day 30 swagger / openapi + v1.0 milestone"

---

## 📚 延伸阅读

- [NestJS — OpenAPI (Swagger) Introduction](https://docs.nestjs.com/openapi/introduction)
- [NestJS — OpenAPI Types and Parameters（@ApiProperty 全集）](https://docs.nestjs.com/openapi/types-and-parameters)
- [NestJS — OpenAPI CLI Plugin（少样板方案）](https://docs.nestjs.com/openapi/cli-plugin)
- [NestJS — Mapped Types（PartialType / PickType / OmitType）](https://docs.nestjs.com/openapi/mapped-types)
- [OpenAPI Specification 3.0](https://spec.openapis.org/oas/v3.0.3)（规范本体）
- [openapi-typescript](https://github.com/openapi-ts/openapi-typescript)（从 spec 生成前端 TS 类型）
- [Swagger Editor](https://editor.swagger.io/)（在线粘 spec 看效果）

---

[⬅️ Day 29](../day-29/) | [➡️ Day 31](../day-31/)
