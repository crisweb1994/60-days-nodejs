# Day 11 — TypeScript 在 Node.js 中的使用

## 📋 今日目标

- 配置 TypeScript 服务端开发环境
- 掌握 `tsconfig.json` 的关键服务端配置
- 用 TypeScript 重写 TODO API
- 理解类型安全在服务端的价值

## 📖 核心知识点

### 1. 为什么服务端需要 TypeScript？

前端用 TypeScript 主要是为了组件 Props 类型安全。服务端用 TypeScript 的价值更大：

- **API 契约**：请求和响应的类型定义，前后端共享类型
- **数据库模型**：ORM 的类型推导（Prisma 的最大卖点之一）
- **错误预防**：空值检查、类型收窄、穷举检查
- **重构安全**：大型后端项目的重构依赖类型系统

### 2. 项目初始化

```bash
mkdir todo-api-ts && cd todo-api-ts
pnpm init
pnpm add -D typescript @types/node tsx
```

### 3. tsconfig.json 服务端配置

```json
{
  "compilerOptions": {
    // 目标环境
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],

    // 输出
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,

    // 严格模式（全部打开！）
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "exactOptionalPropertyTypes": false,

    // 互操作
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "forceConsistentCasingInFileNames": true,

    // 路径别名
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },

    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 4. 开发工具：tsx

`tsx` 是目前最推荐的 TypeScript Node.js 运行工具（替代 ts-node）：

```json
// package.json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "build": "tsc"
  }
}
```

### 5. 用 TypeScript 定义 API 类型

```typescript
// src/types.ts

// 请求类型
export interface CreateTodoRequest {
  title: string;
  priority?: number;
}

export interface UpdateTodoRequest {
  title?: string;
  completed?: boolean;
  priority?: number;
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

// 数据模型
export interface Todo {
  id: number;
  title: string;
  completed: boolean;
  priority: number;
  createdAt: string;
  updatedAt?: string;
}

// 响应类型
export interface ApiResponse<T> {
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ErrorResponse {
  error: string;
  details?: Record<string, string>;
}

// HTTP 相关
export interface RouteHandler {
  (req: EnhancedRequest, res: EnhancedResponse): void | Promise<void>;
}

export interface EnhancedRequest extends http.IncomingMessage {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

export interface EnhancedResponse extends http.ServerResponse {
  json: (statusCode: number, data: unknown) => void;
}

// 中间件类型
export type Middleware = (
  req: EnhancedRequest,
  res: EnhancedResponse,
  next: () => Promise<void>
) => void | Promise<void>;
```

### 6. 类型守卫与验证

```typescript
// src/validators.ts

import type { CreateTodoRequest, UpdateTodoRequest } from './types.js';

// 类型守卫
function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

// 请求验证
export function validateCreateTodo(body: unknown): CreateTodoRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('请求体必须是 JSON 对象');
  }

  const { title, priority } = body as Record<string, unknown>;

  if (!isString(title) || title.trim().length === 0) {
    throw new ValidationError('title 是必填项且不能为空');
  }

  if (title.length > 200) {
    throw new ValidationError('title 不能超过 200 个字符');
  }

  const result: CreateTodoRequest = { title: title.trim() };

  if (priority !== undefined) {
    if (!isNumber(priority) || priority < 1 || priority > 5) {
      throw new ValidationError('priority 必须是 1-5 之间的数字');
    }
    result.priority = priority;
  }

  return result;
}

export function validateUpdateTodo(body: unknown): UpdateTodoRequest {
  if (!body || typeof body !== 'object') {
    throw new ValidationError('请求体必须是 JSON 对象');
  }

  const { title, completed, priority } = body as Record<string, unknown>;
  const result: UpdateTodoRequest = {};

  if (title !== undefined) {
    if (!isString(title) || title.trim().length === 0) {
      throw new ValidationError('title 不能为空');
    }
    result.title = title.trim();
  }

  if (completed !== undefined) {
    result.completed = Boolean(completed);
  }

  if (priority !== undefined) {
    if (!isNumber(priority) || priority < 1 || priority > 5) {
      throw new ValidationError('priority 必须是 1-5 之间的数字');
    }
    result.priority = priority;
  }

  return result;
}
```

---

## 💻 实践练习

### 练习 1：TypeScript TODO API

将 Day 8-9 的 TODO API 完全用 TypeScript 重写：
- 所有函数都有类型签名
- 请求/响应使用类型定义
- 验证函数使用类型守卫
- 使用 `tsx watch` 开发

### 练习 2：泛型工具函数

实现以下泛型工具类型和函数：

```typescript
// 通用分页函数
function paginate<T>(items: T[], page: number, limit: number): PaginatedResponse<T>

// 通用过滤函数
function filterBy<T>(items: T[], key: keyof T, value: T[keyof T]): T[]

// 通用排序函数
function sortBy<T>(items: T[], key: keyof T, order: 'asc' | 'desc'): T[]
```

---

## ✅ 今日产出

- [ ] 配置好 TypeScript 服务端开发环境
- [ ] 理解 tsconfig.json 关键配置
- [ ] 用 TypeScript 重写 TODO API
- [ ] 完成练习 1 和练习 2
- [ ] 使用 `tsx watch` 体验热重载开发

## 📚 延伸阅读

- [TypeScript 官方文档](https://www.typescriptlang.org/docs/)
- [tsx GitHub](https://github.com/privatenumber/tsx)
- [Node.js + TypeScript 最佳实践](https://github.com/microsoft/TypeScript/wiki/Node-Target-Mapping)

---

[⬅️ Day 10 — 迷你项目 Review](../day-10/) | [➡️ Day 12 — RESTful API 设计原则](../day-12/)
