# Day 12 — RESTful API 设计原则

## 📋 今日目标

- 掌握 RESTful API 的设计规范
- 学习 API 版本化策略
- 设计标准化的请求/响应格式
- 用 OpenAPI/Swagger 编写 API 文档
- 设计博客系统的完整 API

## 📖 核心知识点

### 1. REST 核心原则

REST（Representational State Transfer）的核心是**以资源为中心**：

```
❌ 面向动作的 API（RPC 风格）
POST /getUsers
POST /createUser
POST /deleteUser?id=1

✅ 面向资源的 API（REST 风格）
GET    /users          获取用户列表
GET    /users/1        获取单个用户
POST   /users          创建用户
PUT    /users/1        更新用户
DELETE /users/1        删除用户
```

### 2. URL 命名规范

```
✅ 推荐
GET  /api/users                     用户列表
GET  /api/users/123                 单个用户
GET  /api/users/123/posts           用户的文章列表
GET  /api/users/123/posts/456       用户的某篇文章
POST /api/users/123/posts           为用户创建文章

❌ 避免
GET /api/getUsers                   不要用动词
GET /api/user/list                  用复数（users）
GET /api/Users                      用小写
GET /api/user_posts                 用连字符而非下划线
```

**命名规则**：
- 使用**复数名词**（users, posts, comments）
- 使用**小写**和**连字符**（`user-profiles` 而非 `userProfiles`）
- URL 表示资源关系层级（`users/123/posts`）
- 最多嵌套 2-3 层，过深的嵌套用查询参数替代

### 3. 统一响应格式

```typescript
// 成功响应
{
  "code": 0,
  "message": "success",
  "data": { /* 实际数据 */ }
}

// 列表响应（带分页）
{
  "code": 0,
  "message": "success",
  "data": [{ /* 项目 */ }],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}

// 错误响应
{
  "code": 40001,
  "message": "参数验证失败",
  "errors": [
    { "field": "email", "message": "邮箱格式不正确" },
    { "field": "password", "message": "密码长度不能少于 8 位" }
  ]
}
```

### 4. 查询参数设计

```
# 分页
GET /api/posts?page=2&limit=20

# 排序（多字段）
GET /api/posts?sort=-createdAt,title
# - 号表示降序

# 过滤
GET /api/posts?status=published&author=123

# 字段选择
GET /api/posts?fields=id,title,createdAt

# 搜索
GET /api/posts?search=Node.js

# 日期范围
GET /api/posts?createdAfter=2024-01-01&createdBefore=2024-12-31

# 组合使用
GET /api/posts?status=published&sort=-createdAt&page=1&limit=10&search=TypeScript
```

### 5. API 版本化

```
# 方式一：URL 路径（最常用，推荐）
GET /api/v1/users
GET /api/v2/users

# 方式二：请求头
GET /api/users
Accept: application/vnd.myapp.v2+json

# 方式三：查询参数
GET /api/users?version=2
```

### 6. OpenAPI 文档

```yaml
# openapi.yaml
openapi: 3.0.3
info:
  title: 博客系统 API
  description: 60 天学会 Node.js — 博客系统后端 API
  version: 1.0.0
servers:
  - url: http://localhost:3000/api/v1

paths:
  /posts:
    get:
      summary: 获取文章列表
      tags: [Posts]
      parameters:
        - name: page
          in: query
          schema: { type: integer, default: 1 }
        - name: limit
          in: query
          schema: { type: integer, default: 20 }
        - name: status
          in: query
          schema: { type: string, enum: [draft, published] }
      responses:
        '200':
          description: 成功
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PostListResponse'

    post:
      summary: 创建文章
      tags: [Posts]
      security:
        - bearerAuth: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreatePostRequest'
      responses:
        '201':
          description: 创建成功

components:
  schemas:
    Post:
      type: object
      properties:
        id: { type: integer }
        title: { type: string }
        content: { type: string }
        status: { type: string, enum: [draft, published] }
        createdAt: { type: string, format: date-time }

    CreatePostRequest:
      type: object
      required: [title, content]
      properties:
        title: { type: string, minLength: 1, maxLength: 200 }
        content: { type: string, minLength: 1 }
        tags: { type: array, items: { type: string } }

  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
```

---

## 💻 实践练习

### 练习：设计博客系统完整 API

设计以下资源的完整 CRUD API（写成 OpenAPI YAML 或 Markdown 文档）：

**资源**：
- 用户（Users）
- 文章（Posts）
- 评论（Comments）
- 标签（Tags）
- 点赞（Likes）

**要求**：
- 遵循 RESTful 命名规范
- 包含分页、排序、过滤
- 正确使用 HTTP 方法和状态码
- 定义请求体和响应体的结构
- 标注需要认证的接口

---

## ✅ 今日产出

- [ ] 掌握 RESTful API 设计规范
- [ ] 理解 API 版本化策略
- [ ] 设计完整的博客系统 API 文档
- [ ] 编写 OpenAPI/Swagger YAML 文件

## 📚 延伸阅读

- [RESTful API 设计最佳实践](https://restfulapi.net/)
- [OpenAPI 规范](https://swagger.io/specification/)
- [Microsoft REST API Guidelines](https://github.com/microsoft/api-guidelines)
- [Google API Design Guide](https://cloud.google.com/apis/design)

---

[⬅️ Day 11 — TypeScript 服务端](../day-11/) | [➡️ Day 13 — 进程管理与 Worker Threads](../day-13/)
