# Day 16 — NestJS 入门：架构与核心概念

## 📋 今日目标

- 理解 IoC（控制反转）和 DI（依赖注入）的设计哲学
- 掌握 NestJS 的三件套：Module、Controller、Service
- 理解装饰器（Decorators）的运作原理
- 用 NestJS CLI 创建并运行第一个项目

## 📖 核心知识点

### 1. 从前端思维到后端思维的跳跃

前端框架（React/Vue）以**组件**为核心，后端框架（NestJS）以**模块+服务**为核心。最大的思维跳跃是**依赖注入**：

```
前端：组件直接 import 依赖
import { fetchUsers } from './api'

后端（NestJS）：通过构造函数注入依赖
constructor(private readonly userService: UserService) {}
```

**为什么要用 DI？**
- 松耦合：Service 不关心依赖的具体实现
- 可测试：测试时可以注入 Mock 实现
- 灵活替换：换数据库只需要替换 Provider

### 2. NestJS 项目结构

```bash
# 创建项目
npx -y @nestjs/cli new blog-api
cd blog-api
pnpm start:dev
```

```
blog-api/
├── src/
│   ├── app.module.ts        # 根模块
│   ├── app.controller.ts    # 根控制器
│   ├── app.service.ts       # 根服务
│   └── main.ts              # 入口
├── test/                    # 测试
├── nest-cli.json
├── tsconfig.json
└── package.json
```

### 3. Module — 模块

```typescript
import { Module } from '@nestjs/common';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  controllers: [PostsController],  // 处理 HTTP 请求
  providers: [PostsService],        // 可注入的服务
  exports: [PostsService],          // 导出给其他模块使用
})
export class PostsModule {}
```

### 4. Controller — 控制器

```typescript
import { Controller, Get, Post, Put, Delete, Param, Body, Query } from '@nestjs/common';

@Controller('posts')  // 路由前缀 /posts
export class PostsController {
  constructor(private readonly postsService: PostsService) {}

  @Get()
  findAll(@Query('page') page: string, @Query('limit') limit: string) {
    return this.postsService.findAll(+page || 1, +limit || 20);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.postsService.findOne(+id);
  }

  @Post()
  create(@Body() createPostDto: CreatePostDto) {
    return this.postsService.create(createPostDto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() updatePostDto: UpdatePostDto) {
    return this.postsService.update(+id, updatePostDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.postsService.remove(+id);
  }
}
```

### 5. Service — 服务（业务逻辑层）

```typescript
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class PostsService {
  private posts = [];
  private nextId = 1;

  findAll(page: number, limit: number) {
    const start = (page - 1) * limit;
    return {
      data: this.posts.slice(start, start + limit),
      total: this.posts.length,
    };
  }

  findOne(id: number) {
    const post = this.posts.find(p => p.id === id);
    if (!post) throw new NotFoundException(`Post #${id} not found`);
    return post;
  }

  create(dto: CreatePostDto) {
    const post = { id: this.nextId++, ...dto, createdAt: new Date() };
    this.posts.push(post);
    return post;
  }

  update(id: number, dto: UpdatePostDto) {
    const post = this.findOne(id);
    Object.assign(post, dto, { updatedAt: new Date() });
    return post;
  }

  remove(id: number) {
    const index = this.posts.findIndex(p => p.id === id);
    if (index === -1) throw new NotFoundException();
    this.posts.splice(index, 1);
  }
}
```

---

## 💻 实践练习

### 练习：创建博客文章模块

1. 用 NestJS CLI 创建项目
2. 生成 Posts 模块：`nest generate resource posts`
3. 实现文章的完整 CRUD（内存存储）
4. 用 Thunder Client 测试所有接口

---

## ✅ 今日产出

- [ ] 理解 IoC/DI 的设计哲学
- [ ] 用 NestJS CLI 创建项目
- [ ] 实现 Module/Controller/Service 三件套
- [ ] 完成文章 CRUD API

## 📚 延伸阅读

- [NestJS 官方文档 - First Steps](https://docs.nestjs.com/first-steps)
- [NestJS 官方文档 - Controllers](https://docs.nestjs.com/controllers)
- [NestJS 官方文档 - Providers](https://docs.nestjs.com/providers)

---

[⬅️ Day 15 — 阶段一总结](../day-15/) | [➡️ Day 17 — NestJS 请求生命周期](../day-17/)
