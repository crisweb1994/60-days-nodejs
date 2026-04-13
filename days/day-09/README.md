# Day 09 — 用原生 Node.js 构建 REST API（下）

## 📋 今日目标

- 实现中间件（Middleware）模式
- 添加错误处理中间件
- 完善 CORS 中间件
- 添加请求日志中间件
- 完成 TODO API 的完整功能

## 📖 核心知识点

### 1. 中间件模式原理

中间件（Middleware）是 Node.js 后端框架最核心的设计模式。它的本质是**函数组合**：

```
请求 → [中间件1] → [中间件2] → [中间件3] → [路由处理器] → 响应
```

每个中间件可以：
- 修改请求/响应对象
- 结束请求-响应循环
- 调用 `next()` 传递给下一个中间件

```javascript
// middleware.js

/**
 * 中间件引擎
 * 实现类似 Express 的 app.use() 机制
 */
export class MiddlewareEngine {
  constructor() {
    this.middlewares = [];
  }

  use(fn) {
    this.middlewares.push(fn);
  }

  async execute(req, res) {
    let index = 0;

    const next = async () => {
      if (index >= this.middlewares.length) return;
      const middleware = this.middlewares[index++];
      await middleware(req, res, next);
    };

    await next();
  }
}
```

### 2. 常用中间件实现

**请求日志中间件：**

```javascript
// middlewares/logger.js
export function logger() {
  return async (req, res, next) => {
    const start = Date.now();
    const { method, url } = req;

    // 劫持 res.end 来捕获状态码
    const originalEnd = res.end;
    res.end = function (...args) {
      const duration = Date.now() - start;
      const status = res.statusCode;
      const statusColor =
        status >= 500 ? '\x1b[31m' :  // 红色
        status >= 400 ? '\x1b[33m' :  // 黄色
        status >= 300 ? '\x1b[36m' :  // 青色
        '\x1b[32m';                    // 绿色

      console.log(
        `${statusColor}${status}\x1b[0m ${method} ${url} — ${duration}ms`
      );
      originalEnd.apply(this, args);
    };

    await next();
  };
}
```

**CORS 中间件：**

```javascript
// middlewares/cors.js
export function cors(options = {}) {
  const {
    origin = '*',
    methods = 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
    headers = 'Content-Type, Authorization',
    credentials = false,
    maxAge = 86400,
  } = options;

  return async (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
    res.setHeader('Access-Control-Max-Age', String(maxAge));

    if (credentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    // 预检请求直接返回
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    await next();
  };
}
```

**JSON 解析中间件：**

```javascript
// middlewares/json-parser.js
export function jsonParser(options = {}) {
  const { limit = 1024 * 1024 } = options; // 默认 1MB

  return async (req, res, next) => {
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        try {
          req.body = await readBody(req, limit);
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
      }
    }
    req.body = req.body || {};
    await next();
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('请求体超出大小限制'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('无效的 JSON 格式'));
      }
    });

    req.on('error', reject);
  });
}
```

**错误处理中间件：**

```javascript
// middlewares/error-handler.js
export function errorHandler() {
  return async (req, res, next) => {
    try {
      await next();
    } catch (error) {
      console.error('❌ 未捕获的错误:', error);

      const statusCode = error.statusCode || 500;
      const message = statusCode === 500
        ? '服务器内部错误'
        : error.message;

      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: message,
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
      }));
    }
  };
}

// 自定义业务错误类
export class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource = '资源') {
    super(`${resource}不存在`, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, 422);
  }
}
```

### 3. 完整的应用整合

```javascript
// app.js
import http from 'node:http';
import { Router } from './router.js';
import { MiddlewareEngine } from './middleware.js';
import { logger } from './middlewares/logger.js';
import { cors } from './middlewares/cors.js';
import { jsonParser } from './middlewares/json-parser.js';
import { errorHandler } from './middlewares/error-handler.js';
import { NotFoundError, ValidationError } from './middlewares/error-handler.js';

const app = new MiddlewareEngine();
const router = new Router();

// ============ 注册中间件（顺序很重要！）============
app.use(errorHandler());   // 最外层，捕获所有错误
app.use(logger());         // 请求日志
app.use(cors());           // CORS
app.use(jsonParser());     // JSON 解析

// ============ 路由中间件 ============
app.use(async (req, res, next) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const match = router.match(req.method, url.pathname);

  if (match) {
    req.params = match.params;
    req.query = Object.fromEntries(url.searchParams);
    await match.handler(req, res);
  } else {
    throw new NotFoundError(`路由 ${req.method} ${url.pathname}`);
  }
});

// ============ 数据 & 路由 ============
let todos = [];
let nextId = 1;

router.get('/api/todos', (req, res) => {
  const { page = '1', limit = '10', completed } = req.query;
  let filtered = [...todos];

  // 过滤
  if (completed !== undefined) {
    filtered = filtered.filter((t) => t.completed === (completed === 'true'));
  }

  // 分页
  const p = parseInt(page);
  const l = parseInt(limit);
  const start = (p - 1) * l;
  const paged = filtered.slice(start, start + l);

  sendJSON(res, 200, {
    data: paged,
    pagination: {
      page: p,
      limit: l,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / l),
    },
  });
});

router.post('/api/todos', (req, res) => {
  const { title, priority = 3 } = req.body;

  if (!title || title.trim().length === 0) {
    throw new ValidationError('title 不能为空');
  }
  if (title.length > 200) {
    throw new ValidationError('title 不能超过 200 个字符');
  }

  const todo = {
    id: nextId++,
    title: title.trim(),
    completed: false,
    priority: Math.min(5, Math.max(1, parseInt(priority))),
    createdAt: new Date().toISOString(),
  };
  todos.push(todo);
  sendJSON(res, 201, { data: todo });
});

// ... 其他路由类似

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

// ============ 启动服务器 ============
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => app.execute(req, res));
server.listen(PORT, () => {
  console.log(`🚀 服务器运行在 http://localhost:${PORT}`);
});
```

---

## 💻 实践练习

### 练习 1：完善 TODO API

基于 Day 08 的代码，加入以下功能：
- 分页查询（`?page=1&limit=10`）
- 按完成状态过滤（`?completed=true`）
- 按优先级排序（`?sort=priority&order=desc`）
- 模糊搜索（`?search=学习`）
- 批量删除（`DELETE /api/todos` + body 包含 id 数组）

### 练习 2：请求限流中间件

实现一个 Rate Limiting 中间件：

```javascript
// 同一 IP 在 1 分钟内最多请求 60 次
app.use(rateLimiter({ windowMs: 60000, max: 60 }));
```

**要求**：
- 基于客户端 IP 限流
- 超限时返回 429 状态码
- 响应头包含 `X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`

---

## ✅ 今日产出

- [ ] 实现了中间件引擎
- [ ] 实现了 logger/cors/jsonParser/errorHandler 中间件
- [ ] 理解中间件执行顺序和 next() 的作用
- [ ] 完成练习 1（完善 TODO API）
- [ ] 完成练习 2（Rate Limiting 中间件）
- [ ] 所有代码用 curl 测试通过

## 📚 延伸阅读

- [Express.js 中间件文档](https://expressjs.com/en/guide/using-middleware.html) — 理解你手写的和框架的对比
- [Koa.js 洋葱模型](https://koajs.com/) — 另一种中间件执行模型

---

[⬅️ Day 08 — 手写 REST API（上）](../day-08/) | [➡️ Day 10 — 迷你项目 Review](../day-10/)
