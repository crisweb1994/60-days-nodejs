# Day 18 Solution — Blog API 数据验证

基于 Day 16 / 17 的 `blog-api` 精简版，聚焦今天的主题：**DTO + ValidationPipe + 自定义校验器 + 嵌套 DTO**。

## 涵盖练习

- **练习 1**：全局 `ValidationPipe`（`whitelist` / `forbidNonWhitelisted` / `transform`），`UpdatePostDto` 用 `PartialType(CreatePostDto)` 派生
- **练习 2**：自定义 `@IsSlug()` 装饰器 —— `src/common/validators/is-slug.validator.ts`
- **练习 3**：嵌套 `meta` 字段，用 `@ValidateNested()` + `@Type(() => PostMetaDto)`

额外加了 `exceptionFactory`，把默认的 `message: string[]` 响应升级成按字段聚合的结构化错误。

## 项目结构

```
src/
├── main.ts                                  # 全局 ValidationPipe + 结构化 exceptionFactory
├── app.module.ts
├── common/validators/is-slug.validator.ts   # 练习 2
└── posts/
    ├── posts.module.ts
    ├── posts.controller.ts
    ├── posts.service.ts
    ├── entities/post.entity.ts
    └── dto/
        ├── create-post.dto.ts               # 包含 slug + 嵌套 meta
        ├── update-post.dto.ts               # PartialType
        ├── post-meta.dto.ts                 # 嵌套 DTO
        └── query-post.dto.ts                # 演示 transform 隐式类型转换
```

## 运行

```bash
pnpm install
pnpm start:dev   # http://localhost:3000
pnpm test        # 6 个单元测试，覆盖所有校验场景
```

## 手动验证

```bash
# ✅ 合法创建
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"hi","slug":"hello-day-18","content":"a very long content...","status":"draft"}'

# ❌ 多余字段（forbidNonWhitelisted）
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"x","slug":"x","content":"xxxxxxxxxx","status":"draft","isAdmin":true}'

# ❌ slug 不合法（自定义 IsSlug）
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"x","slug":"Bad_Slug!","content":"xxxxxxxxxx","status":"draft"}'

# ❌ 嵌套字段越界（meta.seoTitle 为空）
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"x","slug":"ok","content":"xxxxxxxxxx","status":"draft","meta":{"seoTitle":"","seoDescription":""}}'
```

错误响应统一为：

```json
{
  "code": "VALIDATION_ERROR",
  "errors": [
    { "field": "meta.seoTitle", "messages": ["seoTitle 长度需在 1-70"] }
  ]
}
```

## 想体会"嵌套校验静默失效"

把 `create-post.dto.ts` 中 `meta` 字段上的 `@Type(() => PostMetaDto)` 注释掉，再发上面那条非法 meta 的请求 —— 会发现 200 通过，但 meta 内部什么都没校验。这就是装饰器顺序/搭配上最常见的暗坑。
