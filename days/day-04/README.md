# Day 04 — Node.js 核心模块（下）：events、stream、Buffer

## 📋 今日目标

- 理解 EventEmitter 事件驱动编程模型
- 掌握 Buffer 处理二进制数据
- 理解 Stream 流式处理的核心概念
- 用流实现大文件的高效处理

## 📖 核心知识点

### 1. EventEmitter — 事件驱动编程

Node.js 的核心设计哲学是**事件驱动**。`EventEmitter` 是 Node.js 中大量核心模块的基类（如 `http.Server`、`fs.ReadStream` 等）。

```javascript
import { EventEmitter } from 'node:events';

const emitter = new EventEmitter();

// 注册事件监听器
emitter.on('greet', (name) => {
  console.log(`Hello, ${name}!`);
});

// 一次性监听（只触发一次）
emitter.once('init', () => {
  console.log('初始化完成');
});

// 触发事件
emitter.emit('greet', 'Node.js');  // Hello, Node.js!
emitter.emit('init');               // 初始化完成
emitter.emit('init');               // （不会再输出）
```

**实际应用 — 自定义事件类：**

```javascript
import { EventEmitter } from 'node:events';

class TaskRunner extends EventEmitter {
  constructor(tasks) {
    super();
    this.tasks = tasks;
    this.completed = 0;
  }

  async run() {
    this.emit('start', { total: this.tasks.length });

    for (const task of this.tasks) {
      try {
        this.emit('taskStart', { name: task.name });
        await task.execute();
        this.completed++;
        this.emit('taskComplete', {
          name: task.name,
          progress: this.completed / this.tasks.length,
        });
      } catch (error) {
        this.emit('taskError', { name: task.name, error });
      }
    }

    this.emit('finish', { total: this.tasks.length, completed: this.completed });
  }
}

// 使用
const runner = new TaskRunner([
  { name: '下载数据', execute: () => new Promise(r => setTimeout(r, 1000)) },
  { name: '处理数据', execute: () => new Promise(r => setTimeout(r, 500)) },
  { name: '保存结果', execute: () => new Promise(r => setTimeout(r, 300)) },
]);

runner.on('start', ({ total }) => console.log(`开始执行 ${total} 个任务`));
runner.on('taskComplete', ({ name, progress }) => {
  console.log(`✅ ${name} — ${(progress * 100).toFixed(0)}%`);
});
runner.on('finish', ({ total, completed }) => {
  console.log(`🎉 完成 ${completed}/${total} 个任务`);
});

await runner.run();
```

**EventEmitter 常用方法：**

```javascript
emitter.on(event, fn)        // 注册监听器
emitter.once(event, fn)      // 一次性监听器
emitter.off(event, fn)       // 移除监听器（需传入同一函数引用）
emitter.removeAllListeners() // 移除所有监听器
emitter.listenerCount(event) // 获取监听器数量
emitter.eventNames()         // 获取所有事件名
```

### 2. Buffer — 二进制数据处理

Buffer 是 Node.js 处理二进制数据的核心类。在前端你很少接触二进制数据，但在服务端（文件、网络、加密）中非常常见。

```javascript
// 创建 Buffer
const buf1 = Buffer.alloc(10);              // 10 字节，填充 0
const buf2 = Buffer.from('Hello');           // 从字符串创建
const buf3 = Buffer.from([0x48, 0x69]);      // 从字节数组创建
const buf4 = Buffer.from('你好', 'utf-8');    // 指定编码

// Buffer 与字符串互转
const buf = Buffer.from('Node.js is awesome');
console.log(buf.toString('utf-8'));     // 'Node.js is awesome'
console.log(buf.toString('base64'));    // 'Tm9kZS5qcyBpcyBhd2Vzb21l'
console.log(buf.toString('hex'));       // '4e6f64652e6a7320...'

// Buffer 操作
console.log(buf.length);               // 字节长度（非字符长度！）
console.log(buf.slice(0, 7).toString()); // 'Node.js'

// 编码注意事项
const chinese = Buffer.from('你好世界');
console.log(chinese.length);           // 12（UTF-8 中每个中文 3 字节）
console.log('你好世界'.length);         // 4（字符长度）

// Buffer 拼接
const combined = Buffer.concat([
  Buffer.from('Hello'),
  Buffer.from(' '),
  Buffer.from('World'),
]);
console.log(combined.toString()); // 'Hello World'
```

### 3. Stream — 流式处理

Stream 是 Node.js 最强大也最容易被忽视的特性。**流的核心思想是：不一次性将全部数据读入内存，而是一块一块地处理。**

想象一下：一个 2GB 的日志文件，如果用 `fs.readFile` 全部读入内存，你的程序可能直接崩溃。而用 Stream，只需要几 MB 的内存就能处理。

**四种流类型：**

| 类型 | 说明 | 示例 |
|------|------|------|
| Readable | 可读流 | `fs.createReadStream`、`http.IncomingMessage` |
| Writable | 可写流 | `fs.createWriteStream`、`http.ServerResponse` |
| Duplex | 双工流（可读可写） | `net.Socket`、`WebSocket` |
| Transform | 转换流 | `zlib.createGzip`、`crypto.createCipher` |

```javascript
import fs from 'node:fs';

// ============ Readable Stream ============

const readStream = fs.createReadStream('./large-file.log', {
  encoding: 'utf-8',
  highWaterMark: 64 * 1024, // 每次读取 64KB
});

readStream.on('data', (chunk) => {
  console.log(`收到 ${chunk.length} 字节`);
});

readStream.on('end', () => {
  console.log('文件读取完成');
});

readStream.on('error', (err) => {
  console.error('读取错误:', err);
});

// ============ Writable Stream ============

const writeStream = fs.createWriteStream('./output.log');

writeStream.write('第一行日志\n');
writeStream.write('第二行日志\n');
writeStream.end('最后一行日志\n'); // end 写入最后数据并关闭

writeStream.on('finish', () => {
  console.log('写入完成');
});
```

### 4. pipe — 管道连接

`pipe` 是连接流的核心方法，它自动处理背压（backpressure）：

```javascript
import fs from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// 简单的文件复制
fs.createReadStream('./input.txt')
  .pipe(fs.createWriteStream('./output.txt'));

// 读取 → 压缩 → 写入
fs.createReadStream('./large-file.log')
  .pipe(createGzip())
  .pipe(fs.createWriteStream('./large-file.log.gz'));

// ✅ 推荐：使用 pipeline（自动处理错误和清理）
await pipeline(
  fs.createReadStream('./input.txt'),
  createGzip(),
  fs.createWriteStream('./input.txt.gz')
);
console.log('压缩完成');
```

### 5. Transform Stream — 转换流

自定义转换流可以在读写之间进行数据处理：

```javascript
import { Transform } from 'node:stream';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

// 自定义转换流：将文本转为大写
const upperCase = new Transform({
  transform(chunk, encoding, callback) {
    this.push(chunk.toString().toUpperCase());
    callback();
  },
});

// 自定义转换流：行号添加器
let lineNumber = 0;
const addLineNumbers = new Transform({
  transform(chunk, encoding, callback) {
    const lines = chunk.toString().split('\n');
    const numbered = lines
      .map((line) => (line ? `${++lineNumber}: ${line}` : ''))
      .join('\n');
    this.push(numbered);
    callback();
  },
});

// 组合使用
await pipeline(
  fs.createReadStream('./input.txt'),
  addLineNumbers,
  upperCase,
  fs.createWriteStream('./output.txt')
);
```

---

## 💻 实践练习

### 练习 1：事件驱动的下载管理器

实现一个 `DownloadManager` 类（继承 EventEmitter），模拟文件下载：

```javascript
const manager = new DownloadManager();

manager.on('progress', ({ file, percent }) => { /* 进度条 */ });
manager.on('complete', ({ file, size }) => { /* 完成提示 */ });
manager.on('error', ({ file, error }) => { /* 错误处理 */ });

manager.download('file1.zip');
manager.download('file2.zip');
manager.download('file3.zip');
```

### 练习 2：大文件行数统计器

用 Stream 实现一个工具，统计一个大文件（可以是几百 MB）的行数，但内存使用量控制在 10MB 以内。

**提示**：使用 `createReadStream` + 自定义 Transform 流计数换行符。

### 练习 3：CSV 转 JSON 转换器

用 Stream 实现一个 CSV 文件到 JSON 文件的转换器：

```bash
node csv-to-json.js input.csv output.json
```

**要求**：
- 使用流式处理（不将整个文件读入内存）
- 第一行为表头
- 正确处理包含逗号的字段（引号包裹）
- 输出格式化的 JSON

---

## ✅ 今日产出

- [ ] 理解 EventEmitter 的使用场景和 API
- [ ] 掌握 Buffer 的创建和编码转换
- [ ] 理解流的四种类型和 pipe/pipeline 的使用
- [ ] 完成练习 1（事件驱动下载管理器）
- [ ] 完成练习 2（大文件行数统计）
- [ ] 完成练习 3（CSV 转 JSON 转换器）

## 📚 延伸阅读

- [Node.js 官方文档 - Events](https://nodejs.org/docs/latest-v20.x/api/events.html)
- [Node.js 官方文档 - Stream](https://nodejs.org/docs/latest-v20.x/api/stream.html)
- [Node.js 官方文档 - Buffer](https://nodejs.org/docs/latest-v20.x/api/buffer.html)
- [Stream Handbook (substack)](https://github.com/substack/stream-handbook) — 经典的 Stream 入门资料

---

[⬅️ Day 03 — 核心模块（上）](../day-03/) | [➡️ Day 05 — 事件循环深度解析](../day-05/)
