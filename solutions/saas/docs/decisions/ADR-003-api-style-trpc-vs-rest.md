# ADR-003：API 风格 — tRPC 端到端类型，REST 做外部契约

- **状态**：已采纳（Day 46）
- **影响**：前后端边界、类型流转、第三方集成

## 背景（Context）

前端是 Next.js，后端领域逻辑要有一层暴露给前端调。两条主流路：

| | tRPC | REST（+ OpenAPI） |
|---|---|---|
| 类型流转 | **天然端到端**：后端 procedure 的 input/output 类型，前端 `infer` 直接用，无需 codegen | 要 OpenAPI spec → codegen 前端类型，多一道生成步骤 |
| URL/契约 | 过程调用风格，URL 是框架生成的 | 资源 URL 是人定的、稳定的、语言无关 |
| 前端耦合 | 只能用 TS 客户端调（强绑 TS 生态） | 任何 HTTP 客户端、任何语言都能调 |
| 学习/生态 | 新，生态小 | 老牌，工具链成熟（Swagger/Postman/各种 codegen） |
| 缓存/CDN | 不利于 HTTP 缓存语义（POST 为主） | GET 的 HTTP 缓存语义天然友好 |

课程前面的博客（Day 17-45）用的是 **NestJS + REST + Swagger**，那是为了把 HTTP/REST/Nest 的基本功练透。现在面对一个**前后端都用 TS、且不打算对外开放 API** 的 SaaS，该重新权衡。

## 决策（Decision）

**内部（前端 ↔ 后端）用 tRPC 拿端到端类型；对外（未来的公开 API / 第三方集成）保留 REST/OpenAPI 作为独立契约层。**

具体到本弧线（Day 47-60）：

- **前端只跟 tRPC 说话**。Next.js 的 server component / client 都通过 tRPC client 调 procedure，input/output 全程类型安全，改后端字段前端立刻编译报错。这省掉的不只是 codegen，是「前后端字段对不上」这一整类 bug。
- **领域逻辑写成框架无关的 service**。tRPC procedure 只是一层薄壳：解析 input（zod）→ 调 service → 返回。service 本身不知道自己被 tRPC 还是 REST 调（这就是 api-design §8「契约和框架无关」的落地）。
- **REST/OpenAPI 层先不建**，但 schema/service 的设计保证「将来加一层 REST router 包同一个 service」是平移工作，不是重写。等真有第三方集成需求再开。

## 后果（Consequences）

**好的：**
- 前后端协作的摩擦大幅降低：没有「接口文档和实现对不上」、没有「手写 TS 类型」、没有 codegen 流水线要维护。
- zod schema 同时承担「input 校验」和「类型来源」——单一真相，校验和类型不会漂移（Day 20 的 zod env 校验同理）。
- service 框架无关，未来要换交付形态（加 REST、加 GraphQL、给移动端用）都不动核心。

**坏的 / 要认的代价：**
- **强绑 TS**。哪天后端想用别的语言、或前端要迁出 TS，tRPC 边界得重做。对「全 TS 的 Next.js + Node」项目这是零成本；对多语言团队是约束。
- **HTTP 缓存语义弱**。tRPC 的查询底层是 POST（或带复杂 query 的 GET），CDN/浏览器按 URL 的 GET 缓存用不上。需要缓存时要在 procedure 层自己管（呼应 Day 36 的 Redis 缓存）。
- **对外契约要单独建**。tRPC 不直接产出 OpenAPI。真要开放 API 时得加 `trpc-openapi` 之类的适配，或单独写 REST router——这是「先内部后外部」策略的必然代价。

## 为什么不和博客一样用 NestJS

不矛盾，是不同阶段的取舍。博客阶段的目标是**练 HTTP/REST/DI/装饰器这些基本功**，NestJS 是最好的教具。这个 SaaS 阶段的目标是**快速搭出一个类型安全、能演进的产品**，tRPC 的端到端类型在产品开发里性价比更高。NestJS 的 DI/模块化思想（Day 17 起）不会浪费——service 的组织方式、依赖注入的心智模型完全复用，只是「外壳」从 Nest controller 换成 tRPC router。

> 一句话：**NestJS 教你「后端怎么组织」，tRPC 教你「前后端怎么缝合」**。两个都值得会，这一弧线选后者，因为它解决的是 SaaS 前后端协作这个具体的痛。
