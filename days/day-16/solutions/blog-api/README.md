# Blog API — Day 16 NestJS 入门示例

用 NestJS 三件套（Module / Controller / Service）实现的博客文章 CRUD。
当前阶段使用**内存存储**，后续 Day 会替换为 PostgreSQL。

## 📂 目录结构

```
src/
├── main.ts                       # 入口：启动 Nest 应用、注册全局 ValidationPipe
├── app.module.ts                 # 根模块
├── app.controller.ts             # 根控制器：/ 与 /health
├── app.service.ts
└── posts/
    ├── posts.module.ts           # Posts 模块
    ├── posts.controller.ts       # 路由 /posts
    ├── posts.service.ts          # 业务逻辑（内存存储）
    ├── entities/
    │   └── post.entity.ts        # Post 实体定义
    └── dto/
        ├── create-post.dto.ts    # 创建参数 + class-validator 校验
        ├── update-post.dto.ts    # 更新参数（全可选）
        └── query-post.dto.ts     # 查询参数（分页 + 过滤）
```

## 🚀 启动

```bash
cd days/day-16/solutions/blog-api
pnpm install        # 或 npm install / yarn
pnpm start:dev      # 开发模式，热重载
```

默认监听 `http://localhost:3000`（可通过 `PORT=4000 pnpm start:dev` 覆盖）。

## 🧪 接口测试（curl）

### 1. 基础信息

```bash
curl http://localhost:3000/
curl http://localhost:3000/health
```

### 2. 创建文章

```bash
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Hello NestJS",
    "content": "我的第一篇文章",
    "author": "cris",
    "tags": ["nestjs", "nodejs"],
    "published": true
  }'
```

### 3. 列表（带分页与过滤）

```bash
curl 'http://localhost:3000/posts?page=1&limit=10'
curl 'http://localhost:3000/posts?author=cris'
curl 'http://localhost:3000/posts?tag=nestjs'
```

### 4. 详情

```bash
curl http://localhost:3000/posts/1
```

### 5. 部分更新（PATCH）

```bash
curl -X PATCH http://localhost:3000/posts/1 \
  -H 'Content-Type: application/json' \
  -d '{"title": "Hello NestJS (Updated)"}'
```

### 6. 删除

```bash
curl -X DELETE http://localhost:3000/posts/1
```

### 7. 校验失败示例

```bash
# 缺少必填 content / author → 422 验证失败
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{"title": "x"}'

# 未声明字段被 forbidNonWhitelisted 拒绝
curl -X POST http://localhost:3000/posts \
  -H 'Content-Type: application/json' \
  -d '{"title":"a","content":"b","author":"c","evil":"x"}'
```

## 💡 关键点回顾

- **IoC + DI**：`PostsController` 通过构造函数注入 `PostsService`，由 Nest 容器负责实例化与生命周期管理。
- **装饰器路由**：`@Controller('posts')` + `@Get/@Post/@Patch/@Delete` 声明式映射 HTTP。
- **DTO + ValidationPipe**：参数声明在 DTO 里，校验交给 `class-validator`，业务代码保持干净。
- **ParseIntPipe**：把 URL 参数从字符串安全转 number，转换失败自动 400。
- **HttpCode**：显式标注 201 等成功状态码，让契约更清晰。

## 🔜 下一步

Day 17 起会逐步加入：请求生命周期（中间件 / 守卫 / 拦截器 / 管道）、统一异常过滤器、配置模块、TypeORM + PostgreSQL 等。
