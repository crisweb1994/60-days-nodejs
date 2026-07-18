# Day 54 — 前端集成与联调

Day 47 到 Day 53 一直在搭后端：认证、工作区、任务、实时事件、通知和统计都有了，但浏览器里仍是最初的脚手架页面。今天把这些能力接成一个真正能工作的产品界面。

本次前端不是几个静态页面，而是一条完整工作流：

```text
登录 / 注册
  -> 选择或创建工作区
  -> 选择或创建项目
  -> 查看统计
  -> 创建、移动任务
  -> 在列表中搜索筛选
  -> 处理通知
```

## 今日目标

- 在 Next.js App Router 中建立前端数据层
- 使用 tRPC React Query 对接已有 API
- 区分服务端状态与本地界面状态
- 实现认证、仪表盘、看板、列表和通知
- 正确处理 mutation 后的缓存失效
- 接入 SSE，让其他成员的变更自动刷新
- 补齐加载、错误、空状态和响应式布局
- 用真实浏览器完成桌面端和移动端功能测试

## 1. 为什么要用 React Query

直接在组件里写 `fetch` 并不难：

```ts
useEffect(() => {
  fetch("/api/tasks").then(...);
}, []);
```

难的是后续问题：

- 请求期间怎样展示加载状态；
- 两个组件请求同一份数据时怎样去重；
- 切换页面再回来是否重新请求；
- 创建任务后哪些列表需要刷新；
- 窗口重新聚焦是否刷新；
- 分页数据怎样拼接；
- 请求失败如何重试；
- 组件卸载后怎样避免旧请求覆盖新状态。

React Query 管理的不是“HTTP 请求”，而是服务端数据在浏览器里的缓存生命周期。

本项目使用：

```json
{
  "@tanstack/react-query": "^4",
  "@trpc/react-query": "^10",
  "lucide-react": "^0.468"
}
```

版本保持在 tRPC 10 与 React Query 4 的兼容组合，不能只追求各自最新版本。

## 2. Provider：把 tRPC 和 QueryClient 接起来

`src/app/providers.tsx` 是前端数据层入口：

```tsx
const [queryClient] = useState(
  () =>
    new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 20_000,
          refetchOnWindowFocus: false,
          retry: 1,
        },
      },
    }),
);

const [trpcClient] = useState(() =>
  trpc.createClient({
    transformer: superjson,
    links: [
      httpBatchLink({
        url: "/api/trpc",
        fetch(url, options) {
          return fetch(url, {
            ...options,
            credentials: "same-origin",
          });
        },
      }),
    ],
  }),
);
```

### 为什么用 useState 创建客户端

组件每次渲染都执行函数体。如果直接写：

```tsx
const queryClient = new QueryClient();
```

每次渲染都会得到一份新缓存，之前的请求结果全部丢失。`useState` 的惰性初始化保证浏览器会话中只创建一次。

### staleTime 不是缓存过期时间

`staleTime: 20_000` 表示 20 秒内数据被视为新鲜，React Query 不主动重复请求；它不会在 20 秒后删除缓存。

真正决定无观察者缓存多久保留的是 `cacheTime`。这两个概念经常被混淆：

```text
staleTime：多久以内不需要重新确认
cacheTime：没人使用后，还在内存里保留多久
```

### 为什么继续使用 superjson

任务的 `dueDate`、`completedAt` 等字段是 `Date`。普通 JSON 只能传字符串，superjson 会附带类型信息，让客户端拿到真正的日期对象。tRPC 服务端和客户端必须配置同一个 transformer。

## 3. 类型从后端路由流到组件

`src/trpc/react.ts` 只做一件事：

```ts
import type { AppRouter } from "@/server/routers/_app";

export const trpc = createTRPCReact<AppRouter>();
```

`AppRouter` 是类型导入，不会把 Prisma 或服务端代码打进浏览器 bundle。组件调用：

```ts
trpc.tasks.board.useQuery({ workspaceSlug, projectKey });
```

输入缺字段、枚举拼错、响应字段不存在都会在编译期报错。这是 tRPC 在全栈 TypeScript 项目中的主要价值：不是少写一条 URL，而是前后端共享同一份契约。

## 4. 服务端状态和界面状态要分开

这两类状态看起来都能放进 `useState`，但生命周期不同。

### 服务端状态

- 工作区列表
- 项目列表
- 任务看板
- 统计数据
- 通知

它们来自 API，可能被其他用户修改，需要加载、重试、失效和重新获取，因此交给 React Query。

### 界面状态

- 当前打开 Dashboard、Board 还是 List
- 移动端侧栏是否展开
- 通知抽屉是否打开
- 新建任务表单是否展开
- 当前搜索词

这些只属于当前浏览器界面，用 `useState` 更合适。

一个实用判断：

> 刷新页面后，能否从服务端重新得到这份状态？

能得到的通常是服务端状态；只影响当前操作过程的通常是界面状态。

## 5. 登录态：cookie 留在浏览器，用户信息进入缓存

后端把 session 放在 `httpOnly` cookie 中。前端 JavaScript 读不到 token，这正是我们想要的：即使发生 XSS，攻击代码也不能直接读取会话凭证。

页面启动时调用：

```tsx
const me = trpc.auth.me.useQuery(undefined, {
  retry: false,
  staleTime: 60_000,
});
```

Day 54 将 `auth.me` 改为公开 procedure：

- 有合法 cookie：返回用户；
- 没有 cookie：返回 `user: null`。

“未登录”是正常页面状态，不应该用 401 异常驱动，也不应该在控制台留下错误堆栈。真正受保护的业务 API 仍然使用 `protectedProcedure`。

登录成功后不需要手动把用户塞进很多组件：

```ts
onSuccess: () => utils.auth.me.invalidate()
```

失效后重新读取 session，根组件自然从登录页切换到工作区。

## 6. 应用壳与上下文选择

产品界面采用三层上下文：

```text
工作区
  -> 项目
    -> 当前视图
```

工作区影响项目、成员、通知和统计；项目影响看板与列表。切换工作区后必须校验当前项目是否仍存在，不能继续拿旧项目 key 请求新工作区。

```tsx
useEffect(() => {
  const available = projects.data?.projects ?? [];
  if (available.length === 0) {
    setProjectKey("");
    return;
  }
  if (!available.some((project) => project.key === projectKey)) {
    setProjectKey(available[0].key);
  }
}, [projectKey, projects.data]);
```

这里不是把服务端项目列表复制到本地，只保存“当前选择”这个界面状态。

空账号不会被丢进一个没有方向的空页面：

- 没有工作区时显示工作区创建流程；
- 有工作区但没有项目时显示项目创建流程；
- 有项目但没有任务时，看板提供创建入口。

空状态必须告诉用户下一步做什么。

## 7. 缓存失效：mutation 成功不等于界面已经正确

创建任务会影响很多查询：

| 变化 | 需要失效的数据 |
| --- | --- |
| 创建任务 | 看板、列表、总览、工作量、项目进度 |
| 移动状态 | 看板、列表、总览、完成趋势、项目进度 |
| 标记通知已读 | 通知列表、未读数 |
| 创建项目 | 项目列表 |

任务 mutation 后统一执行：

```ts
await Promise.all([
  utils.tasks.board.invalidate(),
  utils.tasks.listView.invalidate(),
  utils.analytics.overview.invalidate(),
  utils.analytics.completionTrend.invalidate(),
  utils.analytics.workload.invalidate(),
  utils.analytics.projectProgress.invalidate(),
]);
```

### 为什么不直接刷新整个页面

`window.location.reload()` 虽然也能得到新数据，但会丢失当前视图、滚动位置、筛选条件和已展开表单。精确失效只更新受影响的数据，用户能继续当前工作。

### 什么时候做乐观更新

拖动任务可以先在缓存中移动卡片，再请求服务端，失败时回滚。这会让交互更快，但需要处理：

- 乐观锁版本冲突；
- 状态机拒绝；
- 原列和目标列回滚；
- 同时收到 SSE 更新。

Day 54 选择 mutation 期间降低卡片透明度，成功后重新获取权威数据。当前局域网延迟下足够清晰，逻辑也更可靠。后续确认性能需求后再加乐观更新。

## 8. 看板：拖拽不能绕过状态机

后端只允许合法状态流转，例如：

```text
TODO -> IN_PROGRESS
IN_PROGRESS -> IN_REVIEW
IN_REVIEW -> DONE
```

前端不能因为支持拖拽，就允许从 `BACKLOG` 直接扔到 `DONE`。看板使用与后端一致的状态转换表，在 drop 前检查：

```ts
if (!allowedTransitions[task.status].includes(targetStatus)) {
  setInteractionError("不能直接移动到目标状态");
  return;
}
```

真正的权限和规则仍由后端负责。前端检查是为了及时反馈，不是安全边界。

拖拽并非键盘友好，因此每张卡还提供原生 `select`：

```tsx
<select aria-label={`修改 ${task.title} 的状态`}>
  {allowedTransitions[task.status].map(...)}
</select>
```

鼠标用户可以拖动，键盘和辅助技术用户可以选择状态，二者调用同一个 mutation。

## 9. 列表：游标分页接入 useInfiniteQuery

Day 50 的 API 返回：

```json
{
  "tasks": [],
  "nextCursor": "...",
  "hasMore": true
}
```

前端使用：

```tsx
const tasks = trpc.tasks.listView.useInfiniteQuery(input, {
  getNextPageParam: (lastPage) =>
    lastPage.nextCursor ?? undefined,
});
```

页面数据展开：

```ts
const rows =
  tasks.data?.pages.flatMap((page) => page.tasks) ?? [];
```

搜索词、状态和优先级都属于 query key 的一部分。筛选变化后 React Query 自动创建新的缓存条目，不需要手动清空旧数组。

“加载更多”期间保留现有行，只改变按钮状态。不能用一个全屏 spinner 把已经可读的数据盖掉。

## 10. 仪表盘：展示口径，不重新计算口径

前端调用 Day 53 的四个接口：

- `analytics.overview`
- `analytics.completionTrend`
- `analytics.workload`
- `analytics.projectProgress`

完成率、逾期、未分配等口径都由后端返回。前端只负责展示，不再根据任务列表重新计算，否则数据分页后会得到错误结果。

趋势图使用后端已经补齐的 30 天日期数组。即使某天完成数为 0，也保留一个低位柱，因此横轴不会断。

图表包含 `role="img"` 和可读的 `aria-label`，每个数据点也保留日期与数量。视觉图形不能是屏幕阅读器里的空洞。

## 11. SSE 和 React Query 怎样协作

Day 51 已经提供工作区 SSE。Day 54 的 `useWorkspaceRealtime` 订阅：

```ts
const TASK_EVENTS = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.deleted",
  "comment.created",
];
```

收到事件后不手动修改多份缓存，而是失效相关 query：

```text
SSE 只说“什么变了”
React Query 决定“哪些数据重新获取”
API 返回最新权威状态
```

这样避免在 SSE handler 中复制服务端业务逻辑。`EventSource` 自带断线重连，组件切换工作区或卸载时必须 `close()`，否则会留下重复连接。

## 12. 加载、错误与空状态

一个真实产品至少需要这三类状态。

### 加载

使用与内容结构接近的 skeleton，页面不会从一个小 spinner 突然跳成整张表格。

### 错误

错误提示保留服务端明确消息，例如权限不足、状态流转非法、版本冲突。提示使用 `role="alert"`，辅助技术会及时读出。

### 空状态

空状态区分：

- 数据本来为空：引导创建；
- 搜索没有结果：建议调整筛选；
- 通知为空：说明哪些事件会出现在这里。

“暂无数据”只描述现状，没有帮助用户继续操作。

## 13. 响应式不是把桌面页面缩小

桌面端：

- 固定侧栏；
- 顶部项目上下文；
- 仪表盘双列详情；
- 看板横向列；
- 完整数据表。

移动端：

- 侧栏变为抽屉；
- 指标变成两列；
- 工作量和项目进度改为单列；
- 看板列保持稳定宽度并横向滚动；
- 表格放入自己的横向滚动容器；
- 顶部只保留项目和通知等必要操作。

字号保持固定，没有用 viewport 宽度缩放文字。可操作按钮至少 36-44px，高频操作有清晰 focus 状态。

测试时不仅看截图，还要检查：

```ts
document.body.scrollWidth === window.innerWidth
```

页面级不应横向溢出；看板和表格的局部滚动是有意设计。

## 14. 视觉系统

这是一个反复使用的操作工具，不是营销页。设计选择是：

- 背景使用冷静的中性灰，不使用装饰渐变；
- 深绿侧栏承担工作区层级；
- 墨绿色只用于主操作、当前选择和完成数据；
- 珊瑚红只用于逾期、错误和紧急状态；
- 卡片圆角不超过 7px；
- 固定字号和紧凑间距，提高扫描效率；
- Lucide 统一所有功能图标。

Dashboard 的“工作脉冲”是唯一带明显视觉记忆的区域，而且它展示真实完成趋势，不是装饰。

## 15. 代码结构

```text
src/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── providers.tsx
│   └── globals.css
├── components/
│   ├── app-root.tsx
│   ├── auth-screen.tsx
│   ├── workspace-app.tsx
│   ├── dashboard-view.tsx
│   ├── board-view.tsx
│   ├── list-view.tsx
│   ├── notification-drawer.tsx
│   └── ui.tsx
├── hooks/
│   └── use-workspace-realtime.ts
└── trpc/
    └── react.ts
```

拆分原则不是“一组件一个文件”，而是按职责：

- 页面数据和业务交互各自成视图；
- 通用展示状态集中在 `ui.tsx`；
- 数据客户端和实时连接独立；
- 应用壳负责上下文选择与导航，不负责统计 SQL 或任务卡细节。

## 16. 本地运行

```bash
cd solutions/saas
docker compose up -d
pnpm prisma:push
pnpm dev
```

邮件 worker 单独运行：

```bash
pnpm worker:mail
```

打开：

```text
http://localhost:3000
```

第一次使用时注册账号，依次创建工作区和项目，然后即可进入看板创建任务。

## 17. 验收清单

- [ ] 未登录显示登录/注册界面，不产生预期外控制台错误
- [ ] 注册后进入工作区创建流程
- [ ] 登录后自动读取已有工作区和项目
- [ ] 仪表盘显示真实总览、趋势、工作量和项目进度
- [ ] 仪表盘可切换全部项目与当前项目
- [ ] 看板可以创建任务
- [ ] 看板拖拽只允许合法状态流转
- [ ] 键盘可通过状态选择框移动任务
- [ ] 列表可按关键词、状态和优先级筛选
- [ ] 列表分页不会覆盖已加载数据
- [ ] 通知抽屉可查看并标记已读
- [ ] SSE 事件会失效任务与统计缓存
- [ ] 390px 宽度没有页面级横向溢出
- [ ] 移动端侧栏能打开和关闭
- [ ] 所有核心控件有可访问名称和 focus 状态
- [ ] `pnpm typecheck`、`pnpm build` 通过

## 延伸思考

1. 拖拽任务怎样实现乐观更新并在版本冲突时精确回滚？
2. SSE 高频事件怎样合并失效，避免短时间重复请求统计 API？
3. 工作区和项目选择是否应该进入 URL，使页面可分享、可刷新恢复？
4. 任务详情应使用独立路由、侧边面板还是对话框？
5. 大型列表何时需要虚拟滚动，虚拟滚动会怎样影响可访问性？
6. 离线时创建任务，网络恢复后怎样可靠同步并处理冲突？

前端联调真正要解决的，不是“把接口数据显示出来”，而是让数据在加载、修改、失效、实时更新和错误恢复之间始终保持可解释。用户不需要知道 React Query 做了什么，但他会清楚地感受到：页面没有突然跳走，操作结果及时出现，其他成员的变化也不会悄悄落下。

---

[⬅️ Day 53](../day-53/) | [➡️ Day 55](../day-55/)
