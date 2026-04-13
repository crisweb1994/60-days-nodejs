# Day 14 — 错误处理与调试技巧

## 📋 今日目标

- 设计分层的自定义错误体系
- 掌握全局错误捕获策略
- 学会使用 Node.js 调试工具（Chrome DevTools、VS Code Debugger）
- 建立服务端错误处理的最佳实践

## 📖 核心知识点

### 1. 自定义错误类体系

```typescript
// errors/base.ts
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true; // 可预期的业务错误
    this.code = code;
    Error.captureStackTrace(this, this.constructor);
  }
}

// 具体错误类
export class NotFoundError extends AppError {
  constructor(resource: string, id?: string | number) {
    const msg = id ? `${resource} (id: ${id}) 不存在` : `${resource}不存在`;
    super(msg, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  public readonly errors: Array<{ field: string; message: string }>;

  constructor(errors: Array<{ field: string; message: string }>) {
    super('请求参数验证失败', 422, 'VALIDATION_ERROR');
    this.errors = errors;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = '请先登录') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = '无权访问') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, 'CONFLICT');
  }
}
```

### 2. 全局错误捕获

```javascript
// 未捕获的同步异常
process.on('uncaughtException', (error) => {
  console.error('💀 Uncaught Exception:', error);
  // 记录日志到文件/远程服务
  // 优雅退出（graceful shutdown）
  process.exit(1); // 必须退出！状态已不可信
});

// 未处理的 Promise rejection
process.on('unhandledRejection', (reason, promise) => {
  console.error('💀 Unhandled Rejection:', reason);
  // Node.js v15+ 默认会使进程崩溃
  // 在此之前的版本需要手动退出
});

// 优雅退出（Graceful Shutdown）
process.on('SIGTERM', () => {
  console.log('收到 SIGTERM 信号，开始优雅退出...');
  server.close(() => {
    // 关闭数据库连接
    // 等待进行中的请求完成
    console.log('服务器已关闭');
    process.exit(0);
  });

  // 如果 10 秒内没有正常退出，强制退出
  setTimeout(() => {
    console.error('强制退出');
    process.exit(1);
  }, 10000);
});
```

### 3. 调试工具

**Node.js 内置调试器：**

```bash
# 启动调试模式
node --inspect src/index.js

# 启动并在第一行暂停
node --inspect-brk src/index.js

# 打开 Chrome DevTools: chrome://inspect
```

**VS Code 调试配置：**

```json
// .vscode/launch.json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Node.js",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "tsx",
      "args": ["src/index.ts"],
      "console": "integratedTerminal",
      "skipFiles": ["<node_internals>/**", "**/node_modules/**"]
    }
  ]
}
```

### 4. 错误处理最佳实践

```javascript
// ❌ 不好的实践
try {
  const data = await fetchData();
} catch (e) {
  console.log(e); // 只打印不处理
}

// ✅ 好的实践
try {
  const data = await fetchData();
} catch (error) {
  if (error instanceof NotFoundError) {
    // 业务错误：返回友好提示
    return res.json(404, { error: error.message });
  }
  // 系统错误：记录日志，返回通用错误
  logger.error('fetchData failed', { error, context: {...} });
  throw error; // 让上层处理
}
```

---

## 💻 实践练习

### 练习 1：为 TODO API 添加完整的错误处理

- 实现自定义错误类体系
- 添加全局异常处理
- 实现 Graceful Shutdown
- 配置 VS Code 调试环境

### 练习 2：错误日志文件

实现一个错误日志系统，将错误信息写入文件：
- 分级别记录（info/warn/error）
- 自动按日期分文件
- 包含时间戳、错误栈、请求上下文

---

## ✅ 今日产出

- [ ] 建立分层的自定义错误体系
- [ ] 实现全局错误捕获和优雅退出
- [ ] 配置 VS Code 调试环境并成功断点调试
- [ ] 完成错误日志系统

---

[⬅️ Day 13 — 进程管理](../day-13/) | [➡️ Day 15 — 阶段一总结](../day-15/)
