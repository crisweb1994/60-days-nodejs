# Day 50 — 看板与列表视图 API

> Day 49 做完项目和任务 CRUD，系统已经能“记录任务”。但真正的任务管理产品不只是把任务存进去，还要让团队能快速看清局面：哪些卡在 backlog，哪些正在做，哪些等 review，谁负责，优先级多高，能不能拖到另一列，能不能翻页筛选。
>
> 这一天补的是**视图层 API**。它和 CRUD 的差别在于：CRUD 关心单条资源怎么写对，视图 API 关心一屏数据怎么一次性读顺、怎么排序稳定、怎么在拖拽后保持一致。
>
> 一句话目标：在 Day 49 的任务系统上补齐看板聚合、列表筛选分页、拖拽排序后端支持，让任务数据真正适合前端页面消费。

## 📋 今日目标

- 实现 `tasks.board`：按状态分组返回看板列，每列包含任务和数量
- 实现 `tasks.listView`：统一列表 API，支持筛选、搜索、排序、游标分页
- 实现 `tasks.reorder`：支持同列拖拽排序和跨列移动
- 使用分数排序法：通过相邻两张卡的 `order` 中值完成重排
- 继续复用 Day 48/49 的鉴权、RBAC、状态机和乐观锁
- 明确视图 API 的边界：今天不做前端看板、不做实时同步、不做全文搜索引擎

> 配套代码：`solutions/saas/`。新增 `src/server/domain/cursor.ts`，并扩展 `tasksRouter`：`board`、`listView`、`reorder`。Day 50 的 solution 统一落在 `solutions/saas`。

---

## 📖 核心知识点

### 1. 为什么 CRUD 之后还需要视图 API

CRUD 接口通常围绕“资源”设计：

```text
create task
get task
update task
delete task
```

但前端页面不是按资源孤立使用数据的。看板页需要的是：

```text
一个项目下所有任务
  -> 按 status 分成 6 列
  -> 每列按 order 排好
  -> 每张卡带 assignee、priority、labels
```

列表页需要的是：

```text
一批任务
  -> 可以按状态/优先级/负责人/标签筛选
  -> 可以按更新时间/创建时间/编号排序
  -> 可以稳定翻页
```

如果让前端自己调用十几个 CRUD 接口拼页面，会有三个问题：

- 请求多：每列一次、每张卡再查标签/负责人，页面容易变慢
- 规则散：排序、筛选、权限判断分散到前端，后续难维护
- 数据不一致：多个请求之间任务被别人改了，页面拼出来的状态可能互相打架

所以真实项目里会有一层**读模型 API**。它不一定对应数据库里的某张表，而是对应前端的一屏工作流。Day 50 做的 `board` 和 `listView` 就是两个典型读模型。

### 2. 看板读模型：按列返回，而不是让前端自己 group

看板最自然的数据形状不是一维数组，而是列：

```json
{
  "columns": [
    { "status": "BACKLOG", "count": 2, "tasks": [] },
    { "status": "TODO", "count": 4, "tasks": [] },
    { "status": "IN_PROGRESS", "count": 1, "tasks": [] }
  ]
}
```

服务端返回列有两个好处：

1. **状态列顺序稳定**。前端不用知道 `TaskStatus` 的枚举顺序，也不用担心某一列没有任务时消失。
2. **排序规则统一**。每列里的任务都按 `order ASC, createdAt ASC` 排好，前端只负责渲染。

今天的实现里，`tasks.board` 会先按项目和筛选条件查出任务，再用 `TaskStatus` 枚举生成所有列。即使 `DONE` 没有任务，也会返回一个空列。这对前端很重要：空列也能拖进去。

### 3. 列表读模型：筛选、搜索、排序放在一个入口

列表页和看板页不一样。看板关心“列”，列表关心“查找”：

```text
我负责的高优先级任务
某个标签下还没完成的任务
标题或描述里包含 billing 的任务
按最近更新排序
```

如果每个组合都做一个接口，很快会爆炸。所以 Day 50 做一个统一的 `tasks.listView`：

```ts
{
  workspaceSlug,
  projectKey?,
  status?,
  assigneeId?,
  priority?,
  labelName?,
  q?,
  sortField,
  sortDirection,
  limit,
  cursor?
}
```

几个约束很重要：

- `sortField` 白名单化，只允许 `createdAt / updatedAt / number`
- `limit` 限制在 1-100，防止一次拉爆数据库
- `q` 只做轻量 `contains`，今天不引入 Elasticsearch/Meilisearch
- `projectKey` 可选；不传时就是工作区级任务列表

这就是“高级筛选”的正确姿势：参数可以组合，但每个参数都被 schema 收紧，不能让客户端把任意字段名、任意排序列、任意 SQL 片段传进来。

### 4. 游标分页：为什么不用 offset

`offset` 最大的问题不是语法丑，而是越翻越慢：

```sql
LIMIT 30 OFFSET 30000
```

数据库必须先走过前 30000 行，再丢掉它们。数据越多，越难受。而任务列表是高频页面，不能把性能问题埋进去。

Day 50 的 `listView` 用 keyset cursor。cursor 里存两件事：

```json
{
  "value": "2026-07-01T10:00:00.000Z",
  "id": "..."
}
```

`value` 是当前排序字段的最后一个值，`id` 是兜底稳定排序键。下一页查询：

```text
updatedAt < 上一页最后一条 updatedAt
或
updatedAt = 上一页最后一条 updatedAt 且 id < 上一页最后一条 id
```

为什么要带 `id`？因为很多任务可能有相同的 `updatedAt`。只靠时间会漏数据或重复数据；加上唯一的 `id`，排序就变成稳定的二元组。

### 5. 分数排序：拖拽为什么不用整型位置

看板拖拽最常见需求：

```text
把 A 卡拖到 B 和 C 中间
```

如果用整数位置：

```text
B.position = 2
C.position = 3
```

A 没地方插。你只能把 C 以及后面的所有卡都整体 +1。列里 500 张卡时，一次拖拽可能更新几百行。

Day 50 使用分数排序法：

```text
B.order = 2000
C.order = 3000
A.order = (2000 + 3000) / 2 = 2500
```

只更新被拖动的那一张卡。插到最前面：

```text
after.order = 1000
new.order = 0
```

插到最后面：

```text
before.order = 5000
new.order = 6000
```

这就是为什么 Day 46 schema 里 `Task.order` 用 `Float`。它不是数学洁癖，而是为了让拖拽排序成为 O(1) 写操作。

### 6. 分数排序的代价：迟早要重平衡

分数排序也不是白送。一直在同两张卡之间插入，中间空隙会越来越小：

```text
1000
1500
1250
1125
1062.5
...
```

到某个程度，浮点精度会不够。真实产品的做法通常有三种：

| 方案 | 做法 | 适合 |
|---|---|---|
| 定期重平衡 | 把一列重新编号成 1000、2000、3000 | 简单 MVP |
| 检测小间隔后重平衡 | 只有间隔过小时重排该列 | 中小规模看板 |
| LexoRank | 用可无限插入的字符串 rank | 高并发、大规模协作 |

Day 50 先做 MVP 方案：接口层算中值，保留将来重平衡的升级空间。先不要一上来实现 LexoRank，它会把学习重点从业务 API 拉到排序算法细节里。

### 7. 拖拽排序不是绕过状态机

拖拽经常同时做两件事：

```text
改变位置
改变状态列
```

比如从 `TODO` 拖到 `IN_PROGRESS`。这其实也是状态流转，所以不能绕过 Day 49 的状态机。`tasks.reorder` 会先判断：

```ts
canTransitionTaskStatus(oldStatus, targetStatus)
```

允许，才更新 `status + order`；不允许，返回 400。这样前端拖拽不会成为偷偷修改非法状态的后门。

### 8. 拖拽也要乐观锁

拖拽排序同样会并发冲突：

```text
你看到任务 A version=3
同事先把 A 拖到了 DONE，version 变成 4
你再把 A 从旧位置拖到 TODO
```

如果服务端不校验 version，就会把同事刚做的状态覆盖掉。所以 `tasks.reorder` 和 `tasks.update` 一样，要求 `expectedVersion`。

冲突时返回 409，让前端刷新看板后再拖。这个体验比“静默覆盖别人操作”好得多。

### 9. 视图 API 和权限：永远从服务端解析归属

`board/listView/reorder` 都只接受：

```text
workspaceSlug + projectKey + task number
```

它们不会相信前端传来的 `workspaceId`。服务端自己查：

```text
workspaceSlug -> Workspace
projectKey -> Project
task number -> Task
Membership(userId, workspaceId)
```

这条链是 Day 46 的主线，也是整个 SaaS 的安全边界。只要视图 API 也坚持这条链，后面的前端页面就不容易把权限判断写散。

---

## 改动清单（Day 50 参考答案）

| 文件 | 是什么 |
|---|---|
| `src/server/domain/cursor.ts` | 新增：游标 encode/decode，统一列表分页游标 |
| `src/server/routers/tasks.ts` | 更新：新增 `board`、`listView`、`reorder` |
| `README.md` | 更新：补 Day 50 API 快速试跑 |

---

## 💻 实践练习

> 下面假设你已经注册、登录、创建了 `acme-team` 工作区，并创建了 `ENG` 项目。

1. **创建几张任务卡**

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/tasks.create" \
     -H "content-type: application/json" \
     --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","title":"Build board API","priority":"HIGH","labelNames":["backend"]}}'
   ```

2. **读取看板**

   ```bash
   curl -g -b /tmp/saas-cookie.txt \
     "http://localhost:3000/api/trpc/tasks.board?input={\"json\":{\"workspaceSlug\":\"acme-team\",\"projectKey\":\"ENG\"}}"
   ```

   检查返回里是否有 `BACKLOG / TODO / IN_PROGRESS / IN_REVIEW / DONE / CANCELLED` 六列。

3. **读取列表视图**

   ```bash
   curl -g -b /tmp/saas-cookie.txt \
     "http://localhost:3000/api/trpc/tasks.listView?input={\"json\":{\"workspaceSlug\":\"acme-team\",\"projectKey\":\"ENG\",\"limit\":20,\"sortField\":\"updatedAt\",\"sortDirection\":\"desc\"}}"
   ```

   如果返回 `nextCursor`，把它带入下一次请求，验证翻页。

4. **拖拽排序 / 跨列移动**

   假设任务 1 当前 `version = 1`，把它拖到 `TODO` 列末尾：

   ```bash
   curl -b /tmp/saas-cookie.txt \
     -X POST "http://localhost:3000/api/trpc/tasks.reorder" \
     -H "content-type: application/json" \
     --data '{"json":{"workspaceSlug":"acme-team","projectKey":"ENG","number":1,"expectedVersion":1,"status":"TODO"}}'
   ```

5. **验证状态机没有被绕过**

   试着把 `TODO` 任务直接拖到 `DONE`，应该返回 400。

6. **验证乐观锁**

   用旧 `expectedVersion` 再拖一次同一张任务，应该返回 409。

---

## ✅ 今日产出

- [ ] `tasks.board` 能按状态返回看板列
- [ ] 空状态列也会返回，前端可以直接渲染
- [ ] `tasks.listView` 支持筛选、搜索、排序、游标分页
- [ ] `tasks.reorder` 支持同列排序和跨列移动
- [ ] 拖拽排序使用 `order` 中值，只更新被移动任务
- [ ] 跨列拖拽仍然受状态机限制
- [ ] 拖拽和更新一样使用 `expectedVersion` 防并发覆盖
- [ ] 提交 Day 50 代码到 GitHub

---

[⬅️ Day 49](../day-49/) | [➡️ Day 51](../day-51/)
