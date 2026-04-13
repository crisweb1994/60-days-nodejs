# Day 02 — 模块系统与包管理

## 📋 今日目标

- 深入理解 CommonJS 和 ESModule 两种模块系统
- 掌握 `package.json` 的核心配置
- 熟练使用 npm/pnpm 进行包管理
- 理解模块解析算法

## 📖 核心知识点

### 1. 为什么需要模块系统？

在浏览器早期，所有 JS 共享全局作用域，容易造成命名冲突。Node.js 从一开始就引入了模块系统 — 每个文件是一个独立的模块，拥有自己的作用域。

Node.js 支持两种模块系统：

| 特性 | CommonJS (CJS) | ESModule (ESM) |
|------|----------------|----------------|
| 语法 | `require()` / `module.exports` | `import` / `export` |
| 加载时机 | 运行时（同步） | 编译时（静态分析） |
| 历史 | Node.js 原生支持 | ES2015 标准，Node.js v12+ 支持 |
| Tree Shaking | ❌ 不支持 | ✅ 支持 |
| 循环依赖 | 返回部分导出 | 返回引用（live binding） |
| Top-level await | ❌ 不支持 | ✅ 支持 |

### 2. CommonJS（CJS）

这是 Node.js 的传统模块系统：

```javascript
// math.js — 导出
function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

// 方式一：逐个导出
module.exports.add = add;
module.exports.multiply = multiply;

// 方式二：整体导出（更常用）
module.exports = { add, multiply };
```

```javascript
// app.js — 导入
const { add, multiply } = require('./math');
// 或者
const math = require('./math');

console.log(add(2, 3));        // 5
console.log(math.multiply(4, 5)); // 20
```

**CJS 的关键特性：**

```javascript
// require 是同步的，可以出现在任何位置
if (process.env.NODE_ENV === 'development') {
  const debug = require('./debug');  // 条件导入
}

// 模块会被缓存 — 多次 require 同一模块只执行一次
const a = require('./module');
const b = require('./module');
console.log(a === b);  // true，同一个对象
```

### 3. ESModule（ESM）

这是 JavaScript 的官方模块标准，也是未来的方向：

```javascript
// math.mjs（或在 package.json 中设置 "type": "module"）

// 命名导出
export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

// 默认导出
export default class Calculator {
  add(a, b) { return a + b; }
}
```

```javascript
// app.mjs — 导入

// 命名导入
import { add, multiply } from './math.mjs';

// 默认导入
import Calculator from './math.mjs';

// 全部导入
import * as math from './math.mjs';

// 动态导入（返回 Promise）
const module = await import('./math.mjs');
```

**如何在 Node.js 中启用 ESM？**

```json
// package.json — 方式一：设置 type
{
  "type": "module"
}
```

```
// 方式二：使用 .mjs 文件扩展名
math.mjs  → ESModule
math.cjs  → CommonJS
```

### 4. ESM 中获取 __filename 和 __dirname

ESM 中没有 `__filename` 和 `__dirname`，需要这样获取：

```javascript
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log(__filename);  // /Users/you/project/app.js
console.log(__dirname);   // /Users/you/project
```

### 5. package.json 详解

`package.json` 是 Node.js 项目的核心配置文件：

```json
{
  "name": "my-project",
  "version": "1.0.0",
  "description": "一个示例项目",
  "main": "index.js",
  "type": "module",
  "scripts": {
    "start": "node index.js",
    "dev": "node --watch index.js",
    "test": "node --test"
  },
  "dependencies": {
    "express": "^4.18.2"
  },
  "devDependencies": {
    "typescript": "^5.3.0"
  },
  "engines": {
    "node": ">=20.0.0"
  },
  "license": "MIT"
}
```

**版本号语义（SemVer）：**

```
主版本号.次版本号.修订号
MAJOR.MINOR.PATCH

^4.18.2 → 允许 >=4.18.2 且 <5.0.0（次版本和修订可升级）
~4.18.2 → 允许 >=4.18.2 且 <4.19.0（仅修订可升级）
4.18.2  → 精确锁定（不推荐用于大多数依赖）
```

### 6. npm / pnpm 常用命令

```bash
# 初始化项目
npm init -y               # 快速初始化
pnpm init                 # pnpm 初始化

# 安装依赖
pnpm add express          # 生产依赖
pnpm add -D typescript    # 开发依赖
pnpm add -g nodemon       # 全局安装

# 删除依赖
pnpm remove express

# 安装项目所有依赖
pnpm install              # 或 pnpm i

# 运行脚本
pnpm run dev
pnpm start                # start/test 不需要 run

# 检查过时的依赖
pnpm outdated

# 查看依赖树
pnpm list --depth=0
```

**pnpm vs npm vs yarn：**
- **pnpm**：磁盘空间节省（硬链接），安装速度快，严格的依赖隔离（推荐）
- **npm**：Node.js 内置，生态最广
- **yarn**：Facebook 出品，并行安装快

### 7. 模块解析算法

当你写 `require('express')` 或 `import express from 'express'` 时，Node.js 是怎样找到模块的？

```
require('./math')    → 相对路径，查找当前目录下的 math.js / math/index.js
require('express')   → 非相对路径，按以下顺序查找：
  1. Node.js 内置模块（fs, path, http...）
  2. node_modules/express （当前目录）
  3. ../node_modules/express（父目录）
  4. ../../node_modules/express（继续向上）
  5. ... 直到根目录
```

---

## 💻 实践练习

### 练习 1：模块化工具库

创建一个 `utils` 工具库，包含以下模块：

```
utils/
├── index.js          # 统一导出
├── string.js         # 字符串工具
├── array.js          # 数组工具
└── date.js           # 日期工具
```

**要求**：
- `string.js`：实现 `capitalize(str)` / `truncate(str, length)` / `slugify(str)`
- `array.js`：实现 `chunk(arr, size)` / `unique(arr)` / `shuffle(arr)`
- `date.js`：实现 `formatDate(date)` / `timeAgo(date)` / `isWeekend(date)`
- 分别用 CJS 和 ESM 两种方式实现
- `index.js` 统一导出所有工具函数

### 练习 2：依赖分析器

编写一个 `deps-analyzer.js` 脚本：

1. 读取指定目录（或当前目录）的 `package.json`
2. 列出所有 `dependencies` 和 `devDependencies`
3. 按字母排序显示
4. 检查是否有 `package-lock.json` 或 `pnpm-lock.yaml`
5. 输出统计信息（总依赖数量等）

---

## ✅ 今日产出

- [ ] 理解 CJS 和 ESM 两种模块系统的区别
- [ ] 创建一个使用 ESM 的 Node.js 项目
- [ ] 完成练习 1（模块化工具库）
- [ ] 完成练习 2（依赖分析器）
- [ ] 尝试用 `node --watch` 体验文件热重载

## 📚 延伸阅读

- [Node.js 官方文档 - Modules: CommonJS](https://nodejs.org/docs/latest-v20.x/api/modules.html)
- [Node.js 官方文档 - Modules: ESM](https://nodejs.org/docs/latest-v20.x/api/esm.html)
- [pnpm 官方文档](https://pnpm.io/)
- [SemVer 语义版本规范](https://semver.org/lang/zh-CN/)

---

[⬅️ Day 01 — 环境搭建](../day-01/) | [➡️ Day 03 — 核心模块（上）](../day-03/)
