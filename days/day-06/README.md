# Day 06 — 异步编程模式

## 📋 今日目标

- 回顾 Callback → Promise → async/await 的演进
- 掌握 Promise 的高级用法和错误处理
- 实现一个并发任务调度器
- 理解异步编程的常见陷阱

## 📖 核心知识点

### 1. 回调地狱（Callback Hell）

这是 Node.js 早期代码的典型问题：

```javascript
// ❌ 回调地狱
fs.readFile('./config.json', (err, data) => {
  if (err) return console.error(err);
  const config = JSON.parse(data);
  db.connect(config.database, (err, connection) => {
    if (err) return console.error(err);
    connection.query('SELECT * FROM users', (err, users) => {
      if (err) return console.error(err);
      users.forEach((user) => {
        sendEmail(user.email, 'Welcome!', (err) => {
          if (err) return console.error(err);
          console.log(`Email sent to ${user.email}`);
        });
      });
    });
  });
});
```

### 2. Promise 基础与进阶

```javascript
// Promise 创建
const fetchUser = (id) => {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (id > 0) {
        resolve({ id, name: `User ${id}` });
      } else {
        reject(new Error('Invalid user ID'));
      }
    }, 100);
  });
};

// 链式调用
fetchUser(1)
  .then((user) => fetchUserPosts(user.id))
  .then((posts) => console.log(posts))
  .catch((err) => console.error(err))
  .finally(() => console.log('完成'));
```

**Promise 并发控制方法对比：**

```javascript
const tasks = [
  fetchUser(1),
  fetchUser(2),
  fetchUser(3),
];

// Promise.all — 全部成功才返回，一个失败全部失败
const results = await Promise.all(tasks);
// ✅ [user1, user2, user3]
// ❌ 如果任何一个失败，整体 reject

// Promise.allSettled — 等待全部完成（不管成功失败）
const results = await Promise.allSettled(tasks);
// [
//   { status: 'fulfilled', value: user1 },
//   { status: 'fulfilled', value: user2 },
//   { status: 'rejected', reason: Error }
// ]

// Promise.race — 返回最先完成的（成功或失败）
const fastest = await Promise.race(tasks);

// Promise.any — 返回最先成功的，全部失败才 reject
const firstSuccess = await Promise.any(tasks);
```

### 3. async/await 最佳实践

```javascript
// ✅ 正确的错误处理
async function processOrder(orderId) {
  try {
    const order = await fetchOrder(orderId);
    const payment = await processPayment(order);
    const notification = await sendNotification(order.userId);
    return { order, payment, notification };
  } catch (error) {
    // 区分不同类型的错误
    if (error instanceof PaymentError) {
      await refund(orderId);
      throw new Error(`支付失败: ${error.message}`);
    }
    throw error; // 其他错误继续向上抛
  }
}

// ✅ 并行执行不相互依赖的任务
async function loadDashboard(userId) {
  // ❌ 串行 — 慢！
  const profile = await fetchProfile(userId);
  const posts = await fetchPosts(userId);
  const notifications = await fetchNotifications(userId);

  // ✅ 并行 — 快！
  const [profile, posts, notifications] = await Promise.all([
    fetchProfile(userId),
    fetchPosts(userId),
    fetchNotifications(userId),
  ]);

  return { profile, posts, notifications };
}
```

### 4. 并发限制

在实际场景中，经常需要限制并发数（比如同时最多发 5 个 HTTP 请求）：

```javascript
/**
 * 并发限制器
 * @param {number} limit 最大并发数
 * @param {Array} items 要处理的数据
 * @param {Function} fn 异步处理函数
 */
async function asyncPool(limit, items, fn) {
  const results = [];
  const executing = new Set();

  for (const [index, item] of items.entries()) {
    const promise = fn(item, index).then((result) => {
      executing.delete(promise);
      return result;
    });

    results.push(promise);
    executing.add(promise);

    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }

  return Promise.all(results);
}

// 使用示例：同时最多 3 个下载任务
const urls = Array.from({ length: 20 }, (_, i) => `https://api.example.com/data/${i}`);

const results = await asyncPool(3, urls, async (url) => {
  const response = await fetch(url);
  return response.json();
});
```

### 5. 异步迭代器（for await...of）

```javascript
import fs from 'node:fs';
import readline from 'node:readline';

// 逐行读取文件（内存友好）
const rl = readline.createInterface({
  input: fs.createReadStream('./large-file.log'),
  crlfDelay: Infinity,
});

for await (const line of rl) {
  console.log(line);
}

// 自定义异步迭代器
async function* generateNumbers(max) {
  for (let i = 0; i < max; i++) {
    await new Promise((r) => setTimeout(r, 100));
    yield i;
  }
}

for await (const num of generateNumbers(5)) {
  console.log(num); // 0, 1, 2, 3, 4（每 100ms 一个）
}
```

### 6. 常见异步陷阱

```javascript
// ❌ 陷阱 1：forEach 中使用 async/await 不会等待
const files = ['a.txt', 'b.txt', 'c.txt'];
files.forEach(async (file) => {
  const content = await fs.promises.readFile(file, 'utf-8');
  console.log(content); // 不会按顺序执行！
});
console.log('done'); // 这行会在所有文件读取前执行

// ✅ 正确：使用 for...of
for (const file of files) {
  const content = await fs.promises.readFile(file, 'utf-8');
  console.log(content);
}

// ❌ 陷阱 2：忘记 await
async function bad() {
  const promise = fetchData(); // 没有 await！
  console.log(promise);        // Promise { <pending> }
}

// ❌ 陷阱 3：Promise 未捕获的 rejection
fetchData().then(console.log);
// 如果 fetchData reject，没有 .catch 会导致 UnhandledPromiseRejection

// ✅ 全局兜底（仅用于记录日志，不要依赖它处理错误）
process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise rejection:', reason);
});
```

---

## 💻 实践练习

### 练习 1：并发任务调度器

实现一个 `TaskScheduler` 类：

```javascript
const scheduler = new TaskScheduler(3); // 最大并发数 3

scheduler.addTask(async () => { /* 任务 1 */ });
scheduler.addTask(async () => { /* 任务 2 */ });
// ... 添加 10 个任务

const results = await scheduler.run();
// 同一时刻最多只有 3 个任务在执行
```

**要求**：
- 支持设置最大并发数
- 返回所有任务的结果（类似 `Promise.allSettled`）
- 提供进度事件（继承 EventEmitter）
- 支持任务优先级

### 练习 2：Promise 超时包装器

实现一个 `withTimeout` 函数：

```javascript
const result = await withTimeout(fetchData(), 5000);
// 如果 fetchData 在 5 秒内完成，返回结果
// 否则抛出 TimeoutError

const result = await withTimeout(fetchData(), 5000, '默认值');
// 超时时返回默认值而非抛错
```

### 练习 3：重试机制

实现一个 `retry` 函数：

```javascript
const data = await retry(
  () => fetchUnstableAPI(),
  {
    maxRetries: 3,
    delay: 1000,         // 初始延迟 1 秒
    backoff: 'exponential', // 指数退避：1s, 2s, 4s
    onRetry: (error, attempt) => {
      console.log(`第 ${attempt} 次重试，错误: ${error.message}`);
    },
  }
);
```

---

## ✅ 今日产出

- [ ] 掌握 Promise.all/allSettled/race/any 的使用场景
- [ ] 理解 async/await 的常见陷阱
- [ ] 完成练习 1（并发任务调度器）
- [ ] 完成练习 2（Promise 超时包装器）
- [ ] 完成练习 3（重试机制）

## 📚 延伸阅读

- [MDN - Using Promises](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises)
- [JavaScript.info - Async/Await](https://javascript.info/async-await)
- [Node.js 官方文档 - Timers Promises API](https://nodejs.org/docs/latest-v20.x/api/timers.html#timers-promises-api)

---

[⬅️ Day 05 — 事件循环](../day-05/) | [➡️ Day 07 — HTTP 协议基础](../day-07/)
