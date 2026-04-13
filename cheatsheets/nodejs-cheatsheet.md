# Node.js 速查手册

## process 对象

```javascript
process.version        // Node.js 版本
process.pid            // 进程 ID
process.cwd()          // 当前工作目录
process.env            // 环境变量
process.argv           // 命令行参数
process.exit(0)        // 退出进程
process.memoryUsage()  // 内存使用
process.uptime()       // 进程运行时间

// 标准 I/O
process.stdin          // 标准输入（可读流）
process.stdout         // 标准输出（可写流）
process.stderr         // 标准错误（可写流）

// 事件
process.on('exit', (code) => {})
process.on('uncaughtException', (err) => {})
process.on('unhandledRejection', (reason) => {})
process.on('SIGTERM', () => {})

// 调度
process.nextTick(fn)   // 微任务（最高优先级）
setImmediate(fn)       // Check 阶段
setTimeout(fn, 0)      // Timer 阶段
```

## 核心模块

```javascript
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
```

## 文件系统 (fs)

```javascript
// 读取
const data = await fs.readFile('./file.txt', 'utf-8');
const buffer = await fs.readFile('./image.png');

// 写入
await fs.writeFile('./output.txt', 'content');
await fs.appendFile('./log.txt', 'new line\n');

// 目录
await fs.mkdir('./dir', { recursive: true });
const files = await fs.readdir('./dir', { withFileTypes: true });
await fs.rm('./dir', { recursive: true, force: true });

// 信息
const stats = await fs.stat('./file.txt');
stats.isFile()       // true/false
stats.isDirectory()  // true/false
stats.size           // 字节

// 复制 / 重命名 / 删除
await fs.copyFile('./src', './dest');
await fs.rename('./old', './new');
await fs.unlink('./file.txt');
```

## 路径 (path)

```javascript
path.join('a', 'b', 'c')        // 'a/b/c'
path.resolve('src', 'index.js')  // 绝对路径
path.dirname('/a/b/c.txt')      // '/a/b'
path.basename('/a/b/c.txt')     // 'c.txt'
path.extname('/a/b/c.txt')      // '.txt'
path.parse('/a/b/c.txt')        // { root, dir, base, ext, name }
path.relative('/a/b', '/a/c/d') // '../c/d'
```

## HTTP 服务器

```javascript
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 读取请求体
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());

  // 发送响应
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ data: 'hello' }));
});

server.listen(3000);
```

## 事件循环优先级

```
同步代码 > process.nextTick > Promise.then > setTimeout(0) > setImmediate > I/O callbacks
```

## HTTP 状态码速查

```
200 OK           - 成功
201 Created      - 资源已创建（POST 成功）
204 No Content   - 成功，无返回体（DELETE 成功）
301 Permanent    - 永久重定向
304 Not Modified - 缓存有效
400 Bad Request  - 请求参数错误
401 Unauthorized - 未认证（需要登录）
403 Forbidden    - 无权限（已登录但权限不足）
404 Not Found    - 资源不存在
409 Conflict     - 资源冲突
422 Unprocessable- 参数格式正确但语义错误
429 Too Many     - 请求频率超限
500 Internal     - 服务器内部错误
502 Bad Gateway  - 上游无响应
503 Unavailable  - 服务暂时不可用
```

## 异步模式

```javascript
// 并行执行
const [a, b, c] = await Promise.all([taskA(), taskB(), taskC()]);

// 带容错的并行
const results = await Promise.allSettled([taskA(), taskB(), taskC()]);

// 并发限制
async function asyncPool(limit, items, fn) { /* ... */ }

// 重试
async function retry(fn, maxRetries, delay) { /* ... */ }

// 超时
const result = await Promise.race([task(), timeout(5000)]);
```
