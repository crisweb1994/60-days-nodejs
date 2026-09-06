# Day 56 - 测试策略：给 SaaS 平台补上测试体系

前 55 天写下的每一行代码，验证方式都是同一个：打开页面，点一遍，看看对不对。一个人、一个功能、当天写当天测，这样做没问题。Day 55 上线之后条件变了——代码跑在生产环境里，改动的验证成本从"重新点一遍"变成了"可能弄坏别人正在用的东西"。今天的任务是把"点一遍"变成可以自动重复执行的断言。

还有一个更具体的动机。Day 55 的 CI 已经会跑迁移、类型检查和构建，但它在 README 里留了一句实话：build 绿了不等于业务正确。TypeScript 能证明 `string` 没传成 `number`，证明不了"任务从 DONE 不能直接拖回 TODO"。这一层要靠测试，而它昨天还不存在。

## 今日目标

- 理解测试金字塔、测试奖杯这些模型在争论什么，而不是背一个形状
- 学会用"哪里错了会疼"来圈定值得测的范围
- 用 Vitest 给纯逻辑写单元测试（状态机、游标、会话令牌、权限矩阵）
- 用 tRPC 的 `createCaller` 配合真实 PostgreSQL/Redis 写集成测试
- 用 Playwright 写少量关键路径 E2E，掌握 web-first 断言
- 把三层测试接进 CI，并理解覆盖率数字的正确用法

今天的参考实现位于 `solutions/saas`，所有测试都在本机真实跑通过。

---

## 1. 先想清楚测什么，再纠结用什么框架

测试金字塔说底层要有大量单元测试，顶上是少量 E2E；Kent C. Dodds 提出的测试奖杯（Testing Trophy）模型认为集成测试才应该占大头，底座是类型检查这类静态手段。Google 自己后来又发了篇《Pyramid or Crab?》，意思是形状取决于具体场景，别当教条。这些模型争论的其实是同一件事：**测试跑得快和测得真之间怎么取舍**。

- 单元测试快、定位准，但为了快必须隔离依赖，隔离本身就是一种失真
- E2E 最接近用户实际看到的效果，但慢、容易受环境影响，挂了不知道该修哪一层
- 集成测试夹在中间：保留真实的数据库和业务组装，只去掉浏览器

对一个后端为主的项目，我更认同奖杯模型的分配，原因很实际：这套 SaaS 的核心风险几乎都不在纯函数里，而在"权限检查有没有在查询之前执行""乐观锁在并发更新时返不返回 CONFLICT""通知偏好关掉之后还会不会写库"这类跨模块的行为里。单独测任何一个函数都证明不了这些。

但金字塔没有错。状态机转移表、cursor 编解码这类纯逻辑，用单元测试穷举组合是几毫秒的事，用集成测试覆盖同样的分支要慢两个数量级。所以最终的形状是：

| 层 | 数量 | 跑什么 | 本项目实测耗时 |
|---|---|---|---|
| 单元 | 30 | 纯函数与纯内存模块 | < 1s |
| 集成 | 37 | tRPC 路由 + 真实 PG/Redis | ~10s |
| E2E | 2 | 注册到建任务的完整浏览器流程 | ~25s（含 dev server 冷启动） |

数字自己会说话：越往上越贵。E2E 不是主要回归手段，是最后的兜底。

### 用"错了会疼"圈范围

"测试要覆盖核心业务逻辑"是句废话，落到这套项目上，我圈出来的是这些：

- **任务状态机**：DONE 的任务被拖回 TODO，看板语义就坏了，而且静默发生
- **乐观锁**：两个人同时编辑同一张任务，后提交的必须被拒绝
- **RBAC 边界**：VIEWER 建任务、MEMBER 删别人的任务、非成员探到工作区内的项目——权限泄漏是事故
- **会话令牌**：签名、过期、Cookie 属性，任何一件坏了都是安全问题不是功能问题
- **cursor 分页**：翻页丢数据或重复，用户很难发现但会一直存在
- **通知偏好**：用户关掉的提醒还在发，是对信任的直接消耗

反过来，`calculateOrder` 返回 `(before + after) / 2` 这种一行公式不值得单独造测试文件——集成测试里的 reorder 用例会顺路验证它。范围圈定本身就是在做取舍：测得太少是风险，测得太多是维护负担，两条路都会让测试体系在三个月内被放弃。

---

## 2. 为什么是 Vitest，而不是大纲里写的 Jest

ROADMAP 里这一天写的是 Jest，参考实现最终用了 Vitest。这不是随手换个新潮工具，理由值得摆出来：

1. **这个项目的模块体系是 ESM。** Jest 对 ESM 的支持至今带着实验性标志，`transformIgnorePatterns` 的坑每个踩过的人都不想再踩。Vitest 基于 Vite 的原生 ESM 管线，`import` 什么都不用配。
2. **API 几乎兼容。** `describe/it/expect` 一致，迁移成本低到可以随时反悔。
3. **速度。** 2026 年的几组公开基准里，Vitest 冷启动比 Jest 快数倍；对本项目这种规模差距不明显，但 watch 模式的响应速度是每天写代码都能感觉到的。

Jest 仍然是存量代码库的事实标准，npm 周下载量仍然领先不少。如果你在维护一个已经跑着 Jest 的仓库，没有理由为了新而迁。另外 Node 原生的 `node:test` 在纯 JS 场景下更快、零依赖，值得知道——但它的生态（UI、coverage 集成、setup 体系）还撑不起这个项目需要的结构。

配置里值得说明的一点：单元和集成分成两个 project，而不是混在一起。

```ts
// solutions/saas/vitest.config.ts（节选）
projects: [
  { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], ... } },
  { test: { name: "integration", include: ["tests/integration/**/*.test.ts"], ... } },
]
```

分开的动机是依赖边界：单元测试不连数据库，`docker compose` 没起也应该能跑；集成测试需要 `.env.test` 里的连接串，没配就在启动时报一句人话，而不是每个用例各挂一遍。CI 里两者是两条命令，本地开发改一个纯函数时只跑 `pnpm test:unit`，一秒内出结果。

---

## 3. 单元测试：把纯逻辑的组合跑满

一段代码值不值得写单元测试，先看它里面有多少判断和边界。这套项目里最值得测的是状态机：

```ts
// tests/unit/task-status.test.ts
it("未声明的组合一律拒绝", () => {
  const legalPairs = new Set(
    ALL_STATUSES.flatMap((from) =>
      allowedTaskStatusTransitions(from).map((to) => `${from}->${to}`),
    ),
  );

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const key = `${from}->${to}`;
      if (legalPairs.has(key) || from === to) continue;
      expect(canTransitionTaskStatus(from, to), key).toBe(false);
    }
  }
});
```

六种状态的全组合是 36 格，跑一遍不到 3 毫秒。用抽样测同样的逻辑，等于把"忘了加进转移表的格子"留给生产环境去发现。

会话令牌的测试思路类似但多一层：除了 roundtrip，还要主动构造攻击输入——换掉 payload 保留旧签名、签名正确但已过期、签名正确但缺 userId。第三种尤其值得写：它覆盖的是签名校验通过**之后**的分支，不刻意构造就永远走不到。

```ts
// tests/unit/session.test.ts
it("签名正确但已过期的令牌被拒绝", () => {
  const expired = forgeToken({
    userId: "user-123",
    expiresAt: Date.now() - 1000,
    nonce: "n",
  });
  expect(verifySessionToken(expired)).toBeNull();
});
```

`forgeToken` 能存在，是因为单元测试的 setup 里 `SESSION_SECRET` 是一个写死的已知值——测试拿得到密钥，才能替你签出"合法但内容异常"的令牌。这是单元测试隔离环境带来的便利：同一个测试放进集成环境（密钥随机）就写不出来。

密码模块测的是另外三件事：随机盐（同密码两次哈希不同）、格式防御（数据库里存了 `null` 或损坏的哈希时返回 `false` 而不是抛异常）、以及 `timingSafeEqual` 路径的长度对齐前提。最后一点很隐蔽：实现里先比较长度再走常数时间比较，跳过长度检查的话 `timingSafeEqual` 会直接 throw。

有一个测试我没写，值得说一下为什么：`allowedTaskStatusTransitions` 返回的是内部转移表的数组引用，调用方一旦原地修改就会污染全局状态。我最初写了个"防污染"断言，后来发现它只是在断言 spread 复制的行为，对实现毫无约束，删掉了。这是新手（包括我）常犯的错误——**测试要对着被测代码的承诺写，而不是对着自己想象中的实现写**。真要修这个问题，正确动作是让函数返回拷贝，然后测试转型为守护这个承诺。

---

## 4. 集成测试：tRPC 改变了 Supertest 的经典位置

传统 Node 教程里，集成测试的标准做法是 Supertest：把 Express app 传给它，在进程内发 HTTP 请求，不用真的占端口。这套项目的技术栈让这个做法变得别扭——业务不在 Express app 里，在 tRPC router 里，HTTP 层只剩 Next.js 的 fetch adapter 一层薄壳。Supertest 能测到的东西（Cookie 解析、CORS、adapter 组装）恰恰不是风险所在。

tRPC 官方给的答案是 `createCaller`：

```ts
// tests/integration/test-utils.ts（节选）
export function callerFor(user: TestUser | null) {
  return appRouter.createCaller({
    prisma,
    req: new Request("http://test.local"),
    resHeaders: new Headers(),
    user,
  });
}
```

它返回一个和客户端 proxy 长得很像的对象，区别在于调用方式——**过程直接当函数调，没有 `.query()`/`.mutate()` 后缀**。这是 server caller 和 client proxy 最容易混的地方，我就先踩了这一脚：按客户端习惯写 `caller.tasks.create.mutate({...})`，tRPC 会把整条路径拼成 `tasks.create.mutate` 去查 procedures 表，报一个没头没尾的 `Cannot read properties of undefined (reading '_def')`。

这个取舍的账要算清楚：

- 换来的是：毫秒级调用、普通函数式的断言、上下文可以精确注入（想以 VIEWER 身份调用就传 VIEWER 的 user）
- 付出的是：Cookie 序列化、CORS、fetch adapter 这些 HTTP 层行为不在覆盖范围里

第二件事不是赖账，是明确移交给了 E2E——浏览器跑真请求时自然会覆盖到。

### 数据库：真的还是假的

集成测试最常见的偷懒是 mock 掉 Prisma：`prisma.task.findFirst.mockResolvedValue(...)`。写起来快，但它把测试对象换掉了——你在测"如果 Prisma 返回这个，路由会做什么"，而真实世界里出问题的往往是"那个 `where` 条件根本查不出你以为的东西"。Day 50 看板查询、Day 28 的 cursor 分页，出过的 bug 都在这一层。

所以集成测试连真库：`docker compose` 起的 PostgreSQL 16，专用的 `saas_test` 数据库，和开发库 `saas` 物理隔离。隔离策略用的是 TRUNCATE：

```ts
// tests/integration/test-utils.ts（节选）
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRaw<
    Array<{ tablename: string }>
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
  const names = tables
    .map((row) => row.tablename)
    .filter((name) => name !== "_prisma_migrations");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${names.map((name) => `"${name}"`).join(", ")} RESTART IDENTITY CASCADE`,
  );
}
```

每个用例的 `beforeEach` 清一次库，清完之后表里只有这个用例自己写入的数据——断言可以写死 `number` 从 1 开始，不用先查一遍当前值。TRUNCATE 比 DELETE 快（不逐行、可 RESTART IDENTITY 重置序列），比"每用例开事务最后回滚"简单（不用把事务边界穿透到被测代码内部，Prisma 的 `$transaction` 会嵌套冲突）。代价是隔离粒度粗到"整个库"，于是有了下一条纪律：

**集成测试文件必须串行执行。** 两个文件并发时，A 文件的 TRUNCATE 会和 B 文件正在写入的 INSERT 抢锁，PostgreSQL 直接报死锁。这里有个我亲手踩出来的坑值得原样记录：我把 `fileParallelism: false` 写在了 project 配置里，Vitest 安静地忽略了它（`ProjectConfig` 类型里根本没有这个字段，多余的键不报错），测试文件照常并发，报出来的死锁错误完全不像配置问题。最后是把配置提到根级才生效。教训：**配置不生效时不会有人通知你，验证并行设置要靠并发冲突这种事故**。

Redis 走同一条思路但便宜些：队列用 db 15（开发队列在 db 0），邮件入队是真实断言——`emailStatus` 最终是 `QUEUED` 而不是 mock 出来的。通知偏好关掉邮件的用例断言 `SKIPPED`，两者都只有在 Redis 和 PG 都真实工作时才成立。

### 测试数据也走真实路由

在测试里"注册一个用户"有两条路：直接 `prisma.user.create` 插库，或者调用 `auth.register` 路由。参考实现选了后者：

```ts
export async function seedWorld() {
  const { user } = await callerFor(null).auth.register({...});
  const { workspace } = await callerFor(user).workspaces.create({...});
  await callerFor(user).projects.create({...});
  return { user, caller: callerFor(user), workspaceSlug: slug, projectKey };
}
```

多花几十毫秒，买到的额外覆盖是"一个新用户能走通最短的上手流程"这件事本身。哪天注册路由被改坏，所有测试会在 setup 阶段集体报警，而不是在每个用例里各挂一次然后让人怀疑人生。

---

## 5. E2E：两条测试，一张安全网

E2E 的筛选标准只有一条：这条路径挂了，产品对用户来说就是不可用。过筛的只有两条：

1. 注册 → 建工作区 → 建项目 → 看板建任务 → 刷新后还在
2. 错误密码登录被拒绝，错误信息可见

第一条覆盖了从 Cookie 到数据库再到 React 渲染的完整链路，中间任何一环坏了都逃不掉。第二条是第一条的反面验证——认证是安全边界，失败路径和成功路径同等重要。看板拖拽、通知、统计这些没有进 E2E：它们的业务正确性已经被集成测试覆盖，浏览器层再演一遍是花 20 秒买集成测试 200 毫秒就能买到的信心。

Playwright 的核心纪律只有一条：**相信自动等待，永远不写 `waitForTimeout`**。

```ts
// tests/e2e/critical-path.spec.ts（节选）
const todoColumn = page
  .getByRole("heading", { name: "待开始" })
  .locator("..")
  .locator("..");
await expect(todoColumn).toContainText("第一张 E2E 任务");
```

点击"添加任务"之后没有任何 sleep——`expect(...).toContainText` 自己会轮询到任务渲染出来为止。硬等待的问题是它把"今天这台机器上刚好够用"固化成了代码，CI 机器慢一点就开始随机挂，这正是 flaky 测试最经典的来源。

选择器全部用可访问名称（label 文案、button 文案），不用 class 和 DOM 层级。理由和集成测试不 mock Prisma 一脉相承：class 改名不该弄坏测试，测试要绑定的是用户实际依赖的东西——看得到的文字和标签。

实跑还留下三条具体的坑，都值得记住：

- 页面上有两个 accessible name 是"登录"的按钮（模式切换和表单提交），`getByRole("button", { name: "登录" })` 触发严格模式冲突。表单提交改用密码框回车
- `getByRole("alert")` 会同时匹配 Next.js 的 route announcer（它也是 alert 角色），按文案断言更稳
- 我断言新任务出现在"待整理"列，实际落在"待开始"——快速新建的默认 status 是 `TODO`。**测试第一次就该怀疑自己对业务的理解，而不是先怀疑代码**

E2E 用 dev server（`next dev -p 3210`）而不是生产构建，是参考实现的明确取舍：省掉每轮 build 的两三分钟，代价是编译开销让用例变慢、且测的不是产物。团队规模变大后应该换成 `next build && next start`，这个切换只是 webServer 命令一行的事。

---

## 6. 覆盖率：80.28%，以及为什么配置里没有 threshold

实测数字：`src/server` 行覆盖 80.28%、分支 79.32%、函数 97.56%。正好够到 ROADMAP 定的 80% 线，但参考实现的 vitest 配置里**没有**设 threshold 门槛，这是故意的。

覆盖率行业里最尖锐的批评是那句"你到了 80%，我猜是哪 80%"：阈值一旦成为 KPI，人会本能地去测最容易达标的部分——getter、DTO、 happy path——而剩下的 20% 恰恰是最难也最要命的错误分支。100% 覆盖率同样不值得一追：它证明每一行都被执行过，不证明任何一行是对的。

比数字更有用的是盯着**未覆盖清单**做决策。当前这份清单里：

- `analytics.completionTrend` 的空数据分支、`health.ping` 的数据库故障分支——概率低，先接受
- `workspaces.invite` 邀请接受流程——业务上重要，是下一步该补的第一优先级
- `mail-worker.ts` 从 coverage 里排除了：它是个常驻进程，单测它的意义有限，它的验证方式是 Day 55 的部署冒烟

配置里还有两个同类决策：只统计 `src/server`（组件层逻辑薄，为凑数去补组件测试本末倒置），排除 `_app.ts`（纯组装，没有分支）。覆盖率报告的价值在 review 时回答"这次改动波及的行为测到了吗"，不在年终汇报时回答"我们有多少百分比"。

---

## 7. 接进 CI：补上 Day 55 留下的缺口

Day 55 的 CI 顺序是 install → migrate → typecheck → build → docker build。测试插在中间：

```yaml
- run: pnpm test:unit
- run: pnpm test:integration
- run: pnpm build
```

单元在前是因为它最快，挂了能省掉后面所有步骤的等待时间。集成测试直接用 workflow 已有的 PostgreSQL/Redis service containers——Day 55 为迁移验证准备的基础设施，今天测试直接复用，这也是当时把 service containers 而不是 Testcontainers 写进 CI 的回报：依赖声明一次，迁移和测试共享。Testcontainers 的优势在本地与 CI 一致、容器生命周期写进测试代码，如果将来测试需要特殊的数据库扩展或版本矩阵，再迁不迟。

E2E 单独一个 job：独立数据库（`saas_e2e_ci`）、`playwright install --with-deps chromium`、失败时上传 trace 和截图 artifact。不并进 verify job 是因为它慢（浏览器下载 + dev server 启动），PR 迭代时不该让每轮 push 都等它，可以先让它非必须（`continue-on-error` 可选）跑着观察稳定性，再升级为必须通过的关卡。

到这里，CI 的承诺升级了：从"这个提交能构建、类型没破"变成"这个提交没有破坏已知的行为"。

---

## 8. Flaky 不是运气问题，是设计问题

测试体系的死法通常不是"写不出来"，是"没人再信任它"。信任流失从第一条 flaky 测试开始：红了，重跑，绿了，大家心照不宣地忽略，然后某天真 bug 的红也被忽略了。

常见成因这份代码里都做了对应的防御：

| 成因 | 本项目的对策 |
|---|---|
| 硬等待 | E2E 全部 web-first 断言，零 `waitForTimeout` |
| 测试间共享状态 | 每用例 TRUNCATE 清库 |
| 数据冲突（重名 slug/email） | 时间戳 + 随机后缀生成唯一值 |
| 文件并发抢锁 | 根级 `fileParallelism: false` 强制串行 |
| 依赖执行顺序 | 每个用例自己准备数据，不依赖前一个用例的残留 |

设计原则只有一句：**一个用例的成败只取决于它自己的代码和被测代码**。做到这一点，"重跑一次看看"就从日常操作变成了异常信号。

真出现 flaky 时的处置可以参考 Martin Fowler 推广的"先隔离、后修复"（quarantine-then-fix）：先隔离（标记 skip 或移出主套件），让 CI 恢复可信，然后限期修掉——隔离不是终点，被隔离的测试每多躺一天，就少一天的覆盖。隔离要有记录、有 owner、有期限，否则"临时 skip"会变成永久的沉默。

---

## 9. 本次参考实现的文件清单

| 文件 | 作用 |
|---|---|
| `vitest.config.ts` | unit/integration 双 project，覆盖率范围声明 |
| `tests/unit/setup-env.ts` | 单元测试的假环境变量（含固定 SESSION_SECRET） |
| `tests/unit/task-status.test.ts` | 状态机全组合（36 格） |
| `tests/unit/cursor.test.ts` | 游标 roundtrip 与畸形输入 |
| `tests/unit/rbac.test.ts` | 角色等级全组合 |
| `tests/unit/password.test.ts` | 哈希格式、随机盐、损坏数据防御 |
| `tests/unit/session.test.ts` | 令牌签名/过期/篡改、Cookie 属性 |
| `tests/unit/event-bus.test.ts` | 内存 pub/sub 的投递与 presence 语义 |
| `tests/integration/setup-env.ts` | 加载 `.env.test`，CI 环境变量优先 |
| `tests/integration/test-utils.ts` | caller 工厂、TRUNCATE 清库、测试数据构造 |
| `tests/integration/auth.test.ts` | 注册归一化、登录防枚举、会话边界 |
| `tests/integration/tasks.test.ts` | 编号递增、乐观锁、状态机、拖拽排序、软删除、游标分页 |
| `tests/integration/notifications.test.ts` | 指派通知、偏好过滤、邮件入队 |
| `tests/integration/notifications-list.test.ts` | 收件箱隔离、已读流转 |
| `tests/integration/analytics.test.ts` | 统计口径（取消不计入分母）、趋势、进度 |
| `tests/integration/projects-health.test.ts` | 项目生命周期、健康检查 |
| `tests/integration/tasks-misc.test.ts` | 评论、标签去重、项目改名归档 |
| `tests/e2e/critical-path.spec.ts` | 注册到建任务全链路 + 登录失败 |
| `playwright.config.ts` | 独立 E2E 库、dev server 端口 3210 |
| `.env.test.example` | 测试环境变量模板（指向 compose 端口） |
| `.github/workflows/ci.yml` | verify job 加两层测试，新增 e2e job |

---

## 10. 实跑记录

2026-09-06，macOS + Docker Desktop（PostgreSQL 16 / Redis 7 均为 compose 实例）：

- 单元 30 个、集成 37 个、E2E 2 个，共 69 个测试全部通过
- `pnpm test`（单元 + 集成）总耗时约 8-10 秒；E2E 含 dev server 冷启动约 25 秒
- `src/server` 行覆盖 80.28%，分支 79.32%，函数 97.56%
- `pnpm typecheck` 干净，测试代码与业务代码共用同一套严格类型检查

开发过程中真实修掉的问题，按发现顺序：

1. **tRPC server caller 没有 `.mutate()`**：按客户端习惯写调用，报 `Cannot read properties of undefined (reading '_def')`，错误信息完全不指向真正原因
2. **project 级 `fileParallelism` 被静默忽略**：集成测试文件照常并发，`beforeEach` 的 TRUNCATE 和另一文件的写入互相等锁，PostgreSQL 报死锁。`ProjectConfig` 类型里没有这个键，多写不报错。移到根级配置后解决
3. **RBAC 矩阵按枚举顺序做位置索引**：Prisma 生成的 `Role` 枚举顺序是 OWNER 在前，我的矩阵假设 VIEWER 在前，一格错位。改成显式 `[角色, 最低角色, 期望]` 三元组列表，不再依赖枚举顺序
4. **E2E 断言错了列**：快速新建任务默认进 TODO（待开始），我按直觉断言 BACKLOG（待整理）。改的是测试不是代码
5. **两个"登录"按钮与 route announcer 的严格模式冲突**：提交改回车，alert 断言改按文案

第 4 条单独值得展开一句：E2E 挂掉时的第一反应几乎总是"这个框架又抽风了"，但这次是测试自己对业务的理解就是错的。写测试的过程逼着你把"我以为的行为"和"实际的行为"逐条对齐——这层收益在覆盖率数字里完全体现不出来。

---

## 实践练习

### 练习一：跑起来并制造一次失败

```bash
cd solutions/saas
docker compose up -d
cp .env.test.example .env.test
pnpm install && pnpm test:migrate
pnpm test
```

然后打开 `src/server/domain/task-status.ts`，把 `DONE` 的合法出口改成也包含 `TODO`，重跑 `pnpm test:unit`。观察哪些用例以什么方式失败，再把改动还原。**让测试红一次**比看它绿一百次更能建立信任。

### 练习二：给邀请流程补集成测试

`workspaces.invite` 和邀请接受是当前覆盖清单上的第一缺口。参照 `tests/integration/notifications.test.ts` 的写法：邀请创建后 `invitation` 表的状态、受邀人接受后 membership 的角色、过期邀请被拒绝。注意邀请 token 的传递方式，断言要落在数据库状态而不是返回值上。

### 练习三：体验一次 flaky 并修掉它

把 `tests/e2e/critical-path.spec.ts` 里任意一个 web-first 断言前面加上 `await page.waitForTimeout(100)`，然后在 `playwright.config.ts` 里把 `workers` 改成 2、`fullyParallel` 打开，跑 `pnpm test:e2e --repeat-each=5`，记录失败率。再还原配置，对比两次的稳定性。体会"并行度是拿隔离性换的"这句话的实际含义。

---

## 今日产出

- [ ] 能说清楚金字塔和奖杯各自的主张，以及本项目为什么偏集成
- [ ] `pnpm test:unit` 不依赖任何外部服务即可通过
- [ ] `docker compose up -d && pnpm test:migrate && pnpm test:integration` 全绿
- [ ] `pnpm test:e2e` 两条关键路径通过
- [ ] `src/server` 行覆盖 >= 80%，并能指出未覆盖清单里最重要的一项
- [ ] 能解释 createCaller 与 Supertest 的取舍、`.mutate()` 为什么不存在
- [ ] 能解释为什么不给覆盖率设 threshold 门槛
- [ ] CI 的 verify job 包含两层测试，e2e job 失败时能拿到 trace

---

[上一天：Day 55](../day-55/) | [下一天：Day 57](../day-57/)
