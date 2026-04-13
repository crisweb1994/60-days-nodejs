# Day 13 — 进程管理与 Worker Threads

## 📋 今日目标

- 理解 `child_process` 模块的四种创建方式
- 掌握 `worker_threads` 多线程编程
- 了解 `cluster` 模式的多进程部署
- 实现 CPU 密集型任务的高效处理

## 📖 核心知识点

### 1. 为什么需要多进程/多线程？

Node.js 的 JavaScript 代码运行在**单线程**上，这意味着：
- ✅ 对 I/O 密集型任务（网络请求、文件读写）表现优秀
- ❌ 对 CPU 密集型任务（图片处理、加密计算、数据压缩）会**阻塞事件循环**

解决方案有三种：

| 方案 | 适用场景 | 模块 |
|------|---------|------|
| 子进程 | 运行外部命令/脚本 | `child_process` |
| 工作线程 | JS 内的 CPU 密集计算 | `worker_threads` |
| 集群模式 | 多核 CPU 负载均衡 | `cluster` |

### 2. child_process — 子进程

```javascript
import { exec, execFile, spawn, fork } from 'node:child_process';

// exec — 执行 shell 命令（缓冲输出）
exec('ls -la', (error, stdout, stderr) => {
  if (error) return console.error(error);
  console.log(stdout);
});

// spawn — 流式输出（适合大量数据）
const ls = spawn('ls', ['-la']);
ls.stdout.on('data', (data) => console.log(data.toString()));
ls.stderr.on('data', (data) => console.error(data.toString()));
ls.on('close', (code) => console.log(`退出码: ${code}`));

// fork — 创建 Node.js 子进程（内置 IPC 通信）
// parent.js
const child = fork('./worker.js');
child.send({ type: 'start', data: [1, 2, 3, 4, 5] });
child.on('message', (result) => {
  console.log('子进程返回:', result);
});

// worker.js
process.on('message', (msg) => {
  if (msg.type === 'start') {
    const result = msg.data.reduce((a, b) => a + b, 0);
    process.send({ type: 'result', data: result });
  }
});
```

### 3. worker_threads — 工作线程

Worker Threads 是 Node.js 中实现真正多线程的方式：

```javascript
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (isMainThread) {
  // 主线程
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { start: 1, end: 1_000_000 }
  });

  worker.on('message', (result) => {
    console.log(`计算结果: ${result}`);
  });

  worker.on('error', (err) => console.error(err));
  worker.on('exit', (code) => console.log(`Worker 退出: ${code}`));
} else {
  // 工作线程
  const { start, end } = workerData;
  let sum = 0;
  for (let i = start; i <= end; i++) {
    sum += i;
  }
  parentPort.postMessage(sum);
}
```

**线程池模式（实用方案）：**

```javascript
import { Worker } from 'node:worker_threads';
import os from 'node:os';

class WorkerPool {
  constructor(workerScript, poolSize = os.cpus().length) {
    this.workerScript = workerScript;
    this.poolSize = poolSize;
    this.workers = [];
    this.taskQueue = [];

    for (let i = 0; i < poolSize; i++) {
      this.workers.push({ busy: false, worker: this._createWorker() });
    }
  }

  _createWorker() {
    const worker = new Worker(this.workerScript);
    return worker;
  }

  runTask(data) {
    return new Promise((resolve, reject) => {
      const freeWorker = this.workers.find(w => !w.busy);

      if (freeWorker) {
        this._executeTask(freeWorker, data, resolve, reject);
      } else {
        this.taskQueue.push({ data, resolve, reject });
      }
    });
  }

  _executeTask(workerEntry, data, resolve, reject) {
    workerEntry.busy = true;
    workerEntry.worker.postMessage(data);

    const onMessage = (result) => {
      workerEntry.busy = false;
      cleanup();
      resolve(result);
      this._processQueue();
    };

    const onError = (err) => {
      workerEntry.busy = false;
      cleanup();
      reject(err);
      this._processQueue();
    };

    const cleanup = () => {
      workerEntry.worker.removeListener('message', onMessage);
      workerEntry.worker.removeListener('error', onError);
    };

    workerEntry.worker.on('message', onMessage);
    workerEntry.worker.on('error', onError);
  }

  _processQueue() {
    if (this.taskQueue.length === 0) return;
    const freeWorker = this.workers.find(w => !w.busy);
    if (!freeWorker) return;
    const { data, resolve, reject } = this.taskQueue.shift();
    this._executeTask(freeWorker, data, resolve, reject);
  }

  destroy() {
    this.workers.forEach(w => w.worker.terminate());
  }
}
```

### 4. cluster — 集群模式

```javascript
import cluster from 'node:cluster';
import http from 'node:http';
import os from 'node:os';

const numCPUs = os.cpus().length;

if (cluster.isPrimary) {
  console.log(`主进程 ${process.pid} 启动`);
  console.log(`创建 ${numCPUs} 个工作进程...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code) => {
    console.log(`工作进程 ${worker.process.pid} 退出 (code: ${code})`);
    console.log('启动新的工作进程...');
    cluster.fork(); // 自动重启
  });
} else {
  http.createServer((req, res) => {
    res.end(`Hello from worker ${process.pid}\n`);
  }).listen(3000);

  console.log(`工作进程 ${process.pid} 启动`);
}
```

> 💡 生产环境通常使用 **PM2** 代替手写 cluster：`pm2 start app.js -i max`

---

## 💻 实践练习

### 练习 1：多线程密码哈希

使用 Worker Threads 实现一个密码批量哈希工具：
- 主线程读取用户列表
- 将哈希计算任务分发给 Worker 线程池
- 比较单线程 vs 多线程的性能差异

### 练习 2：图片缩略图生成器

使用 `child_process` 调用 ImageMagick 或 Sharp 批量处理图片：
- 支持并行处理多张图片
- 显示处理进度
- 限制最大并行数

---

## ✅ 今日产出

- [ ] 理解 child_process 四种创建方式的区别
- [ ] 掌握 worker_threads 的使用
- [ ] 了解 cluster 模式的原理
- [ ] 完成一个多线程处理方案

---

[⬅️ Day 12 — RESTful API 设计](../day-12/) | [➡️ Day 14 — 错误处理与调试](../day-14/)
