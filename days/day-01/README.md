# Day 01 — 环境搭建与 Node.js 初印象

## 📋 今日目标

- 安装 Node.js 开发环境（nvm + Node.js v20+）
- 理解 Node.js 是什么、为什么它适合全栈开发
- 运行第一个 Node.js 程序
- 熟悉 REPL 和命令行工具

## 📖 核心知识点

### 1. Node.js 是什么？

Node.js 是一个基于 Chrome V8 引擎的 **JavaScript 运行时**。它让 JavaScript 脱离浏览器，可以运行在服务端。

作为前端工程师，你已经熟悉了浏览器中的 JavaScript。Node.js 和浏览器中的 JS 有以下关键区别：

| 维度 | 浏览器 JS | Node.js |
|------|----------|---------|
| 运行环境 | 浏览器 | 操作系统 |
| 全局对象 | `window` | `global` / `globalThis` |
| DOM/BOM | ✅ 有 | ❌ 没有 |
| 文件系统 | ❌ 受限 | ✅ 完整访问 |
| 网络请求 | `fetch` / `XMLHttpRequest` | `http` / `https` / `fetch` (v18+) |
| 模块系统 | ESModule | CommonJS + ESModule |
| 用途 | UI 交互、页面渲染 | API 服务、工具链、脚本 |

### 2. 为什么选择 Node.js 做全栈？

对于前端工程师来说，Node.js 是转全栈的**最短路径**：

- **语言复用**：不需要学一门新语言，JS/TS 通吃前后端
- **生态丰富**：npm 是世界上最大的包管理生态
- **市场需求**：Next.js 全栈框架的流行让 Node.js 全栈工程师需求暴增
- **思维连贯**：前端对异步编程、事件驱动的理解可以无缝迁移

### 3. 安装 Node.js

**推荐使用 nvm（Node Version Manager）管理 Node.js 版本：**

```bash
# 安装 nvm（macOS / Linux）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

# 重启终端后，安装 Node.js v20 LTS
nvm install 20
nvm use 20
nvm alias default 20

# 验证安装
node --version    # 应显示 v20.x.x
npm --version     # 应显示 10.x.x
```

**Windows 用户推荐使用 [nvm-windows](https://github.com/coreybutler/nvm-windows)。**

**安装 pnpm（推荐的包管理器）：**

```bash
# 使用 corepack 启用 pnpm
corepack enable
corepack prepare pnpm@latest --activate

# 验证
pnpm --version
```

### 4. 配置开发环境

**VS Code 推荐插件：**

- **ESLint** — 代码规范检查
- **Prettier** — 代码格式化
- **Thunder Client** — API 测试（类似 Postman）
- **Error Lens** — 行内显示错误信息

### 5. Node.js REPL

REPL（Read-Eval-Print-Loop）是 Node.js 的交互式命令行：

```bash
# 进入 REPL
node

# 在 REPL 中试试：
> 1 + 1
2
> console.log('Hello Node.js!')
Hello Node.js!
> process.version
'v20.x.x'
> process.platform
'darwin'  // macOS
> .exit
```

**REPL 常用命令：**
- `.help` — 显示帮助
- `.clear` — 清除上下文
- `.exit` — 退出（或按 Ctrl+C 两次）
- `Tab` — 自动补全

### 6. 第一个 Node.js 程序

创建文件 `hello.js`：

```javascript
// hello.js
console.log('🚀 Hello, Node.js!');
console.log('Node.js version:', process.version);
console.log('Platform:', process.platform);
console.log('Architecture:', process.arch);
console.log('PID:', process.pid);
console.log('Current directory:', process.cwd());
console.log('Memory usage:', process.memoryUsage());
```

运行：

```bash
node hello.js
```

### 7. process 对象

`process` 是 Node.js 最重要的全局对象之一，没有浏览器等价物：

```javascript
// process-demo.js

// 1. 环境变量
console.log('HOME:', process.env.HOME);
console.log('PATH:', process.env.PATH);

// 2. 命令行参数
// 运行: node process-demo.js --name=Node --version=20
console.log('argv:', process.argv);
// argv[0] = node 路径
// argv[1] = 脚本路径
// argv[2+] = 自定义参数

// 3. 标准 I/O
process.stdout.write('请输入你的名字: ');
process.stdin.once('data', (data) => {
  console.log(`你好, ${data.toString().trim()}!`);
  process.exit(0); // 退出程序，0 表示正常退出
});

// 4. 退出事件
process.on('exit', (code) => {
  console.log(`进程即将退出，退出码: ${code}`);
});
```

### 8. 全局对象与模块作用域

Node.js 中每个文件都是一个独立的**模块**，变量默认不会污染全局：

```javascript
// scope-demo.js

// 这些是 Node.js 中每个模块都有的特殊变量
console.log('__filename:', __filename);  // 当前文件的绝对路径
console.log('__dirname:', __dirname);    // 当前文件所在目录
console.log('module:', module);          // 当前模块信息
console.log('exports:', exports);        // 模块导出对象

// 注意：在 ESModule 模式下，__filename 和 __dirname 不可用
// 需要使用 import.meta.url 替代
```

---

## 💻 实践练习

### 练习 1：系统信息收集器

编写一个 `system-info.js` 脚本，收集并美化输出以下系统信息：

- Node.js 版本
- 操作系统类型和版本
- CPU 架构
- 当前用户主目录
- 当前工作目录
- 内存使用情况（格式化为 MB）
- 进程运行时间

**提示**：使用 `process` 对象和 `os` 模块（`const os = require('os')` 或 `import os from 'os'`）。

### 练习 2：命令行计算器

编写一个 `calc.js`，支持通过命令行参数进行计算：

```bash
node calc.js add 3 5      # 输出: 8
node calc.js subtract 10 3 # 输出: 7
node calc.js multiply 4 6  # 输出: 24
node calc.js divide 15 3   # 输出: 5
```

**要求**：
- 使用 `process.argv` 解析参数
- 处理除以零的错误
- 处理无效操作符的错误
- 使用不同的退出码来表示成功(0)和失败(1)

### 练习 3：交互式问候程序

编写一个 `greeter.js`，使用 `process.stdin` 和 `process.stdout` 实现：

1. 提示用户输入姓名
2. 提示用户输入年龄
3. 输出个性化问候信息

---

## ✅ 今日产出

- [ ] 安装好 Node.js v20+、pnpm、VS Code 插件
- [ ] 完成 `hello.js` 和 `process-demo.js`
- [ ] 完成练习 1（系统信息收集器）
- [ ] 完成练习 2（命令行计算器）
- [ ] 完成练习 3（交互式问候程序）

## 📚 延伸阅读

- [Node.js 官方文档 - Getting Started](https://nodejs.org/en/learn/getting-started/introduction-to-nodejs)
- [Node.js 官方文档 - process](https://nodejs.org/docs/latest-v20.x/api/process.html)
- [nvm GitHub 仓库](https://github.com/nvm-sh/nvm)

---

[➡️ Day 02 — 模块系统与包管理](../day-02/)
