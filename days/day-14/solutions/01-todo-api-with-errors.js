// Day 14 - 练习 1：为 TODO API 添加完整的错误处理
//
// 演示要点：
//   1. 分层的自定义错误体系（AppError → 业务子类）
//   2. 中间件级错误捕获（统一 JSON 响应）
//   3. 全局兜底：uncaughtException / unhandledRejection
//   4. 优雅退出：SIGTERM / SIGINT → server.close + 超时强制退出
//
// 启动：
//   node days/day-14/solutions/01-todo-api-with-errors.js
//   PORT=4000 NODE_ENV=development node ...
//
// 调试：
//   node --inspect-brk days/day-14/solutions/01-todo-api-with-errors.js
//   然后打开 chrome://inspect 或在 VS Code 中 attach（见文末 launch.json 说明）

'use strict';

const http = require('node:http');

// ─── 1. 自定义错误体系 ───────────────────────────────────────────────────────
//
// 所有"可预期"的业务错误都继承 AppError，区别于"不可预期"的系统错误。
// isOperational 用于全局兜底时判断是否需要让进程退出。

class AppError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(resource, id) {
    const msg = id != null ? `${resource} (id: ${id}) 不存在` : `${resource}不存在`;
    super(msg, 404, 'NOT_FOUND');
  }
}

class ValidationError extends AppError {
  constructor(errors) {
    super('请求参数验证失败', 422, 'VALIDATION_ERROR');
    this.errors = errors;
  }
}

class UnauthorizedError extends AppError {
  constructor(message = '请先登录') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = '无权访问') {
    super(message, 403, 'FORBIDDEN');
  }
}

class ConflictError extends AppError {
  constructor(message) {
    super(message, 409, 'CONFLICT');
  }
}

class BadRequestError extends AppError {
  constructor(message) {
    super(message, 400, 'BAD_REQUEST');
  }
}

// ─── 2. 极简日志器（同步控制台 + 结构化字段）──────────────────────────────────
// 真实项目中应替换为 pino / winston，或直接复用练习 2 的文件日志器。

const logger = {
  info: (msg, meta) => console.log(`ℹ️  [${new Date().toISOString()}] ${msg}`, meta ?? ''),
  warn: (msg, meta) => console.warn(`⚠️  [${new Date().toISOString()}] ${msg}`, meta ?? ''),
  error: (msg, meta) => console.error(`❌ [${new Date().toISOString()}] ${msg}`, meta ?? ''),
};

// ─── 3. 路由器 + 中间件引擎（沿用 Day 09/11 的风格）─────────────────────────

class Router {
  constructor() { this.routes = []; }
  get(p, h)    { this.routes.push({ method: 'GET',    path: p, handler: h }); }
  post(p, h)   { this.routes.push({ method: 'POST',   path: p, handler: h }); }
  put(p, h)    { this.routes.push({ method: 'PUT',    path: p, handler: h }); }
  patch(p, h)  { this.routes.push({ method: 'PATCH',  path: p, handler: h }); }
  delete(p, h) { this.routes.push({ method: 'DELETE', path: p, handler: h }); }

  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = matchPath(route.path, pathname);
      if (params) return { handler: route.handler, params };
    }
    return null;
  }
}

function matchPath(routePath, requestPath) {
  const a = routePath.split('/').filter(Boolean);
  const b = requestPath.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = b[i];
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

class App {
  constructor() { this.middlewares = []; }
  use(fn) { this.middlewares.push(fn); }
  async run(req, res) {
    let i = 0;
    const next = async () => {
      if (i >= this.middlewares.length) return;
      const fn = this.middlewares[i++];
      await fn(req, res, next);
    };
    await next();
  }
}

// ─── 4. 中间件 ───────────────────────────────────────────────────────────────

// 4.1 错误处理中间件：必须放在最外层（最先 use），用 try/catch 兜住下游 await next()
function errorHandler() {
  return async (req, res, next) => {
    try {
      await next();
    } catch (error) {
      const isApp = error instanceof AppError;
      const status = isApp ? error.statusCode : 500;

      // 业务错误打 warn，系统错误打 error 并带 stack
      if (isApp) {
        logger.warn(`${error.code} ${req.method} ${req.url}`, { message: error.message });
      } else {
        logger.error(`UNHANDLED ${req.method} ${req.url}`, { message: error.message, stack: error.stack });
      }

      if (res.headersSent) {
        // 头已发：只能粗暴销毁连接，避免响应错乱
        res.destroy(error);
        return;
      }

      const payload = {
        error: {
          code: isApp ? error.code : 'INTERNAL_ERROR',
          message: isApp ? error.message : '服务器内部错误',
        },
      };
      if (error instanceof ValidationError) payload.error.details = error.errors;
      if (process.env.NODE_ENV === 'development' && !isApp) payload.error.stack = error.stack;

      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    }
  };
}

// 4.2 请求日志
function accessLog() {
  return async (req, res, next) => {
    const start = Date.now();
    res.once('finish', () => {
      const dur = Date.now() - start;
      const tag = res.statusCode >= 500 ? '🔴' : res.statusCode >= 400 ? '🟡' : '🟢';
      console.log(`${tag} ${res.statusCode} ${req.method} ${req.url} — ${dur}ms`);
    });
    await next();
  };
}

// 4.3 JSON body 解析（错误用 BadRequestError 抛出，由 errorHandler 接管）
function jsonParser({ limit = 1024 * 1024 } = {}) {
  return async (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > limit) throw new BadRequestError('请求体超出大小限制');
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks).toString();
        if (raw) {
          try { req.body = JSON.parse(raw); }
          catch { throw new BadRequestError('无效的 JSON 格式'); }
        } else {
          req.body = {};
        }
      }
    }
    if (req.body === undefined) req.body = {};
    await next();
  };
}

// ─── 5. 校验函数（抛 ValidationError）────────────────────────────────────────

function validateCreateTodo(body) {
  const errors = [];
  if (!body || typeof body !== 'object') errors.push({ field: 'body', message: '请求体必须是 JSON 对象' });
  else {
    if (typeof body.title !== 'string' || body.title.trim() === '') {
      errors.push({ field: 'title', message: 'title 必须是非空字符串' });
    }
    if (body.priority !== undefined && (typeof body.priority !== 'number' || body.priority < 1 || body.priority > 5)) {
      errors.push({ field: 'priority', message: 'priority 必须是 1-5 之间的数字' });
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return { title: body.title.trim(), priority: body.priority };
}

function validateUpdateTodo(body) {
  const errors = [];
  if (!body || typeof body !== 'object') errors.push({ field: 'body', message: '请求体必须是 JSON 对象' });
  else {
    if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() === '')) {
      errors.push({ field: 'title', message: 'title 必须是非空字符串' });
    }
    if (body.completed !== undefined && typeof body.completed !== 'boolean') {
      errors.push({ field: 'completed', message: 'completed 必须是布尔值' });
    }
    if (body.priority !== undefined && (typeof body.priority !== 'number' || body.priority < 1 || body.priority > 5)) {
      errors.push({ field: 'priority', message: 'priority 必须是 1-5 之间的数字' });
    }
  }
  if (errors.length) throw new ValidationError(errors);
  return body;
}

// ─── 6. 数据 + 路由 ──────────────────────────────────────────────────────────

let todos = [
  { id: 1, title: '学习错误处理', completed: false, priority: 3, createdAt: new Date().toISOString() },
  { id: 2, title: '配置 VS Code 调试', completed: false, priority: 2, createdAt: new Date().toISOString() },
];
let nextId = 3;

const router = new Router();

router.get('/api/todos', (req, res) => {
  sendJSON(res, 200, { data: todos });
});

router.get('/api/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const todo = todos.find(t => t.id === id);
  if (!todo) throw new NotFoundError('TODO', req.params.id);
  sendJSON(res, 200, { data: todo });
});

router.post('/api/todos', (req, res) => {
  const input = validateCreateTodo(req.body);
  if (todos.some(t => t.title === input.title)) {
    throw new ConflictError(`标题为 "${input.title}" 的 TODO 已存在`);
  }
  const todo = {
    id: nextId++,
    title: input.title,
    completed: false,
    priority: input.priority ?? 3,
    createdAt: new Date().toISOString(),
  };
  todos.push(todo);
  sendJSON(res, 201, { data: todo });
});

router.patch('/api/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const todo = todos.find(t => t.id === id);
  if (!todo) throw new NotFoundError('TODO', req.params.id);
  const input = validateUpdateTodo(req.body);
  if (input.title !== undefined) todo.title = input.title.trim();
  if (input.completed !== undefined) todo.completed = input.completed;
  if (input.priority !== undefined) todo.priority = input.priority;
  todo.updatedAt = new Date().toISOString();
  sendJSON(res, 200, { data: todo });
});

router.delete('/api/todos/:id', (req, res) => {
  const id = Number(req.params.id);
  const idx = todos.findIndex(t => t.id === id);
  if (idx === -1) throw new NotFoundError('TODO', req.params.id);
  todos.splice(idx, 1);
  res.writeHead(204).end();
});

// 故意制造一个错误的接口，方便手动测试全局兜底
router.get('/api/boom', () => {
  throw new Error('💣 故意抛出的同步异常');
});

router.get('/api/async-boom', async () => {
  await new Promise(r => setTimeout(r, 10));
  throw new Error('💣 故意抛出的异步异常');
});

// ─── 7. 组装应用 ─────────────────────────────────────────────────────────────

const app = new App();
app.use(errorHandler());
app.use(accessLog());
app.use(jsonParser());
app.use(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const found = router.match(req.method, url.pathname);
  if (!found) throw new NotFoundError(`路由 ${req.method} ${url.pathname}`);
  req.params = found.params;
  req.query = Object.fromEntries(url.searchParams);
  await found.handler(req, res);
});

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

// ─── 8. 服务器 + 全局错误兜底 + Graceful Shutdown ──────────────────────────

const PORT = Number(process.env.PORT) || 3000;
const server = http.createServer((req, res) => {
  app.run(req, res).catch(err => {
    // 双保险：errorHandler 已经吃掉错误了，这里只是兜底
    logger.error('app.run rejected', { message: err?.message, stack: err?.stack });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: '服务器内部错误' } }));
    }
  });
});

server.listen(PORT, () => {
  logger.info(`🚀 服务器运行在 http://localhost:${PORT}`);
  console.log('');
  console.log('可用接口:');
  console.log('  GET    /api/todos');
  console.log('  GET    /api/todos/:id');
  console.log('  POST   /api/todos          body: { "title": "xxx", "priority": 1-5 }');
  console.log('  PATCH  /api/todos/:id      body: { ... }');
  console.log('  DELETE /api/todos/:id');
  console.log('  GET    /api/boom           — 测试同步异常');
  console.log('  GET    /api/async-boom     — 测试异步异常');
  console.log('');
  console.log('调试: node --inspect-brk days/day-14/solutions/01-todo-api-with-errors.js');
});

// 8.1 未捕获的同步异常：进程状态已不可信，记录后必须退出
process.on('uncaughtException', (err) => {
  logger.error('💀 uncaughtException', { message: err.message, stack: err.stack });
  // 给日志一点时间刷盘，再退出
  shutdown(1, 'uncaughtException');
});

// 8.2 未处理的 Promise rejection：Node v15+ 默认会把进程崩溃
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('💀 unhandledRejection', { message: err.message, stack: err.stack });
  shutdown(1, 'unhandledRejection');
});

// 8.3 优雅退出：收到信号后停止接收新连接，等现有请求处理完
let shuttingDown = false;
function shutdown(code, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${reason}，开始优雅退出...`);

  server.close((err) => {
    if (err) {
      logger.error('server.close 失败', { message: err.message });
      process.exit(1);
    }
    logger.info('✅ 服务器已关闭，进程退出');
    process.exit(code);
  });

  // 兜底：10 秒内还没退完，强制 kill
  setTimeout(() => {
    logger.error('⏰ 优雅退出超时，强制退出');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT',  () => shutdown(0, 'SIGINT'));

// ─── 附：VS Code launch.json 配置 ────────────────────────────────────────────
//
// {
//   "version": "0.2.0",
//   "configurations": [
//     {
//       "name": "Debug Day14 TODO API",
//       "type": "node",
//       "request": "launch",
//       "program": "${workspaceFolder}/days/day-14/solutions/01-todo-api-with-errors.js",
//       "console": "integratedTerminal",
//       "skipFiles": ["<node_internals>/**", "**\/node_modules/**"],
//       "env": { "NODE_ENV": "development", "PORT": "3000" }
//     },
//     {
//       "name": "Attach to Node",
//       "type": "node",
//       "request": "attach",
//       "port": 9229,
//       "skipFiles": ["<node_internals>/**", "**\/node_modules/**"]
//     }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────
