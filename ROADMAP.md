# 🗺️ 60 天学会 Node.js 全栈开发 — 完整路线图

> 每天 3-4 小时，60 天从前端工程师成长为全栈工程师。

---

## 总览

```
阶段一 ████████████████░░░░░░░░░░░░░░░░░░░░░░ Day 01-15  Node.js 核心基础
阶段二 ░░░░░░░░░░░░░░░░████████████████░░░░░░ Day 16-30  后端框架与数据库
阶段三 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██████ Day 31-40  认证、安全与缓存
阶段四 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░████ Day 41-45  DevOps 与部署
阶段五 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██████ Day 46-55  全栈项目实战
阶段六 ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░████ Day 56-60  测试、优化、系统设计
```

---

## 阶段一：Node.js 核心基础（Day 1-15）

> **目标**：深入理解 Node.js 运行时原理，能用原生 API 从零构建 HTTP 服务和 REST API。

| Day | 主题 | 核心知识点 | 产出物 |
|-----|------|-----------|--------|
| 01 | 环境搭建与初印象 | Node.js 安装、nvm、REPL、首个程序 | ✅ 开发环境就绪 |
| 02 | 模块系统与包管理 | CJS vs ESM、package.json、npm/pnpm | ✅ 多模块小项目 |
| 03 | 核心模块（上） | fs、path、os 模块、同步/异步文件 I/O | ✅ 文件操作工具 |
| 04 | 核心模块（下） | events、EventEmitter、stream、Buffer | ✅ 大文件流式处理工具 |
| 05 | 事件循环深度解析 | Event Loop 六阶段、nextTick vs setImmediate、libuv | ✅ 事件循环测试用例集 |
| 06 | 异步编程模式 | Callback→Promise→async/await、并发控制 | ✅ 并发任务调度器 |
| 07 | HTTP 协议基础 | 请求响应模型、状态码语义、请求头 | ✅ 原生 HTTP 服务器 |
| 08 | 手写 REST API（上） | 路由匹配、JSON 解析、HTTP 方法语义 | ✅ 简易路由器 |
| 09 | 手写 REST API（下） | 中间件模式、CORS、错误处理 | ✅ 完整 TODO CRUD API |
| 10 | 🏆 迷你项目 Review | 代码重构、文档编写、Git 提交 | ✅ GitHub 首个项目 |
| 11 | TypeScript 服务端 | tsconfig、类型系统、ts-node/tsx | ✅ TypeScript 重写 TODO API |
| 12 | RESTful API 设计 | 资源命名、版本化、分页排序、OpenAPI | ✅ 博客系统 API 文档 |
| 13 | 进程管理与多线程 | child_process、worker_threads、cluster | ✅ CPU 密集型多线程方案 |
| 14 | 错误处理与调试 | 自定义错误类、全局捕获、DevTools 调试 | ✅ 完善错误处理体系 |
| 15 | 🎯 阶段一总结 | 知识回顾、限时编码测验、查漏补缺 | ✅ 阶段一学习笔记 |

---

## 阶段二：后端框架与数据库（Day 16-30）

> **目标**：掌握 NestJS 企业级框架和 PostgreSQL + Prisma 数据库技术栈，构建完整的博客系统后端。

| Day | 主题 | 核心知识点 | 产出物 |
|-----|------|-----------|--------|
| 16 | NestJS 架构与核心概念 | IoC/DI、Module/Controller/Service、装饰器 | ✅ NestJS Hello World |
| 17 | NestJS 请求生命周期 | Middleware→Guard→Interceptor→Pipe→Handler→Filter | ✅ Logger + Transform |
| 18 | NestJS 数据验证 | class-validator、class-transformer、DTO | ✅ 博客 DTO 验证 |
| 19 | NestJS 异常处理 | 全局异常过滤器、业务/系统异常、统一响应 | ✅ 标准化响应格式 |
| 20 | 🏆 NestJS 博客 API | 内存数据 CRUD、全部中间件集成 | ✅ 完整 NestJS 项目 |
| 21 | PostgreSQL 入门 | Docker 安装、SQL 基础（CRUD）、数据类型 | ✅ 博客数据库和基础表 |
| 22 | SQL：JOIN 与子查询 | INNER/LEFT/RIGHT JOIN、聚合函数 | ✅ 10 道 SQL 练习题 |
| 23 | SQL：索引与性能 | B+ 树、覆盖索引、EXPLAIN ANALYZE、窗口函数 | ✅ 索引方案设计 |
| 24 | 数据库建模实战 | 1NF/2NF/3NF、ER 图、一对多/多对多 | ✅ 完整 ER 图 + 建表 SQL |
| 25 | Prisma ORM 入门 | Schema DSL、Migration、基本 CRUD、关联查询 | ✅ Prisma 连接 PG |
| 26 | Prisma ORM 进阶 | 事务、N+1 问题、include/select、原生 SQL | ✅ 查询优化 |
| 27 | NestJS + Prisma 整合 | Repository 模式、Service 分层 | ✅ 博客 API 接入数据库 |
| 28 | 分页、搜索与排序 | Offset vs Cursor 分页、模糊搜索、动态排序 | ✅ 完整查询功能 |
| 29 | 事务与并发控制 | ACID、隔离级别、乐观锁/悲观锁、死锁 | ✅ 并发安全的点赞功能 |
| 30 | 🏆 博客系统完整版 | Swagger 文档、代码重构、完整 API | ✅ 博客系统后端 v1.0 |

---

## 阶段三：认证、安全与缓存（Day 31-40）

> **目标**：实现生产级认证授权体系，集成 Redis 缓存和消息队列，建立安全防护意识。

| Day | 主题 | 核心知识点 | 产出物 |
|-----|------|-----------|--------|
| 31 | Session vs JWT | 有状态/无状态认证、JWT 结构、对比分析 | ✅ 认证方案分析笔记 |
| 32 | JWT 认证实战 | bcrypt、Access/Refresh Token、安全存储 | ✅ 注册登录功能 |
| 33 | RBAC 权限模型 | 用户-角色-权限、NestJS Guard、资源级权限 | ✅ 三级权限系统 |
| 34 | OAuth 2.0 第三方登录 | 授权码模式、GitHub OAuth、Client Secret | ✅ GitHub 登录 |
| 35 | Web 安全防护 | OWASP Top 10、SQLi/XSS/CSRF、Helmet.js | ✅ 安全防护层 |
| 36 | Redis 基础 | Docker 安装、数据结构、Cache-Aside 策略 | ✅ 文章缓存 |
| 37 | Redis 进阶 | 排行榜、分布式锁、缓存穿透/击穿/雪崩 | ✅ 热门文章排行榜 |
| 38 | 消息队列 | BullMQ、异步邮件、重试机制、死信队列 | ✅ 评论通知异步发送 |
| 39 | 文件上传 | Multer、S3/R2、Sharp 图片处理 | ✅ 文章封面图上传 |
| 40 | 🏆 安全加固版博客 | 认证+权限+缓存+队列整合、安全审计 | ✅ 博客系统 v2.0 |

---

## 阶段四：DevOps 与部署（Day 41-45）

> **目标**：掌握现代应用的容器化部署、CI/CD 自动化和生产环境运维基础。

| Day | 主题 | 核心知识点 | 产出物 |
|-----|------|-----------|--------|
| 41 | Docker 基础 | Dockerfile、多阶段构建、.dockerignore | ✅ 博客系统容器化 |
| 42 | Docker Compose | 多服务编排（App+PG+Redis）、网络、数据卷 | ✅ 一键启动 docker-compose |
| 43 | CI/CD 流水线 | GitHub Actions、自动测试/构建/部署 | ✅ 自动化流水线 |
| 44 | 云部署实战 | Vercel/Railway、云数据库、域名+HTTPS | ✅ 博客系统公网上线 |
| 45 | 日志与监控 | Pino/Winston、健康检查、Sentry | ✅ 可观测性方案 |

---

## 阶段五：全栈项目实战 — SaaS 任务管理平台（Day 46-55）

> **目标**：从零到一构建生产级全栈项目，覆盖全栈工程师核心技能，打造简历亮点。

| Day | 主题 | 核心知识点 | 产出物 |
|-----|------|-----------|--------|
| 46 | 项目规划 | 需求分析、架构设计、数据库建模、API 设计 | ✅ 设计文档 + ER 图 |
| 47 | 项目脚手架 | Next.js + tRPC/NestJS、Prisma、Docker Compose | ✅ 可运行脚手架 |
| 48 | 用户与团队 | 注册登录、组织管理、邀请机制、RBAC | ✅ 用户团队模块 |
| 49 | 任务系统 | 任务 CRUD、状态机、优先级、标签、指派 | ✅ 核心业务逻辑 |
| 50 | 看板与列表 | 拖拽排序后端、聚合查询、筛选分页 | ✅ 视图 API |
| 51 | 实时通信 | WebSocket/SSE、状态同步、在线用户 | ✅ 实时协作 |
| 52 | 通知系统 | 站内通知、邮件队列、偏好设置 | ✅ 通知模块 |
| 53 | 数据统计 | 聚合查询、趋势图、工作量分布 | ✅ 统计 API |
| 54 | 前端联调 | Next.js 页面、React Query、状态管理 | ✅ 前后端联调 |
| 55 | 🏆 项目上线 | Docker + CI/CD + 云部署 + 性能优化 | ✅ SaaS 平台上线 |

---

## 阶段六：测试、优化与系统设计（Day 56-60）

> **目标**：补齐工程化短板，建立系统设计方法论，为面试做最后冲刺。

| Day | 主题 | 核心知识点 | 产出物 |
|-----|------|-----------|--------|
| 56 | 测试策略 | 单元/集成/E2E 测试、Jest/Supertest/Playwright | ✅ 测试套件（80%+ 覆盖率） |
| 57 | 性能优化 | Node.js Profiling、数据库优化、压测 | ✅ 性能优化报告 |
| 58 | 系统设计 | CAP/BASE、设计方法论、经典设计题 | ✅ 3 道系统设计笔记 |
| 59 | 面试准备 | 项目包装、知识点清单、模拟面试 | ✅ 简历描述 + 面试笔记 |
| 60 | 总结与进阶 | 知识体系回顾、进阶方向、资源清单 | ✅ 结业总结 |

---

## 里程碑检查点

| 检查点 | 天数 | 产出 | 技能验证 |
|--------|------|------|----------|
| 🏆 Mile 1 | Day 10 | 原生 TODO API | 能用原生 Node.js 构建 HTTP 服务 |
| 🎯 Review 1 | Day 15 | 阶段一测验 | Node.js 核心原理掌握 |
| 🏆 Mile 2 | Day 20 | NestJS 博客 API | 掌握企业级框架 |
| 🏆 Mile 3 | Day 30 | 博客系统 v1.0 | 后端 + 数据库完整闭环 |
| 🏆 Mile 4 | Day 40 | 博客系统 v2.0 | 认证 + 安全 + 缓存 |
| 🏆 Mile 5 | Day 45 | 博客系统上线 | DevOps 能力 |
| 🏆 Mile 6 | Day 55 | SaaS 平台上线 | 全栈项目交付能力 |
| 🎯 Final | Day 60 | 结业 | 全栈工程师知识体系 |

---

## 面试知识点清单

完成 60 天学习后，你应该能清晰回答以下所有问题：

### 后端核心
- [ ] Node.js 事件循环与异步 I/O 原理
- [ ] RESTful API 设计原则与最佳实践
- [ ] JWT 认证流程、安全存储、Token 刷新
- [ ] OAuth 2.0 授权码模式完整流程
- [ ] RBAC 权限模型设计与实现
- [ ] SQL 查询优化与索引原理
- [ ] 数据库事务与隔离级别
- [ ] ORM N+1 问题与解决方案
- [ ] Redis 数据结构与应用场景
- [ ] 缓存穿透/击穿/雪崩及解决方案
- [ ] 消息队列使用场景与基本原理
- [ ] WebSocket 与 HTTP 长轮询对比

### DevOps
- [ ] Docker（Dockerfile、Compose、多阶段构建）
- [ ] CI/CD 流水线设计
- [ ] 环境管理与配置管理
- [ ] 日志与监控

### 系统设计
- [ ] CAP 定理与 BASE 理论
- [ ] 负载均衡策略
- [ ] 数据库分片与读写分离
- [ ] 微服务 vs 单体架构的权衡
