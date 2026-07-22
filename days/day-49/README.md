# Day 49 — 项目与任务 CRUD

> Day 48 把「谁在团队里、是什么角色」落进了代码。今天终于进入任务管理平台的核心业务：项目和任务。
>
> 但这一天不只是 CRUD。真正容易写坏的是两处：第一，任务编号不是数据库自增 id，而是项目内编号 `ENG-42`，必须在事务里取号，不能并发撞；第二，任务状态不是随便改一个 enum 字段，而是有明确流转规则，避免从 `BACKLOG` 一步跳到 `DONE` 这种业务含义不清的写法。
>
> 一句话目标：实现项目 CRUD、任务 CRUD、状态流转、优先级、指派、标签和评论，让 SaaS 平台有第一块真正可用的业务核心。

## 📋 今日目标

- 实现项目 API：创建、列表、详情、更新、软删除
- 实现任务 API：创建、列表、详情、更新、软删除
- 实现项目内任务编号：`ProjectTaskCounter` 事务取号
- 实现任务状态流转：显式 transition table，而不是任意改 enum
- 支持优先级、指派人、截止日期、标签、评论
- 复用 Day 48 的工作区成员与 RBAC：成员可写任务，ADMIN 可管项目

> 配套代码：`solutions/saas/`。新增 `projectsRouter`、`tasksRouter`、`task-status` 领域规则，并把 Day 48 的 `requireMembership` 抽到 `auth/workspace-access.ts` 给后续业务复用。

---

## 📖 核心知识点

### 1. 项目是任务的边界

任务不是直接挂在工作区上，而是：

```text
Workspace -> Project -> Task
```

这条链有两个价值：

- 授权：查任务时先找到项目，再回到工作区，判断当前用户是不是成员
- 编号：任务编号在项目内自增，所以 `ENG-42` 和 `WEB-42` 可以同时存在

项目 API 的权限比任务更高：创建、更新、删除项目要求 ADMIN，因为它会改变团队结构；任务日常创建和更新要求 MEMBER，因为普通成员就是来协作写任务的。

### 2. 任务编号：不能靠 `count + 1`

最容易写错的编号方案是：

```text
number = 当前项目任务数量 + 1
```

两个用户同时创建任务时，它们都读到 count = 41，于是都想创建 42，直接撞唯一约束。

Day 46 已经设计了 `ProjectTaskCounter`，今天把它用起来：

```text
事务开始
  UPDATE project_task_counters SET next_number = next_number + 1 RETURNING next_number
  number = next_number - 1
  INSERT task(number)
事务提交
```

PostgreSQL 会对这行 counter 加行锁。同一个项目的并发建卡会排队取号，不会撞，也不会回收软删任务的旧编号。

### 3. 状态机：任务状态不是随便改字段

今天的状态流转：

```text
BACKLOG -> TODO -> IN_PROGRESS -> IN_REVIEW -> DONE
   |          |          |             |
   v          v          v             v
CANCELLED <- CANCELLED <- CANCELLED <- CANCELLED
```

另外允许一些回退：

- `IN_PROGRESS -> TODO`
- `IN_REVIEW -> IN_PROGRESS`
- `DONE -> IN_REVIEW`
- `CANCELLED -> BACKLOG`

代码里不是引入完整 XState，而是先用一张 transition table：

```ts
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  BACKLOG: [TaskStatus.TODO, TaskStatus.CANCELLED],
  TODO: [TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
  // ...
};
```

MVP 这样就够。等状态规则变复杂，比如不同角色有不同流转、流转时触发通知、自动记录审计日志，再引入 XState 或更完整的 workflow engine。

### 4. 乐观锁：更新任务必须带 version

任务是高协作实体。两个人同时打开同一张卡，一个改标题，一个改优先级，如果服务端无脑覆盖，就会出现后提交的人把前一个人的修改冲掉。

今天的 `tasks.update` / `tasks.transition` 都要求传：

```json
{ "expectedVersion": 1 }
```

服务端先比对当前 `task.version`，不一致就返回 409。成功更新后 `version + 1`。这就是 Day 29 学过的乐观锁在真实业务里的用法。

### 5. 标签：工作区级共享

标签不是项目级，也不是任务里一个字符串数组，而是：

```text
Workspace -> Label
Task -> TaskLabel -> Label
```

这样同一个工作区里的多个项目可以共享 `bug`、`frontend`、`urgent` 等标签。今天创建任务时支持传 `labelNames`，服务端会在事务里 `upsert Label`，再创建 `TaskLabel` 关系。

### 6. 删除：任务和项目先软删

Day 46 的 ADR-004 已经定了：内容实体软删除。今天项目删除和任务删除都只是写 `deletedAt`。

列表查询默认带：

```ts
deletedAt: null
```

这样误删可以恢复，编号也不会复用。`ENG-42` 删除后，下一张仍然是 `ENG-43`，不会再出现一个新的 `ENG-42` 让团队沟通混乱。

### 7. 删除任务的资源闸

Day 46 讲过权限有三道：

```text
成员闸 -> 角色闸 -> 资源闸
```

今天 `tasks.delete` 体现第三道闸：

- ADMIN / OWNER 可以删除任意任务
- 普通 MEMBER 只能删除指派给自己的任务

这不是完整 ACL，但已经比单纯「成员都能删」更接近真实产品。

---

## 改动清单（Day 49 参考答案）

| 文件 | 是什么 |
|---|---|
| `src/server/auth/workspace-access.ts` | 新增：工作区 slug/name schema 与 `requireMembership` |
| `src/server/domain/task-status.ts` | 新增：任务状态流转表 |
| `src/server/routers/projects.ts` | 新增：项目 CRUD，创建项目时初始化取号器 |
| `src/server/routers/tasks.ts` | 新增：任务 CRUD、状态流转、标签、评论 |
| `src/server/routers/workspaces.ts` | 更新：复用共享工作区鉴权 helper |
| `src/server/routers/_app.ts` | 更新：挂载 `projects` / `tasks` router |

---

## 💻 实践练习

> 下面假设你已经完成 Day 48 的注册登录，并把 cookie 存在 `/tmp/saas-cookie.txt`。

1. **创建项目**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/projects.create" \
     -H "content-type: application/json" \
     --data '{"json":{"workspaceSlug":"acme-team","key":"ENG","name":"Engineering"}}'
   ```

2. **创建任务**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/tasks.create" \
     -H "content-type: application/json" \
     --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","title":"Ship Day 49","priority":"HIGH","labelNames":["backend","day49"]}}'
   ```

3. **列表查看任务**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     "http://localhost:3000/api/trpc/tasks.list?input={\"json\":{\"workspaceSlug\":\"acme-team\",\"projectKey\":\"ENG\"}}"
   ```

4. **状态流转**

   假设刚创建的任务 `number = 1`、`version = 1`：

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/tasks.transition" \
     -H "content-type: application/json" \
     --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","number":1,"expectedVersion":1,"status":"TODO"}}'
   ```

5. **验证状态机**

   试着从 `TODO` 直接流转到 `DONE`，应该返回 400，因为中间必须经过 `IN_PROGRESS -> IN_REVIEW`。

6. **验证乐观锁**

   用旧的 `expectedVersion` 再更新一次同一个任务，应该返回 409。

---

## ✅ 今日产出

- [ ] 能创建/列表/查看/更新/软删除项目
- [ ] 创建项目时初始化 `ProjectTaskCounter`
- [ ] 能创建/列表/查看/更新/软删除任务
- [ ] 任务编号按项目内自增生成，不复用软删编号
- [ ] 状态流转受 transition table 限制
- [ ] 更新任务时用 `version` 做乐观锁
- [ ] 标签、指派人、截止日期、评论可用
- [ ] 提交 Day 49 代码到 GitHub

---

[⬅️ Day 48](../day-48/) | [➡️ Day 50](../day-50/)
