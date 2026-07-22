# Day 51 — 实时通信

> Day 50 让看板和列表“读起来像产品”了：有列、有排序、有分页，也能拖拽。接下来会遇到一个真实协作问题：你看到的看板不是只有你一个人在改。同事把卡从 `TODO` 拖到 `IN_PROGRESS`，如果你的页面还停在旧状态，这个任务管理工具就不像协作软件。
>
> Day 51 做实时通信，但不急着把所有东西都变成“实时”。先抓住最有价值的两类：**任务变更推送**和**在线用户展示**。这两类都属于“服务端有事件，浏览器需要尽快知道”。
>
> 一句话目标：用 SSE 实现工作区级实时事件流，让任务创建、更新、移动、删除、评论和在线用户变化能推到浏览器。

## 📋 今日目标

- 吃透 HTTP 短轮询、SSE、WebSocket 的差别和适用场景
- 实现工作区实时订阅接口：`GET /api/realtime/workspaces/:slug/events`
- 实现在线用户：连接时发 `presence.snapshot` / `presence.joined`，断开时发 `presence.left`
- 在任务 mutation 后发布实时事件：`task.created / task.updated / task.moved / task.deleted / comment.created`
- 明确当前实现边界：单实例内存事件总线，不跨进程、不持久化
- 为 Day 52 的通知系统留边界：实时事件不等于通知存储

> 配套代码：`solutions/saas/`。新增 `src/server/realtime/` 和 SSE route，并在 `tasksRouter` 的写操作里发布事件。

---

## 📖 核心知识点

### 1. 实时不是目的，减少“协作错觉”才是目的

任务系统最怕一种错觉：页面看起来很正常，但数据已经过期。

比如你打开看板时，任务 A 在 `TODO`。同事一分钟前已经把它拖到 `IN_PROGRESS`，你没刷新，还以为它没人开始做。接着你又拖了一次，服务端要么报版本冲突，要么更糟，覆盖掉同事的操作。

实时通信解决的不是“炫”，而是三个具体问题：

- **状态同步**：别人改了任务，你尽快看到
- **在线感**：知道谁正在这个工作区里
- **操作反馈**：创建评论、移动卡片后，其他客户端能收到事件

所以 Day 51 不做聊天室，不做复杂协同编辑，也不做 CRDT。先把任务管理最需要的事件流跑通。

### 2. 三种方案：轮询、SSE、WebSocket

实时通信常见三种做法：

| 方案 | 连接方向 | 优点 | 代价 | 适合 |
|---|---|---|---|---|
| 短轮询 | 浏览器定时请求服务端 | 最简单，所有环境都支持 | 延迟和浪费二选一：间隔短就费，间隔长就慢 | 后台低频刷新 |
| SSE | 服务端持续推给浏览器 | 原生 HTTP、自动重连、实现轻 | 只能服务端 -> 浏览器，浏览器发消息还要走普通 HTTP | 通知、状态更新、看板同步 |
| WebSocket | 双向长连接 | 双向、低延迟、协议灵活 | 部署/鉴权/心跳/扩容更复杂 | 聊天、游戏、协同编辑 |

这套 SaaS 当前大多数写操作仍然走 tRPC mutation：创建任务、拖拽任务、评论任务。浏览器并不需要通过实时连接“发命令”，只需要通过实时连接“收变化”。这种场景 SSE 很合适。

Day 51 选 SSE，不是因为 WebSocket 不好，而是因为它刚好够用。

### 3. SSE 的本质：一条不关闭的 HTTP 响应

SSE 接口看起来还是普通 GET：

```text
GET /api/realtime/workspaces/acme/events
Accept: text/event-stream
Cookie: saas_session=...
```

服务端不立刻结束响应，而是一直写这种文本块：

```text
event: task.moved
data: {"type":"task.moved","task":{"number":42,"status":"TODO"}}

```

浏览器端用：

```ts
const source = new EventSource("/api/realtime/workspaces/acme/events");
source.addEventListener("task.moved", (event) => {
  const payload = JSON.parse(event.data);
});
```

SSE 的格式很朴素。每个事件以空行结束；`event:` 是事件名，`data:` 是 payload。浏览器会自动处理重连，这是它比手写 fetch stream 顺手的地方。

### 4. 鉴权：实时连接也必须过成员闸

实时接口不是“旁路”，不能因为它不是 tRPC 就绕过鉴权。

Day 51 的 SSE route 做了同样的三步：

```text
读取 cookie -> 校验 session -> 查 user -> requireMembership(workspaceSlug)
```

只有当前用户是工作区成员，才能订阅这个工作区事件。否则返回 401/403。这里复用了 Day 48 抽出来的 `requireMembership`，这就是前面坚持把权限逻辑集中起来的价值。

### 5. 事件总线：先做单实例内存版

今天新增的 `RealtimeEventBus` 做三件事：

- 记录某个 workspace 下有哪些 SSE subscriber
- 新连接进来时发送在线用户快照
- 有任务事件时广播给该 workspace 的所有 subscriber

它是内存里的 Map：

```text
workspaceId -> subscriberId -> subscriber
```

这个实现非常适合本地开发和单实例部署，但它有明确边界：

- 进程重启，在线状态清空
- 多实例部署时，A 实例上的事件推不到 B 实例上的连接
- 事件不持久化，离线用户收不到历史

这些不是 bug，是 Day 51 的范围。多实例广播可以用 Redis Pub/Sub；离线通知和历史记录是 Day 52 通知系统的主题。

### 6. 在线用户不是“连接数”

一个用户可能开两个浏览器标签页。如果简单用连接数展示在线人数，就会把同一个人算两次。

所以事件总线里做了去重：

```text
subscribers: tab1(user A), tab2(user A), tab3(user B)
online users: user A, user B
```

当 user A 打开第二个标签页时，不应该再广播一次 `presence.joined`。只有这个用户从 0 个连接变成 1 个连接，才算 joined；从 1 个连接变成 0 个连接，才算 left。

这是很多实时在线状态的第一处细节坑。

### 7. 心跳：长连接不能悄悄死掉

长连接会遇到中间代理、浏览器、网络切换等问题。连接看似还在，实际已经断了。

Day 51 每 25 秒发一个：

```json
{ "type": "ping", "at": "..." }
```

它有两个作用：

- 保持连接活跃，减少被代理当空闲连接关闭的概率
- 让客户端知道“这条实时连接还活着”

心跳不是业务事件，前端通常不需要展示，只需要用它更新连接状态。

### 8. 实时事件不是数据库事务的一部分

任务 mutation 的顺序是：

```text
写数据库成功 -> publish realtime event
```

不要反过来。事件是给客户端同步状态用的，数据库才是真相源。如果事件发了但数据库写失败，客户端会看到一条不存在的变化。

当然，这里还有一个更深的可靠性问题：数据库写成功后，进程正好崩了，事件可能没发出去。Day 51 接受这个风险，因为它做的是“在线协作提示”。Day 52 做通知时就不能这么随意，通知需要持久化和队列。

一句话区分：

- 实时事件：在线用户尽快同步，不保证离线可见
- 通知：用户之后也要看到，需要落库/队列/重试

### 9. 为什么不直接上 Socket.io

Socket.io 很好，尤其适合：

- 客户端也要通过长连接频繁发消息
- 需要房间、ack、重连状态管理
- 需要降级到 long polling

但它也会带来额外复杂度：

- Next.js App Router 下要额外管理自定义 server 或独立 socket 服务
- 部署时要处理 sticky session 或 Redis adapter
- 鉴权、心跳、断线重连都要接进 Socket.io 生命周期

Day 51 的需求是“服务端把任务事件推给浏览器”。SSE 用更少代码把主链路讲清楚。等需求变成协同编辑、实时光标、聊天室，再切 WebSocket 才有收益。

---

## 改动清单（Day 51 参考答案）

| 文件 | 是什么 |
|---|---|
| `src/server/realtime/events.ts` | 新增：实时事件类型定义 |
| `src/server/realtime/event-bus.ts` | 新增：单实例内存事件总线与在线用户管理 |
| `src/server/realtime/sse.ts` | 新增：SSE 文本编码 |
| `src/app/api/realtime/workspaces/[slug]/events/route.ts` | 新增：工作区 SSE 订阅接口 |
| `src/server/routers/tasks.ts` | 更新：任务写操作成功后发布实时事件 |

---

## 💻 实践练习

1. **启动项目**

   ```bash
   cd solutions/saas
   docker compose up -d
   pnpm prisma:push
   pnpm dev
   ```

2. **准备登录 cookie**

   先完成 Day 48/49 的注册、创建工作区、创建项目。假设 cookie 在：

   ```text
   /tmp/saas-cookie.txt
   ```

3. **打开 SSE 连接**

   ```bash
   curl -N -b /tmp/saas-cookie.txt \
     "http://localhost:3000/api/realtime/workspaces/acme-team/events"
   ```

   你应该先看到：

   ```text
   event: presence.snapshot
   data: ...
   ```

4. **另开终端创建任务**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/tasks.create" \
     -H "content-type: application/json" \
     --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","title":"Realtime card"}}'
   ```

   SSE 终端应收到：

   ```text
   event: task.created
   ```

5. **拖拽任务**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/tasks.reorder" \
     -H "content-type: application/json" \
     --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","number":1,"expectedVersion":1,"status":"TODO"}}'
   ```

   SSE 终端应收到：

   ```text
   event: task.moved
   ```

6. **思考题**

   - 为什么 SSE route 也必须调用 `requireMembership`？
   - 为什么在线用户要按 user 去重，而不是按连接数？
   - 如果部署两个实例，为什么内存事件总线会漏事件？Redis Pub/Sub 会怎么补？
   - 哪些事件应该只做实时推送，哪些事件必须进入 Day 52 的通知系统？

---

## ✅ 今日产出

- [ ] 能通过 SSE 订阅工作区实时事件
- [ ] 连接时能收到在线用户快照
- [ ] 多标签页不会重复计算同一个在线用户
- [ ] 任务创建/更新/移动/删除会推送实时事件
- [ ] 评论创建会推送实时事件
- [ ] SSE route 复用 session 和 workspace membership 鉴权
- [ ] 能说清 SSE、WebSocket、轮询的取舍
- [ ] 提交 Day 51 代码到 GitHub

---

[⬅️ Day 50](../day-50/) | [➡️ Day 52](../day-52/)
