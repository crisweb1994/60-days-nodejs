# Day 05 — 事件循环深度解析

## 📋 今日目标

- 彻底理解 Node.js 事件循环的六个阶段
- 搞清 `setTimeout` vs `setImmediate` vs `process.nextTick` 的执行顺序
- 理解 libuv 和 I/O 多路复用
- 明白"Node.js 是单线程但能处理高并发"的真正含义

## 📖 核心知识点

### 1. 前端vs后端：事件循环的差异

你在前端已经理解了"宏任务和微任务"的概念，但**Node.js 的事件循环比浏览器更复杂**。

**浏览器事件循环**（你熟悉的）：
```
宏任务 → 清空微任务队列 → 渲染 → 宏任务 → ...
```

**Node.js 事件循环**（今天要学的）：
```
六个阶段循环执行，每个阶段之间清空微任务队列
```

### 2. Node.js 事件循环的六个阶段

```
   ┌───────────────────────────┐
┌─>│         timers             │ ← setTimeout / setInterval 回调
│  └──────────┬────────────────┘
│  ┌──────────┴────────────────┐
│  │     pending callbacks     │ ← 系统级回调（TCP 错误等）
│  └──────────┬────────────────┘
│  ┌──────────┴────────────────┐
│  │       idle, prepare       │ ← 仅内部使用
│  └──────────┬────────────────┘
│  ┌──────────┴────────────────┐
│  │          poll              │ ← I/O 回调（文件读取、网络请求等）
│  └──────────┬────────────────┘
│  ┌──────────┴────────────────┐
│  │         check             │ ← setImmediate 回调
│  └──────────┬────────────────┘
│  ┌──────────┴────────────────┐
│  │     close callbacks       │ ← socket.on('close', ...) 等
│  └──────────┬────────────────┘
│             │
└─────────────┘
```

**每个阶段的关键**：

1. **Timers**：执行 `setTimeout` 和 `setInterval` 到期的回调
2. **Pending Callbacks**：执行推迟到下一轮的系统级回调
3. **Idle/Prepare**：内部使用，你不需要关心
4. **Poll**：核心阶段！获取新的 I/O 事件，执行 I/O 相关回调
5. **Check**：执行 `setImmediate` 回调
6. **Close Callbacks**：执行关闭事件的回调

**微任务在阶段之间执行**：

```
Timer 阶段 → [清空微任务] → Pending 阶段 → [清空微任务] → ... → Check 阶段 → [清空微任务] → ...
```

### 3. process.nextTick vs setImmediate vs setTimeout

这是面试最高频的问题之一：

```javascript
// 测试 1：在主模块中
console.log('1. 同步代码');

setTimeout(() => console.log('2. setTimeout'), 0);
setImmediate(() => console.log('3. setImmediate'));
process.nextTick(() => console.log('4. nextTick'));
Promise.resolve().then(() => console.log('5. Promise'));

console.log('6. 同步代码');

// 输出顺序（确定的）：
// 1. 同步代码
// 6. 同步代码
// 4. nextTick         ← 微任务，优先级最高
// 5. Promise          ← 微任务
// 2. setTimeout       ← 可能在 setImmediate 前或后
// 3. setImmediate     ← 可能在 setTimeout 前或后
```

> ⚠️ 在主模块中，`setTimeout(fn, 0)` 和 `setImmediate` 的顺序不确定。
> 但在 I/O 回调中，`setImmediate` **总是先于** `setTimeout`。

```javascript
// 测试 2：在 I/O 回调中（顺序确定！）
import fs from 'node:fs';

fs.readFile('./package.json', () => {
  setTimeout(() => console.log('setTimeout'), 0);
  setImmediate(() => console.log('setImmediate'));
});

// 输出顺序（始终确定）：
// setImmediate    ← I/O 回调在 poll 阶段执行，下一个阶段是 check
// setTimeout      ← check 之后回到 timer
```

**优先级总结：**

```
同步代码 > process.nextTick > Promise.then > setTimeout/setInterval > setImmediate > I/O
```

### 4. process.nextTick 的特殊性

`process.nextTick` 不属于事件循环的任何阶段。它在**当前操作完成后、事件循环继续之前**立即执行：

```javascript
// nextTick 递归可能阻塞事件循环！
function recursiveNextTick(count = 0) {
  if (count < 5) {
    process.nextTick(() => {
      console.log(`nextTick ${count}`);
      recursiveNextTick(count + 1);
    });
  }
}

recursiveNextTick();
setImmediate(() => console.log('setImmediate'));

// 输出：先执行所有 nextTick，然后才轮到 setImmediate
// nextTick 0
// nextTick 1
// nextTick 2
// nextTick 3
// nextTick 4
// setImmediate

// ⚠️ 如果 nextTick 递归不终止，setImmediate 永远不会执行！
// 这就是"nextTick 饥饿"（starvation）问题
```

**最佳实践**：
- `process.nextTick`：用于在当前操作后立即执行（如确保回调异步化）
- `setImmediate`：用于不需要立即执行的异步操作（更安全）

### 5. libuv 与 I/O 多路复用

Node.js 的异步 I/O 能力来自 **libuv** 库：

```
┌─────────────────────────┐
│      Node.js 应用代码     │   ← JavaScript（单线程）
├─────────────────────────┤
│        V8 引擎           │   ← 编译和执行 JS
├─────────────────────────┤
│    Node.js C++ Bindings  │   ← JS 与 C++ 的桥梁
├─────────────────────────┤
│         libuv            │   ← 异步 I/O 库
│  ┌───────┬──────────┐   │
│  │ 事件循环 │ 线程池(4) │   │   ← I/O 多路复用 + 工作线程
│  └───────┴──────────┘   │
├─────────────────────────┤
│    操作系统（epoll/kqueue) │   ← 内核级 I/O
└─────────────────────────┘
```

**为什么单线程能处理高并发？**

关键在于 **I/O 多路复用**（epoll/kqueue/IOCP）：

1. Node.js 不为每个连接创建线程（不像传统 Java/PHP）
2. 所有网络 I/O 由操作系统内核异步处理
3. libuv 通过 epoll（Linux）/ kqueue（macOS）监听多个 I/O 事件
4. 当 I/O 完成时，内核通知 libuv，libuv 触发 JS 回调
5. CPU 密集型任务使用 libuv 的线程池（默认 4 个线程）

```javascript
// 这就是为什么 Node.js 能同时处理数千个连接
import http from 'node:http';

const server = http.createServer((req, res) => {
  // 每个请求不会创建新线程
  // 而是注册在事件循环中，等 I/O 完成后执行回调
  res.end('Hello!');
});

server.listen(3000);
// 单个 Node.js 进程就能处理 10,000+ 并发连接
```

### 6. 阻塞事件循环的危险

```javascript
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.url === '/slow') {
    // ❌ 糟糕！这会阻塞事件循环
    // 在这 5 秒内，所有其他请求都无法处理
    const start = Date.now();
    while (Date.now() - start < 5000) {}
    res.end('慢请求完成');
  } else {
    res.end('快速响应');
  }
});

server.listen(3000);

// 当 /slow 在执行时，即使访问 / 也会等待
// 这就是为什么 Node.js 中不能有 CPU 密集型同步操作
```

**解决方案**：
- 使用 `worker_threads`（Day 13 详解）
- 将 CPU 密集型任务交给独立服务
- 使用流式处理替代一次性大量计算

---

## 💻 实践练习

### 练习 1：事件循环顺序预测

预测以下代码的输出顺序，然后运行验证：

```javascript
console.log('start');

setTimeout(() => console.log('timeout1'), 0);
setTimeout(() => console.log('timeout2'), 0);

Promise.resolve()
  .then(() => {
    console.log('promise1');
    process.nextTick(() => console.log('nextTick inside promise'));
  })
  .then(() => console.log('promise2'));

process.nextTick(() => console.log('nextTick1'));
process.nextTick(() => {
  console.log('nextTick2');
  process.nextTick(() => console.log('nextTick3'));
});

setImmediate(() => console.log('immediate1'));
setImmediate(() => {
  console.log('immediate2');
  process.nextTick(() => console.log('nextTick inside immediate'));
  Promise.resolve().then(() => console.log('promise inside immediate'));
});

console.log('end');
```

### 练习 2：事件循环可视化工具

编写一个 `event-loop-visualizer.js`，用定时追踪的方式可视化事件循环的执行过程：

```javascript
// 注册不同阶段的回调，用带时间戳的日志输出执行顺序
// 展示微任务如何在阶段之间执行
```

### 练习 3：阻塞检测器

编写一个工具函数，检测事件循环是否被阻塞：

```javascript
function createBlockDetector(thresholdMs = 100) {
  // 用 setInterval 检测
  // 如果两次回调间隔超过 thresholdMs，说明事件循环被阻塞
  // 报告阻塞持续时间
}
```

---

## ✅ 今日产出

- [ ] 能画出 Node.js 事件循环的六个阶段图
- [ ] 能正确预测 nextTick/Promise/setTimeout/setImmediate 的执行顺序
- [ ] 理解 libuv 和 I/O 多路复用的原理
- [ ] 完成练习 1（顺序预测）
- [ ] 完成练习 2（事件循环可视化）
- [ ] 完成练习 3（阻塞检测器）

## 📚 延伸阅读

- [Node.js 官方文档 - The Node.js Event Loop](https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick)
- [libuv 官方文档](https://docs.libuv.org/en/v1.x/)
- [What the heck is the event loop anyway? (视频)](https://www.youtube.com/watch?v=8aGhZQkoFbQ) — 经典的事件循环讲解
- [Don't Block the Event Loop (Node.js Guide)](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop)

---

[⬅️ Day 04 — 核心模块（下）](../day-04/) | [➡️ Day 06 — 异步编程模式](../day-06/)
