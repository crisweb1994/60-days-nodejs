# Day 07 — HTTP 协议基础

## 📋 今日目标

- 深入理解 HTTP 请求/响应模型
- 掌握状态码的正确语义
- 理解常用请求头和响应头
- 用 `node:http` 模块创建 HTTP 服务器

## 📖 核心知识点

### 1. HTTP 请求/响应模型

```
客户端（浏览器/App）                  服务器
    │                                 │
    │ ─── HTTP Request ──────────►    │
    │     Method: GET                 │
    │     URL: /api/users             │
    │     Headers: {...}              │
    │     Body: (可选)                │
    │                                 │
    │ ◄── HTTP Response ──────────    │
    │     Status: 200 OK              │
    │     Headers: {...}              │
    │     Body: [{...}, {...}]        │
    │                                 │
```

### 2. HTTP 方法的语义

| 方法 | 语义 | 幂等性 | 有请求体 | 典型用途 |
|------|------|--------|---------|---------|
| GET | 获取资源 | ✅ 是 | ❌ 不应有 | 获取列表/详情 |
| POST | 创建资源 | ❌ 否 | ✅ 有 | 创建新记录 |
| PUT | 全量替换 | ✅ 是 | ✅ 有 | 更新整个资源 |
| PATCH | 部分更新 | ❌ 否 | ✅ 有 | 更新部分字段 |
| DELETE | 删除资源 | ✅ 是 | ❌ 不应有 | 删除记录 |
| HEAD | 获取头信息 | ✅ 是 | ❌ 否 | 检查资源是否存在 |
| OPTIONS | 获取支持的方法 | ✅ 是 | ❌ 否 | CORS 预检请求 |

> **幂等性**：同一个请求执行多次，效果和执行一次相同。GET、PUT、DELETE 是幂等的。

### 3. 状态码详解

作为前端工程师，你可能只关注 200 和 500。作为全栈工程师，你需要精确使用每个状态码：

```
1xx — 信息性（很少直接使用）
  100 Continue         WebSocket 升级时用到

2xx — 成功
  200 OK               通用成功响应
  201 Created           资源创建成功（POST 成功后应返回 201，不是 200）
  204 No Content        成功但无返回体（DELETE 成功后常用）

3xx — 重定向
  301 Moved Permanently 永久重定向（SEO 用）
  302 Found             临时重定向
  304 Not Modified      缓存有效，无需重新传输
  307 Temporary Redirect 临时重定向（保持方法不变）

4xx — 客户端错误
  400 Bad Request       请求参数错误
  401 Unauthorized      未认证（需要登录）
  403 Forbidden         已认证但无权限（已登录但你不是管理员）
  404 Not Found         资源不存在
  405 Method Not Allowed 方法不允许（如对只读资源发 DELETE）
  409 Conflict          冲突（如用户名已存在）
  422 Unprocessable Entity 参数格式正确但语义错误
  429 Too Many Requests 请求频率超限（Rate Limiting）

5xx — 服务器错误
  500 Internal Server Error 服务器内部错误
  502 Bad Gateway           上游服务无响应
  503 Service Unavailable   服务暂时不可用
  504 Gateway Timeout       上游服务超时
```

**面试高频辨析：**
- **401 vs 403**：401 = "你谁啊？先登录"；403 = "我知道你是谁，但你没权限"
- **200 vs 201**：POST 创建资源成功应返回 201
- **PUT vs PATCH**：PUT 发送完整资源替换；PATCH 只发送要更新的字段

### 4. 常用请求头

```javascript
// 请求头
{
  'Content-Type': 'application/json',        // 请求体格式
  'Accept': 'application/json',              // 期望的响应格式
  'Authorization': 'Bearer <token>',         // 认证令牌
  'User-Agent': 'Mozilla/5.0 ...',           // 客户端标识
  'Accept-Language': 'zh-CN,en',             // 语言偏好
  'Cache-Control': 'no-cache',               // 缓存控制
  'If-None-Match': '"etag-value"',           // 条件请求（配合 304）
}

// 响应头
{
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=3600',   // 缓存 1 小时
  'ETag': '"abc123"',                        // 资源指纹
  'X-Request-Id': 'uuid-xxx',               // 请求追踪 ID
  'X-RateLimit-Limit': '100',               // 限流上限
  'X-RateLimit-Remaining': '95',            // 剩余次数
  'Access-Control-Allow-Origin': '*',        // CORS
}
```

### 5. CORS 完整机制

作为前端，你只知道"加个 header 就行"。作为后端，你需要理解完整机制：

```javascript
// CORS 简单请求 vs 预检请求

// 简单请求条件（以下全部满足）：
// - 方法是 GET/HEAD/POST
// - Content-Type 是 text/plain、multipart/form-data、application/x-www-form-urlencoded
// - 无自定义头

// 不满足以上条件 → 浏览器自动发送 OPTIONS 预检请求

// 完整的 CORS 处理
function handleCORS(req, res) {
  // 允许的源
  res.setHeader('Access-Control-Allow-Origin', 'https://your-frontend.com');
  // 允许携带 Cookie
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  // 允许的请求头
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // 允许的方法
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH');
  // 预检请求缓存时间
  res.setHeader('Access-Control-Max-Age', '86400');

  // 处理 OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true; // 已处理
  }
  return false;
}
```

### 6. 用原生 Node.js 创建 HTTP 服务器

```javascript
import http from 'node:http';

const server = http.createServer((req, res) => {
  // req: http.IncomingMessage（可读流）
  // res: http.ServerResponse（可写流）

  console.log(`${req.method} ${req.url}`);
  console.log('Headers:', req.headers);

  // 解析 URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log('Pathname:', url.pathname);
  console.log('Search Params:', url.searchParams);

  // 设置响应头
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Powered-By', 'Node.js');

  // 发送响应
  res.writeHead(200);
  res.end(JSON.stringify({
    message: 'Hello World',
    path: url.pathname,
    timestamp: new Date().toISOString(),
  }));
});

server.listen(3000, () => {
  console.log('🚀 服务器运行在 http://localhost:3000');
});
```

**解析 POST 请求体**：

```javascript
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(body);
      }
    });
    req.on('error', reject);
  });
}

// 使用
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST') {
    const body = await parseBody(req);
    console.log('Request body:', body);
  }
  res.end('OK');
});
```

---

## 💻 实践练习

### 练习 1：静态文件服务器

用原生 `node:http` 实现一个静态文件服务器：

```bash
node static-server.js ./public 8080
```

**要求**：
- 提供指定目录下的静态文件
- 正确设置 `Content-Type`（根据文件扩展名）
- 处理 404（文件不存在）
- 目录访问时自动查找 `index.html`
- 支持 `Range` 请求（用于视频播放）

### 练习 2：HTTP 请求日志中间件

实现一个请求日志函数，记录每个请求的：
- 方法、URL、状态码
- 响应时间（毫秒）
- 请求体大小
- 响应体大小

输出格式：`[2024-01-15T10:30:00] GET /api/users 200 45ms 0B → 1.2KB`

---

## ✅ 今日产出

- [ ] 能正确区分各种 HTTP 状态码的使用场景
- [ ] 理解 CORS 的完整流程
- [ ] 用原生 Node.js 创建 HTTP 服务器
- [ ] 完成练习 1（静态文件服务器）
- [ ] 完成练习 2（请求日志中间件）

## 📚 延伸阅读

- [MDN - HTTP](https://developer.mozilla.org/en-US/docs/Web/HTTP)
- [Node.js 官方文档 - HTTP](https://nodejs.org/docs/latest-v20.x/api/http.html)
- [HTTP 状态码完整列表](https://httpstatuses.com/)

---

[⬅️ Day 06 — 异步编程](../day-06/) | [➡️ Day 08 — 手写 REST API（上）](../day-08/)
