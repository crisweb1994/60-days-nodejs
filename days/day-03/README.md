# Day 03 — Node.js 核心模块（上）：fs、path、os

## 📋 今日目标

- 掌握 `fs` 模块的同步/异步/Promise 三种 API
- 熟练使用 `path` 模块处理文件路径
- 了解 `os` 模块获取系统信息
- 实现一个实用的文件操作工具

## 📖 核心知识点

### 1. path 模块 — 路径处理

路径处理是服务端开发最基础的操作之一。**永远不要手动拼接路径字符串**，应该使用 `path` 模块：

```javascript
import path from 'node:path';

// 拼接路径（自动处理分隔符）
path.join('/users', 'john', 'docs', 'file.txt');
// → '/users/john/docs/file.txt' (Unix)
// → '\\users\\john\\docs\\file.txt' (Windows)

// 解析为绝对路径
path.resolve('src', 'index.js');
// → '/Users/you/project/src/index.js'

// 获取路径各部分
const filePath = '/home/user/documents/report.pdf';
path.dirname(filePath);   // '/home/user/documents'
path.basename(filePath);  // 'report.pdf'
path.basename(filePath, '.pdf'); // 'report'
path.extname(filePath);   // '.pdf'

// 解析路径对象
path.parse('/home/user/file.txt');
// { root: '/', dir: '/home/user', base: 'file.txt', ext: '.txt', name: 'file' }

// 相对路径
path.relative('/data/src', '/data/dist/bundle.js');
// → '../dist/bundle.js'

// 标准化路径
path.normalize('/users//john/../jane/./docs');
// → '/users/jane/docs'
```

### 2. fs 模块 — 文件系统操作

`fs` 模块提供三套 API：

| API 风格 | 示例 | 特点 |
|---------|------|------|
| 同步 | `fs.readFileSync()` | 阻塞主线程，简单脚本用 |
| 回调 | `fs.readFile()` | 传统异步，不推荐新代码使用 |
| Promise | `fs.promises.readFile()` | ✅ **推荐**，配合 async/await |

```javascript
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs'; // 同步检查用 fs

// ============ 文件读取 ============

// 读取文本文件
const content = await fs.readFile('./config.json', 'utf-8');
const config = JSON.parse(content);

// 读取二进制文件（不传 encoding 返回 Buffer）
const buffer = await fs.readFile('./image.png');
console.log(buffer.length); // 文件字节大小

// ============ 文件写入 ============

// 写入文件（覆盖）
await fs.writeFile('./output.txt', 'Hello World', 'utf-8');

// 追加内容
await fs.appendFile('./log.txt', `[${new Date().toISOString()}] 新日志\n`);

// ============ 文件信息 ============

const stats = await fs.stat('./package.json');
console.log(stats.isFile());      // true
console.log(stats.isDirectory()); // false
console.log(stats.size);          // 文件大小（字节）
console.log(stats.mtime);         // 最后修改时间

// ============ 文件删除/重命名 ============

await fs.rename('./old.txt', './new.txt');
await fs.unlink('./temp.txt');  // 删除文件
// 或使用 rm（Node.js v14.14+）
await fs.rm('./temp.txt', { force: true });

// ============ 检查文件是否存在 ============
// 注意：使用同步方法检查，因为异步 access 容易有竞态条件
if (existsSync('./config.json')) {
  console.log('配置文件存在');
}
```

### 3. 目录操作

```javascript
import fs from 'node:fs/promises';

// 创建目录
await fs.mkdir('./dist');
// 递归创建
await fs.mkdir('./dist/assets/images', { recursive: true });

// 读取目录内容
const files = await fs.readdir('./src');
console.log(files); // ['index.js', 'utils.js', 'lib']

// 带文件类型信息
const entries = await fs.readdir('./src', { withFileTypes: true });
for (const entry of entries) {
  const type = entry.isDirectory() ? '📁' : '📄';
  console.log(`${type} ${entry.name}`);
}

// 删除目录
await fs.rm('./dist', { recursive: true, force: true });

// 复制文件
await fs.copyFile('./src/config.json', './dist/config.json');

// 监控文件变化
const watcher = fs.watch('./src', { recursive: true });
for await (const event of watcher) {
  console.log(`${event.eventType}: ${event.filename}`);
}
```

### 4. 递归目录遍历

Node.js v20+ 支持 `recursive` 选项：

```javascript
import fs from 'node:fs/promises';
import path from 'node:path';

// 方式一：Node.js v20+ 内置递归
const allFiles = await fs.readdir('./src', { recursive: true });
console.log(allFiles);

// 方式二：自定义递归遍历（更灵活）
async function walkDir(dir) {
  const results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const subFiles = await walkDir(fullPath);
      results.push(...subFiles);
    } else {
      results.push(fullPath);
    }
  }

  return results;
}

const files = await walkDir('./src');
files.forEach((f) => console.log(f));
```

### 5. os 模块

```javascript
import os from 'node:os';

// 系统信息
console.log(os.platform());  // 'darwin' | 'linux' | 'win32'
console.log(os.type());      // 'Darwin' | 'Linux' | 'Windows_NT'
console.log(os.release());   // 系统版本
console.log(os.arch());      // 'x64' | 'arm64'
console.log(os.hostname());  // 主机名

// 用户信息
console.log(os.homedir());   // 用户主目录
console.log(os.tmpdir());    // 临时目录
console.log(os.userInfo());  // 用户详细信息

// 内存
console.log(os.totalmem());  // 总内存（字节）
console.log(os.freemem());   // 空闲内存

// CPU
console.log(os.cpus());      // CPU 核心信息数组
console.log(os.cpus().length); // CPU 核心数

// 网络接口
console.log(os.networkInterfaces());

// 行结尾符
console.log(os.EOL);  // '\n' (Unix) 或 '\r\n' (Windows)
```

---

## 💻 实践练习

### 练习 1：目录树生成器

实现一个 `tree.js` 命令行工具，类似 Unix 的 `tree` 命令：

```bash
node tree.js ./src

# 输出:
# src/
# ├── index.js
# ├── utils/
# │   ├── string.js
# │   └── array.js
# └── config.json
#
# 2 directories, 3 files
```

**要求**：
- 递归遍历指定目录
- 使用 `├──` 和 `└──` 字符绘制树形结构
- 统计文件和目录数量
- 支持 `--depth=N` 参数限制深度
- 忽略 `node_modules` 和 `.git` 目录

### 练习 2：文件拷贝工具

实现一个 `file-copy.js`，支持：

```bash
# 复制文件
node file-copy.js ./src/index.js ./dist/index.js

# 复制目录（递归）
node file-copy.js ./src ./dist
```

**要求**：
- 自动创建目标目录（如果不存在）
- 如果目标已存在，提示用户确认是否覆盖
- 显示复制进度和耗时
- 正确处理错误（源文件不存在、权限不足等）

### 练习 3：Markdown 文档索引生成器

编写一个脚本，扫描指定目录中所有 `.md` 文件，生成一个目录索引文件：

```bash
node md-indexer.js ./docs
```

**要求**：
- 递归扫描所有 `.md` 文件
- 提取每个文件的一级标题（`# Title`）
- 按目录结构生成带链接的索引
- 输出为 `INDEX.md`

---

## ✅ 今日产出

- [ ] 掌握 `path.join / resolve / parse` 等核心方法
- [ ] 掌握 `fs/promises` 的文件读写操作
- [ ] 掌握目录的递归遍历
- [ ] 完成练习 1（目录树生成器）
- [ ] 完成练习 2（文件拷贝工具）
- [ ] 完成练习 3（Markdown 索引生成器）

## 📚 延伸阅读

- [Node.js 官方文档 - fs](https://nodejs.org/docs/latest-v20.x/api/fs.html)
- [Node.js 官方文档 - path](https://nodejs.org/docs/latest-v20.x/api/path.html)
- [Node.js 官方文档 - os](https://nodejs.org/docs/latest-v20.x/api/os.html)

---

[⬅️ Day 02 — 模块系统](../day-02/) | [➡️ Day 04 — 核心模块（下）](../day-04/)
