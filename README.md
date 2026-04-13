<p align="center">
  <img src="https://nodejs.org/static/logos/nodejsDark.svg" width="200" alt="Node.js Logo" />
</p>

<h1 align="center">60 天学会 Node.js 全栈开发</h1>

<p align="center">
  <strong>一套面向前端工程师的 60 天 Node.js 全栈系统学习路线</strong>
</p>

<p align="center">
  从 Node.js 基础原理到后端框架、数据库、缓存、部署上线与全栈项目实战，帮助你系统补齐全栈能力。
</p>

<p align="center">
  <strong>🚧 WIP：</strong> 当前已完整整理 Day 1-16，Day 17-60 正在持续补充详细讲解、练习与参考答案。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> •
  <a href="#课程大纲">课程大纲</a> •
  <a href="#项目实战">项目实战</a> •
  <a href="#贡献指南">贡献指南</a> •
  <a href="./ROADMAP.md">完整路线图</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/天数-60天-brightgreen" alt="60 Days" />
  <img src="https://img.shields.io/badge/每天-3~4小时-blue" alt="3-4 hours/day" />
  <img src="https://img.shields.io/badge/语言-TypeScript-3178c6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="MIT License" />
</p>

---

## 项目简介

市面上的 Node.js 教程要么太入门（只教你写 Hello World），要么太零散（几百篇博客拼不出体系）。

这个仓库的目标是：**用 60 天时间，帮助有前端基础的工程师系统掌握 Node.js 全栈开发**，从核心原理到生产部署，逐步建立完整的全栈知识体系和项目交付能力。

> 当前状态说明：仓库目前优先完成了 **Day 1-16** 的详细内容；**Day 17-60** 已建立路线图与每日页面骨架，详细正文、练习模板与参考答案会继续迭代补充。

### 这个仓库有什么特点？

- 以天为单位组织内容，学习节奏清晰，适合持续推进
- 从 Node.js 核心原理一路覆盖 NestJS、PostgreSQL、Redis、Docker、Next.js
- 每个阶段都围绕里程碑项目设计，不只学知识点，也强调项目交付能力
- 面向前端工程师设计学习路径，重点补齐服务端、数据库、工程化与系统设计能力

### 适合谁？

- ✅ 有 1-3 年前端经验，想转全栈的工程师
- ✅ 熟悉 JavaScript/TypeScript，想深入 Node.js 服务端的开发者
- ✅ 想系统性补齐后端知识短板的前端工程师
- ⚠️ 完全的编程新手可能需要先学习 JavaScript 基础

### 你会学到什么？

| 能力维度 | 具体技能 |
|---------|--------|
| **服务端开发** | Node.js 核心原理、NestJS 框架、REST API 设计、中间件体系 |
| **数据库** | PostgreSQL、SQL 编写、Prisma ORM、数据库建模与优化 |
| **认证安全** | JWT、OAuth 2.0、RBAC 权限、Web 安全防护 |
| **缓存队列** | Redis 缓存策略、BullMQ 消息队列、实时通信 |
| **DevOps** | Docker 容器化、CI/CD 流水线、云部署、日志监控 |
| **系统设计** | 分布式基础概念、性能优化、系统设计面试方法论 |

---

## 快速开始

### 前置要求

- **Node.js** v20+（推荐使用 [nvm](https://github.com/nvm-sh/nvm) 管理版本）
- **Git**（版本控制）
- **VS Code**（推荐编辑器）
- **Docker Desktop**（Day 21 起需要）
- 每天 **3-4 小时**学习时间

### 开始学习

```bash
# 克隆仓库
git clone https://github.com/cris1994.wang/60-days-nodejs.git
cd 60-days-nodejs

# 从 Day 1 开始
cd days/day-01
# 阅读 README.md 开始学习
```

### 学习方式

- 按天推进，共 60 天完成完整学习闭环
- 每天投入 3 到 4 小时，兼顾系统学习与动手实践
- 建议按顺序学习，避免跳过阶段性里程碑
- 当前建议优先完成 Day 1-16，后续天数可结合路线图、推荐资源和你自己的练习持续推进

### 学习建议

1. **按顺序学习** — 每天的内容建立在前一天的基础之上
2. **动手编码** — 光看不练等于没学，每天都要完成实践练习
3. **写学习笔记** — 用自己的话总结当天知识点
4. **提交代码** — 每天都向自己的仓库提交代码，保持 commit 记录
5. **不要跳过里程碑** — 每 5-10 天的里程碑项目是检验学习效果的最佳方式

---

## 课程大纲

### 🟢 阶段一：Node.js 核心基础（Day 1-15）

从零搭建开发环境，深入理解 Node.js 运行时原理，用原生 API 手写 HTTP 服务器和 REST API。

| 天数 | 主题 | 关键词 |
|-----|------|-------|
| Day 01 | [环境搭建与 Node.js 初印象](./days/day-01/) | 安装、REPL、Hello World |
| Day 02 | [模块系统与包管理](./days/day-02/) | CJS/ESM、npm/pnpm |
| Day 03 | [核心模块（上）：fs、path、os](./days/day-03/) | 文件系统、路径处理 |
| Day 04 | [核心模块（下）：events、stream](./days/day-04/) | EventEmitter、Buffer、Stream |
| Day 05 | [事件循环深度解析](./days/day-05/) | Event Loop、libuv、异步 I/O |
| Day 06 | [异步编程模式](./days/day-06/) | Promise、async/await、并发控制 |
| Day 07 | [HTTP 协议基础](./days/day-07/) | 状态码、请求头、node:http |
| Day 08 | [手写 REST API（上）](./days/day-08/) | 路由匹配、请求体解析 |
| Day 09 | [手写 REST API（下）](./days/day-09/) | 中间件模式、CORS、错误处理 |
| Day 10 | [🏆 里程碑：迷你项目 Review](./days/day-10/) | 代码重构、README 文档 |
| Day 11 | [TypeScript 服务端开发](./days/day-11/) | tsconfig、类型系统、tsx |
| Day 12 | [RESTful API 设计原则](./days/day-12/) | 资源命名、版本化、OpenAPI |
| Day 13 | [进程管理与 Worker Threads](./days/day-13/) | child_process、cluster、多线程 |
| Day 14 | [错误处理与调试技巧](./days/day-14/) | 自定义错误、调试工具 |
| Day 15 | [🎯 阶段一总结与测验](./days/day-15/) | 知识回顾、编码测验 |

### 🔵 阶段二：后端框架与数据库（Day 16-30）

深入 NestJS 企业级框架，掌握 PostgreSQL 和 Prisma ORM，构建完整的博客系统后端。

| 天数 | 主题 | 关键词 |
|-----|------|-------|
| Day 16 | [NestJS 入门：架构与核心概念](./days/day-16/) | IoC/DI、Module/Controller/Service |
| Day 17 | [NestJS 深入：请求生命周期](./days/day-17/) | Middleware、Guard、Interceptor |
| Day 18 | [NestJS 数据验证与 DTO](./days/day-18/) | class-validator、Pipe |
| Day 19 | [NestJS 异常处理与响应标准化](./days/day-19/) | ExceptionFilter、统一响应 |
| Day 20 | [🏆 里程碑：NestJS 博客 API](./days/day-20/) | 内存数据、完整 CRUD |
| Day 21 | [PostgreSQL 入门](./days/day-21/) | Docker 安装、SQL 基础 |
| Day 22 | [SQL 进阶：JOIN 与子查询](./days/day-22/) | 多表查询、聚合函数 |
| Day 23 | [SQL 进阶：索引与性能](./days/day-23/) | B+ 树、EXPLAIN ANALYZE |
| Day 24 | [数据库建模实战](./days/day-24/) | 范式、ER 图、多对多关系 |
| Day 25 | [Prisma ORM 入门](./days/day-25/) | Schema、Migration、CRUD |
| Day 26 | [Prisma ORM 进阶](./days/day-26/) | 事务、N+1 问题、原生 SQL |
| Day 27 | [NestJS + Prisma 整合](./days/day-27/) | Repository 模式、Service 层 |
| Day 28 | [分页、搜索与排序](./days/day-28/) | Cursor 分页、模糊搜索 |
| Day 29 | [数据库事务与并发控制](./days/day-29/) | ACID、隔离级别、乐观锁 |
| Day 30 | [🏆 里程碑：博客系统完整版](./days/day-30/) | Swagger 文档、代码重构 |

### 🟡 阶段三：认证、安全与缓存（Day 31-40）

实现生产级认证授权体系，集成 Redis 缓存和消息队列，构建安全加固版博客系统。

| 天数 | 主题 | 关键词 |
|-----|------|-------|
| Day 31 | [认证基础：Session vs JWT](./days/day-31/) | 有状态/无状态、Token 结构 |
| Day 32 | [JWT 认证实战](./days/day-32/) | bcrypt、双 Token、登录注册 |
| Day 33 | [RBAC 权限模型](./days/day-33/) | 角色权限、Guard、资源级权限 |
| Day 34 | [OAuth 2.0 与第三方登录](./days/day-34/) | 授权码模式、GitHub OAuth |
| Day 35 | [Web 安全防护](./days/day-35/) | OWASP Top 10、XSS/CSRF/SQLi |
| Day 36 | [Redis 基础与缓存策略](./days/day-36/) | 数据结构、Cache-Aside |
| Day 37 | [Redis 进阶应用](./days/day-37/) | 排行榜、分布式锁、缓存问题 |
| Day 38 | [消息队列与异步任务](./days/day-38/) | BullMQ、重试、死信队列 |
| Day 39 | [文件上传与存储](./days/day-39/) | Multer、S3、图片处理 |
| Day 40 | [🏆 里程碑：安全加固版博客](./days/day-40/) | 安全审计、性能测试 |

### 🟠 阶段四：DevOps 与部署（Day 41-45）

掌握 Docker 容器化、CI/CD 自动化和云端部署，让应用从本地走向生产环境。

| 天数 | 主题 | 关键词 |
|-----|------|-------|
| Day 41 | [Docker 基础](./days/day-41/) | Dockerfile、多阶段构建 |
| Day 42 | [Docker Compose 编排](./days/day-42/) | 多服务编排、网络、数据卷 |
| Day 43 | [CI/CD 流水线](./days/day-43/) | GitHub Actions、自动化 |
| Day 44 | [云部署实战](./days/day-44/) | Vercel/Railway、域名配置 |
| Day 45 | [日志、监控与健康检查](./days/day-45/) | Pino、Sentry、健康检查 |

### 🔴 阶段五：全栈项目实战（Day 46-55）

从零构建 SaaS 级任务管理平台（类似简化版 Linear），覆盖全栈工程师核心技能点。

| 天数 | 主题 | 关键词 |
|-----|------|-------|
| Day 46 | [项目规划与架构设计](./days/day-46/) | 需求分析、ER 图、API 设计 |
| Day 47 | [项目脚手架搭建](./days/day-47/) | Next.js + tRPC/NestJS、Prisma |
| Day 48 | [用户系统与团队管理](./days/day-48/) | 注册登录、组织管理、RBAC |
| Day 49 | [项目与任务 CRUD](./days/day-49/) | 状态机、优先级、标签 |
| Day 50 | [看板与列表视图](./days/day-50/) | 拖拽排序、筛选聚合 |
| Day 51 | [实时通信](./days/day-51/) | WebSocket、Socket.io |
| Day 52 | [通知与异步任务](./days/day-52/) | 站内通知、邮件队列 |
| Day 53 | [数据看板与统计](./days/day-53/) | 聚合查询、趋势图 |
| Day 54 | [前端集成与联调](./days/day-54/) | Next.js、React Query |
| Day 55 | [🏆 里程碑：项目部署上线](./days/day-55/) | Docker、CI/CD、云部署 |

### 🟣 阶段六：测试、优化与系统设计（Day 56-60）

补齐测试能力，深入性能优化，建立系统设计方法论，打磨简历项目。

| 天数 | 主题 | 关键词 |
|-----|------|-------|
| Day 56 | [测试策略与实战](./days/day-56/) | Jest、Supertest、Playwright |
| Day 57 | [性能优化](./days/day-57/) | Profiling、压测、查询优化 |
| Day 58 | [系统设计思维](./days/day-58/) | CAP、负载均衡、经典设计题 |
| Day 59 | [简历包装与面试准备](./days/day-59/) | 项目描述、知识点清单 |
| Day 60 | [总结与进阶路线](./days/day-60/) | 知识体系、进阶方向 |

---

## 项目实战

本教程围绕三个渐进式项目展开。当前仓库优先提供学习路线与每日文档，项目代码与脚手架会随更新进度逐步补充。

### 1. 🟢 迷你 TODO API（Day 8-10）
用原生 Node.js 构建，不使用任何框架，理解底层原理。

### 2. 🔵 博客系统（Day 16-40）
用 NestJS + PostgreSQL + Redis 构建，覆盖后端核心技能。

### 3. 🔴 SaaS 任务管理平台（Day 46-55）
全栈项目，用 Next.js + NestJS/tRPC + PostgreSQL + Redis + Docker 构建，作为阶段性综合实战目标。

---

## 技术栈

| 层次 | 技术 | 用途 |
|-----|------|-----|
| 运行时 | Node.js v20+ | JavaScript 服务端运行时 |
| 语言 | TypeScript | 类型安全 |
| 后端框架 | NestJS | 企业级框架 |
| ORM | Prisma | 数据库访问层 |
| 数据库 | PostgreSQL | 关系型数据库 |
| 缓存 | Redis | 缓存与消息队列 |
| 全栈框架 | Next.js | 前后端一体化 |
| 容器化 | Docker | 部署与环境管理 |
| CI/CD | GitHub Actions | 自动化流水线 |

---

## 目录结构

```
60-days-nodejs/
├── README.md                   # 👈 你在这里
├── ROADMAP.md                  # 60 天完整路线图
├── days/
│   ├── day-01/
│   │   ├── README.md           # 当天学习内容
│   │   ├── exercises/          # 部分天数会提供练习模板
│   │   └── solutions/          # 部分天数会提供参考答案
│   ├── day-02/
│   └── ...                     # Day 03 ~ Day 60
├── projects/                   # 里程碑项目代码预留目录，内容持续补充
├── cheatsheets/                # 速查手册
│   ├── sql-cheatsheet.md
│   ├── docker-cheatsheet.md
│   └── nodejs-cheatsheet.md
└── resources/
    └── recommended-reading.md  # 推荐阅读资源
```

---

## 每日学习时间建议

**工作日（3-4 小时）：**
- 📖 1.5 小时 — 阅读当天 README，理解核心知识点
- 💻 2 小时 — 完成实践练习，提交代码
- 📝 0.5 小时 — 整理学习笔记

**周末（4-6 小时）：**
- 🔨 3 小时 — 项目实战
- 📖 1.5 小时 — 扩展阅读，深入研究
- 📝 0.5 小时 — 复盘本周进度

---

## 贡献指南

欢迎贡献！你可以通过以下方式参与：

1. **报告问题** — 发现错误或过时内容？请提交 Issue
2. **改进内容** — 修复错误、补充知识点、优化代码示例
3. **翻译** — 帮助将教程翻译成其他语言
4. **分享** — Star ⭐ 这个仓库，分享给需要的人

如果你准备提交内容，欢迎先通过 Issue 或 PR 说明你想补充的部分，我们会逐步完善协作规范。

---

## 推荐资源

### 书籍
1. 《Designing Data-Intensive Applications》 — 系统设计圣经
2. 《SQL Antipatterns》 — 避免数据库设计常见错误
3. 《Web Scalability for Startup Engineers》 — 系统扩展性入门

### 在线资源
1. [NestJS 官方文档](https://docs.nestjs.com/) — 框架学习主资料
2. [Prisma 官方文档](https://www.prisma.io/docs) — ORM 学习资料
3. [PostgreSQL Tutorial](https://www.postgresqltutorial.com/) — SQL 练习
4. [ByteByteGo](https://bytebytego.com/) — 系统设计入门
5. [Docker 官方 Getting Started](https://docs.docker.com/get-started/) — 容器化入门

### 练习平台
1. [LeetCode Database](https://leetcode.com/problemset/database/) — SQL 练习
2. [HackerRank SQL](https://www.hackerrank.com/domains/sql) — SQL 巩固

---

## License

MIT，详见 [LICENSE](./LICENSE)。

---

<p align="center">如果这个教程对你有帮助，请给个 ⭐ Star 支持一下！</p>
