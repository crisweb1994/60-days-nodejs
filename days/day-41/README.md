# Day 41 — Docker 基础

> 前面 40 天我们把代码弄得「正确、安全、快」，但应用始终跑在本地的 `pnpm start` 上——依赖你机器上那个特定版本的 Node、某个全局装的 pnpm、某个特定的系统库。换台机器、上个 CI、丢到服务器上，行为就开始飘。
>
> Day 41 开始解决「怎么把它变成一个**可移植、可重现、可部署**的产物」。Docker 最该被理解的价值，不是「轻量级的虚拟机」这个老比喻，而是**「环境即代码」**：把 Node 版本、系统库、依赖版本锁、构建产物，全部冻进一个不可变的镜像。任何人、任何机器 `docker run`，都拿到一模一样的行为——「我本地能跑」这句话从此失效。
>
> 今天聚焦单镜像：把 `blog-api` 打成一个生产级的镜像。多服务编排（api + PostgreSQL + Redis 一起起、启动顺序、迁移 job）是 **Day 42** 的事。

## 📋 今日目标

- 搞清**镜像 vs 容器**的本质，别停在「轻量虚拟机」的误解——它会让你误解隔离边界、性能特征、跨平台限制
- 写一个**生产级 Dockerfile**：多阶段构建（deps / build / runner 三段），讲清每一阶段为什么存在、为什么不能合并
- 踩透 **alpine + Prisma 的经典坑**（`libc6-compat` + `openssl`），真正理解 glibc / musl 对 native 模块的影响，顺带看清本项目哪些依赖是 native、哪些不是
- 容器安全的**三件套**：非 root 用户、最小运行时镜像、PID 1 信号处理（`tini`）——它们是 Day 40 纵深防御在部署侧的延伸
- 把 `.dockerignore` 当成**安全边界**来写：为什么 `.env` 绝不能进镜像，为什么本地的 `node_modules` 不能进镜像

> 配套代码：`solutions/blog/blog-api/`。新增 `Dockerfile`（三阶段）、`.dockerignore`；`package.json` 补 `packageManager` 字段（锁死 pnpm 版本，让容器内 corepack 行为确定）。
> `docker-compose` 编排、迁移 job、就绪探针都留给 Day 42——今天先造出一个能独立 `docker build` + `docker run` 的镜像。

---

## 📖 核心知识点

### 1. 这天在解决什么：从「能跑」到「在哪都能跑」

先把「本地 `pnpm start`」的问题摆出来，对照 Docker 怎么接：

| 本地跑的问题 | 真实后果 | Docker 的对策 |
|---|---|---|
| Node 版本看机器心情 | 生产服务器是 Node 18，本地 20，行为/性能/废弃 API 全不一样 | 镜像 `FROM node:20-alpine` **锁死** Node 版本 |
| 依赖靠手动 `pnpm install` | lockfile 没提交 / 用了 npm 装 / 版本飘 | 镜像内 `--frozen-lockfile`，**不可变**地装 |
| 系统库差异（openssl 版本等） | 本地能连库、服务器 TLS 握手失败 | 系统库随基础镜像固定，跟着镜像走 |
| 部署要手动装运行时 | 每台服务器一套脚本，迟早漂移 | 单镜像 `docker run`，**运行时自包含** |
| 多服务手动按顺序起 | 先起 api 再起 DB？还是反过来？ | Day 42 的 `compose` + `depends_on` |

带着这张表读后面每一节，会发现它们在回答同一个问题：**怎么把「跑起来需要的全部条件」从一堆口头约定，变成一个可复现的工件。**

### 2. 镜像 vs 容器：别再叫它「轻量虚拟机」

这个误解流传最广，也最耽误理解。一句话纠正：**容器和宿主机共享内核**，它根本不虚拟化硬件。

- **镜像（image）**：一个**只读的、分层的文件系统快照**。可以类比成「类」。它就是一堆层（layer）叠起来的目录树——基础系统的层 + `apk add` 装的库层 + 你 `COPY` 进去的代码层。
- **容器（container）**：镜像之上加**一层可写层** + **一个（或一组）进程**。可以类比成「实例」。`docker run` 做的事就是：拿镜像、铺一层可写层、起进程。进程一退，可写层还在（除非 `--rm`），但默认不写回镜像。

隔离靠的是 Linux 内核的两个机制，**不是 hypervisor**：

- **namespace**：让容器里的进程「看不见」宿主机和其它容器的进程、网络、挂载点、用户。是「视角」上的隔离。
- **cgroup**：限制容器能用多少 CPU / 内存 / IO。是「配额」上的隔离。

这个区别解释了三个你迟早会撞上的事实：

1. **容器启动是秒级**的——它不起内核，只是 `fork` 一个进程套上 namespace。VM 启动要起整个内核，是分钟级。
2. **Linux 镜像在 Mac / Windows 上跑，底下藏了一台虚拟机**。Docker Desktop 起了一个轻量 Linux VM，容器跑在那个 VM 里——因为 Mac 内核（XNU）和 Linux 内核不兼容，你的 Linux 镜像里的二进制需要 Linux 内核才能 `exec`。
3. **「容器比 VM 轻」的本质是共享内核**：10 个容器共用一个内核，不重复跑 10 份 OS；代价是隔离没 VM 强（内核漏洞能跨容器逃逸）——这是为什么高安全场景仍用 VM。

还有一个会被反复用到的推论：**镜像分层**。Dockerfile 里每条指令（`RUN` / `COPY` / `ADD`）生成一层，层会被缓存。下一节讲怎么利用它。

### 3. 多阶段构建：为什么要拆成 deps / build / runner

先抛矛盾：**构建时需要的东西，和运行时需要的东西，根本不是一回事。**

| | 构建时需要 | 运行时需要 |
|---|---|---|
| typescript、@nestjs/cli | ✅ 要编译 | ❌ |
| 源码 `src/*.ts` | ✅ 要编译 | ❌（要的是编译后的 `dist`） |
| prisma CLI、`prisma` 包 | ✅ 要 `generate` | ❌ |
| `@prisma/client`、业务依赖 | ✅ | ✅ |
| 编译后的 `dist/` | ❌ | ✅ |

如果用单阶段（一个 `FROM`，装全量依赖、编译、`CMD node dist/main`），最终镜像会**带着 typescript、源码、所有 devDeps**——体积翻几倍不说，源码进镜像等于把代码送给任何能 pull 镜像的人，攻击面也大。

**多阶段构建**就是解药：多个 `FROM`，每个从一个干净的基础镜像起，用 `COPY --from=某阶段` 把前一段的产物「搬」过来。**最终镜像只保留最后一个 `FROM` 段**，前面的段只是「中间产物」，不进最终镜像。

我们的 Dockerfile 三段，各司其职：

```
deps ── 全量 install + prisma generate ──▶ 产出 node_modules（含 .prisma client）
 │（继承 node_modules）
build ── COPY 源码 + pnpm build ──────────▶ 产出 dist/
 │（COPY --from=deps / COPY --from=build）
runner ─ 生产 install + 拷 .prisma + 拷 dist ─▶ 最终镜像（无 typescript、无源码、无 devDeps）
```

三段的分工一句话：**deps 把依赖和生成物准备好，build 把源码编译掉，runner 只挑运行时要的搬进最终镜像。** 前两段最后都被丢弃——它们存在的全部意义，是给 runner 提供那几次 `COPY --from=` 的来源。

### 4. 缓存友好的指令顺序：为什么 COPY 依赖描述要在 COPY 源码之前

这是新手 Dockerfile 最常见的性能灾难。先看反面：

```dockerfile
# ❌ 反面教材
COPY . .                       # 把所有源码拷进来
RUN pnpm install               # 然后 install
RUN pnpm build
```

问题在分层缓存：`COPY . .` 这一层，**只要你改了任何一个源码文件就失效**；它一失效，后面的 `pnpm install` 跟着重跑。而 `pnpm install` 是整个构建里最慢的一步（几十秒到几分钟，要解析、下载、链接一堆包）。结果就是：**改一行 `console.log`，等两分钟装依赖。**

正确顺序——把「变化频率低的」放前面，「变化频率高的」放后面：

```dockerfile
# ✅ deps 段
COPY package.json pnpm-lock.yaml ./     # 依赖描述几乎不变
COPY prisma ./prisma                    # schema 偶尔变
RUN pnpm install --frozen-lockfile      # 只有上面变了它才重跑

# ✅ build 段
COPY src ./src                          # 源码天天变
RUN pnpm build                          # 改代码只让这层往后失效
```

依赖描述变了才重装，源码变了只重编译。**改代码的反馈环从「装依赖 + 编译」缩短成「只编译」。**

再叠一个 BuildKit 的缓存挂载，把 pnpm 的全局下载缓存也持久化到 build 之间：

```dockerfile
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
```

即便 lockfile 真变了触发了重装，已下载过的包也从本地 store 直接链接，不再走网络。这一行没 BuildKit（老 Docker）会被忽略，行为退化为普通 install，**不影响正确性**——属于「有则更快，无则照跑」的优化。

### 5. alpine + Prisma 的经典坑：glibc vs musl

这是今天最值得想透的一点。基础镜像我们选了 `node:20-alpine`——理由有二：和 `blog-db` 的 `postgres:16-alpine` / `redis:7-alpine` 保持一致；体积最小（alpine 才 5MB 出头的基础系统，node:20-alpine 约 130MB，而 `node:20` 完整版要 350MB+）。

但 alpine 有个根本特征：**它用 musl libc，而不是主流 Linux 发行版的 glibc。** 这对任何带 native 二进制的依赖都是一道坎。本项目里逐个看：

**① Prisma（真正的坑）**

Prisma 的 query engine 是一个 `.node` 二进制（`libquery_engine-linux-musl-openssl-*.node`），官方按 glibc + openssl 编译。直接在 musl 上 `dlopen` 它，要么报 `Error: Failed to load the Prisma engine`、要么直接段错误。解药在 Dockerfile 里这两行：

```dockerfile
RUN apk add --no-cache openssl libc6-compat
```

- `libc6-compat`：alpine 提供的 glibc 兼容层，补上 musl 缺的那部分符号，让 glibc 编译的二进制能跑。
- `openssl`：引擎运行时动态链接的加密库（Prisma 5 需要 openssl 1.1 / 3.x）。

build 和 runner **两段都要装**——别想着「构建时装了运行时就有了」，跨阶段 `COPY` 不会带系统包，运行时段是全新的 alpine，得自己再装一遍。

> 嫌这个坑烦，有个干脆的替代：换 `node:20-slim`（Debian 系，glibc）。Prisma 在上面开箱即跑，不用 `libc6-compat`。代价是镜像大 ~30MB、基础系统更大。**取舍很清楚**：追求最小体积、能接受多一行 `apk add` → alpine；想省心、不在意多几十 MB → slim。本项目三服务都是 alpine，统一选 alpine。

**② sharp（伪坑，其实没事）**

图片处理用的 `sharp` 是 native 的，但它从 0.33 起改用了**预编译二进制**——把 libvips 整个静态链进去，按平台发布成 optionalDependencies（`@img/sharp-linuxmusl-x64` 等）。pnpm install 时会自动挑当前平台的那一个。所以在 alpine 上只要 `pnpm install`，musl 变体就装好了，**不需要额外装系统库**。

**③ bcryptjs（压根不是 native，别误判）**

本项目密码哈希用的是 **`bcryptjs`**，不是 `bcrypt`。`bcrypt`（无 js 后缀）才是 C++ native 模块，alpine 上要 `python3 make g++` 才能编译；而 `bcryptjs` 是**纯 JavaScript 实现**，没有任何 native 代码——这是当初选它的一个隐藏好处，容器化时零额外成本。**别看到 bcrypt 就以为要装编译工具链。**

一句话收束：**本项目唯一的真 native 坑就是 Prisma，靠 `openssl` + `libc6-compat` 填平；sharp 靠预编译、bcryptjs 靠纯 JS，都不用额外操心。** 这是「容器化一个项目」时该做的第一件事——**清点依赖里哪些是 native，每个在目标基础镜像上能不能跑**。

还有个相关的反模式必须点破：**绝不能把本地 `node_modules` 拷进镜像**。本地装出来的 Prisma 引擎是 darwin 的（在 mac 上）、sharp 是 darwin 的，打进 linux 镜像里全是错的二进制。所以 deps 段必须在**容器内** `pnpm install` + `prisma generate`，让引擎匹配容器内核。`.dockerignore` 排掉 `node_modules` 不是洁癖，是正确性要求。

### 6. 运行时镜像三件套：--prod + --ignore-scripts + 拷 .prisma

runner 段怎么装依赖，藏着三个相互勾连的细节，每个都对应一个坑：

```dockerfile
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma
```

**① `--prod`**：只装 `dependencies`，跳过 `devDependencies`。typescript、`@nestjs/cli`、`prisma`（CLI）这些全不进运行时镜像——它们只是编译期的工具，带着跑纯属浪费体积、徒增攻击面。

**② `--ignore-scripts`**：跳过 npm/pnpm 的生命周期脚本。为什么要跳？看 `package.json`：

```json
"postinstall": "prisma generate"
```

本地开发时，装完依赖自动 `prisma generate` 生成 client，很方便。但 runner 用了 `--prod`，`prisma` CLI 是 devDep、**根本没装**——这时候 `postinstall` 一执行就 `prisma: command not found`，构建直接挂。所以生产安装必须 `--ignore-scripts` 把它跳过。

**③ 拷 `.prisma`**：跳过了 generate，那 Prisma client 哪来？从 deps 段拷。`prisma generate` 的产物不是 npm 包，是生成在 `node_modules/.prisma/client/` 的代码 + `.node` 引擎二进制。`--prod` 装不出来它，只能从「在容器内生成过」的 deps 段显式 `COPY --from=deps` 搬过来。

这三个 flag 互相补位，正是「为什么带 Prisma 的 Dockerfile 总比想象复杂」的全部答案。换成不带 native 生成物的项目，runner 一句 `pnpm install --prod` 就够了——Prisma 多出来的这两步（`--ignore-scripts` + 拷 `.prisma`）都是被它的「生成物不在包里」这个设计逼出来的。

> 为什么不干脆 runner 段也装 `prisma` CLI 跑一次 generate？能跑，但你把一个 40MB+ 的 CLI 永久塞进运行时镜像，只为「启动前用一次」——不值。从 deps 段拷个生成物目录，干净得多。

### 7. 容器安全三件套：非 root + PID 1（tini）+ 优雅关闭

这三个是 Day 40「纵深防御」在部署侧的自然延续——**应用层做了那么多闸，部署层也不能裸奔**。

**① 非 root 用户**

容器默认以 root 跑。万一应用被 RCE（比如 Day 39 那条上传链路有个没堵住的解析漏洞），攻击者拿到的就是**容器内的 root**。虽然容器隔离不如 VM，root 仍意味着更大的逃逸面（能用的内核攻击更多）。建一个无特权用户来跑应用，是基本盘：

```dockerfile
RUN addgroup -S app && adduser -S app -G app
...
USER app
```

注意一个连带坑：**`USER app` 之后，app 要能写 `uploads/` 目录**。`mkdir` 默认归 root，非 root 用户写不进去，本地存储后端上传封面图直接 500。所以建目录后要 `chown`：

```dockerfile
RUN mkdir -p uploads && chown -R app:app uploads
```

**② PID 1 与 tini**

容器里你的进程就是 PID 1。PID 1 在 Linux 里有特殊含义，Node 进程当 PID 1 有两个老毛病：

- **不回收僵尸进程**：PID 1 按约定要 `wait` 掉所有子进程的退出状态，不收就留一堆僵尸。Node 不干这事。
- **信号转发不可靠**：`docker stop` 给 PID 1 发 SIGTERM，指望它优雅退出。但 Node 作为 PID 1，对 SIGTERM 的处理有历史坑（早期版本直接忽略），于是 `docker stop` 等满 10 秒超时，被 SIGKILL 强杀。

`tini` 是个专为容器设计的微型 init 进程，十几 KB，专门干两件事：**接信号并转发给 Node、回收僵尸**。

```dockerfile
ENTRYPOINT ["/sbin/tini", "--"]
```

它当 PID 1，Node 当它的子进程。配合 `main.ts` 里**已经开好的**优雅关闭：

```ts
// main.ts —— Day 36 就开过
app.enableShutdownHooks();
```

整条链路就通了：`docker stop` → SIGTERM 到 tini → 转发给 Node → `enableShutdownHooks` 触发 → Nest 调 `onModuleDestroy`、关 Prisma 连接池、等在途请求 → 干净退出。**没有 SIGKILL 的一刀切，没有连接池泄漏。** 这是「Day 36 留的优雅关闭 hook」终于在容器里兑现了它该有的效果。

> 不想镜像里装 tini，也可以在 `docker run` / compose 里用 `--init`（Day 42 会用到），Docker 会注入等价的 docker-init。但把 tini 烤进镜像，镜像本身就自包含，谁来 `run` 都对——更稳。

**③ `HEALTHCHECK`**

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:${PORT:-3000}/health || exit 1
```

探针打 `/health`——那个端点我们 Day 35 就 `@SkipThrottle` 过、且只查进程级状态不碰 DB，天生适合被高频探。`--start-period=20s` 给启动留缓冲（Nest 冷启动 + Prisma 连库要几秒），`--retries=3` 连续 3 次失败才判 unhealthy，避免一次网络抖动误杀。

> 注意这只是**存活探针（liveness）**：进程在不在。真正的「就绪探针（readiness，能不能接流量）」要查「DB 通不通」——那是 Day 42 接 `@nestjs/terminus` 的事。今天这个够 Day 41 用。

### 8. .dockerignore：.env 是密钥红线

`.dockerignore` 常被当成「省点体积」的小优化，但它首先是**安全边界**。逐条看为什么要排除：

```
node_modules      # 本机内核的二进制，打进 linux 镜像跑不了（见第 5 节）
dist              # 镜像里自己编译，抄本地的没意义还可能过期
.env              # ★ 密钥！
.env.local
test / uploads    # 运行时用不到
.git              # 历史，体积大还可能藏早先的密钥
```

`.env` 那条要单独拎出来讲——这是真实泄漏事故的高发点：

`.env` 里是 `JWT_ACCESS_SECRET`、`DATABASE_URL`（带 DB 密码）、`S3_SECRET_ACCESS_KEY`。一旦它进了镜像层，镜像 push 到 registry 后，**任何能 pull 的人**都能 `docker save` 导出 tar、或 `docker history` 看每一层，把密钥翻出来。即便你后来删了文件重新构建，**旧层还在镜像历史里**——除非 `docker image prune` + 重新 tag。

正确做法只有一条：**配置必须运行时注入**（`docker run -e KEY=VAL`、`--env-file`、或 Day 42 的 compose `environment`），**绝不能烤进镜像**。镜像应该是「和任何环境无关」的，换套环境变量就能从开发切到生产。

> 一个验证手法：构建后跑 `docker run --rm <镜像> env | grep SECRET`，或者 `docker history <镜像>`——如果能在里面看到你的密钥，就是 `.dockerignore` 漏了。

### 9. 看懂最终镜像：分层、体积、docker history

把镜像构建出来后，两个命令值得养成习惯：

```bash
docker history blog-api:day41         # 看 Dockerfile 每一层各占多少体积
docker images blog-api:day41          # 看最终镜像总大小
```

`docker history` 会告诉你哪一层最贵——通常是 `pnpm install` 那层（依赖体积）。多阶段的价值在这里直观兑现：**最终镜像里看不到 typescript、看不到源码、看不到 devDeps 那些层**——它们在 deps / build 段，没进 runner。一个粗略的量级：单阶段（全量 + 源码）能到 800MB+，三阶段 runner alpine 生产依赖大约 180–220MB。省掉的就是那些「只是构建期需要」的重量。

---

## 改动清单（接进 blog-api）

| 文件 | 改了什么 |
|---|---|
| `Dockerfile` | **新增**：三阶段（deps 全量装 + 容器内 generate / build 编译 / runner 生产装 + 拷生成物）。alpine + `openssl libc6-compat tini`；非 root 用户；`HEALTHCHECK` 打 `/health`；`uploads` 目录 chown |
| `.dockerignore` | **新增**：排除 `node_modules`（本机二进制）、`dist`、`.env*`（密钥红线）、`test`、`uploads`、`.git` 等 |
| `package.json` | 补 `packageManager: pnpm@10.15.0`——让容器内 corepack 用确定的 pnpm 版本，单一真相源 |

---

## ✅ 一份诚实清单

✅ **今天到位的：**
- 生产级三阶段 Dockerfile（构建期与运行期依赖分离，最终镜像无编译器/源码/devDeps）
- 缓存友好的指令顺序（依赖描述在源码前）+ BuildKit 缓存挂载
- alpine + Prisma 的 `libc6-compat` / `openssl` 坑填平；讲清了本项目 native 依赖的清点（Prisma 真坑 / sharp 预编译 / bcryptjs 纯 JS）
- 容器安全：非 root 用户 + uploads chown + tini（PID 1）+ 优雅关闭打通
- `.dockerignore` 作为安全边界，`.env` 不进镜像

⚠️/❌ **还没做、明确留给后面的：**
- **多服务编排**：api + PostgreSQL + Redis 一起起、`depends_on`、健康检查作为就绪信号——**Day 42 的 `docker-compose`**
- **迁移 job**：`prisma migrate deploy` 该用一次性容器先跑，再起 api（Day 42 编排）
- **就绪探针**：今天的 HEALTHCHECK 是进程级存活，不查 DB；真正的 readiness 要接 `@nestjs/terminus`（Day 42）
- **多架构构建**：M 芯片 mac 开发、x86 服务器部署时，需要 `docker buildx --platform linux/amd64,linux/arm64` 出双架构镜像——本 demo 只构当前架构
- **镜像扫描与签名**：`trivy` 扫 CVE、`cosign` 签名——生产流水线才上

---

## 💻 实践练习

1. **构建镜像**：
   ```bash
   cd solutions/blog/blog-api
   docker build -t blog-api:day41 .
   ```
   观察构建日志，能看到三段（`deps` / `build` / `runner`）依次执行；第二次 build 改个注释再 build，`pnpm install` 那层应该命中缓存（`CACHED`）秒过。

2. **先手动起依赖**（编排留 Day 42，今天先单跑）：
   ```bash
   cd ../blog-db && docker compose up -d   # 起 PostgreSQL + Redis
   ```

3. **跑容器，连宿主机的 PG/Redis**：
   ```bash
   docker run --rm -p 3000:3000 \
     --add-host=host.docker.internal=host-gateway \
     -e DATABASE_URL='postgresql://blog:blog_dev_pwd@host.docker.internal:5432/blog?schema=blog_api' \
     -e REDIS_URL='redis://host.docker.internal:6379' \
     -e JWT_ACCESS_SECRET=dev-only-access-secret-change-me-please \
     blog-api:day41
   ```
   注意 `host.docker.internal`——**容器里的 `localhost` 是容器自己**，连不到宿主机的 PG/Redis。这是第 2 节「namespace 网络隔离」最具体的一次体验：必须用宿主机地址，加 `--add-host=host.docker.internal=host-gateway` 才解析得到。（Day 42 把 api 和 DB 放同一 compose 网络后，就能直接用服务名 `postgres` / `redis` 互访了。）

4. **验证探针与优雅关闭**：另开终端 `curl localhost:3000/health` 返回 `{status:"ok"}`；`docker inspect --format='{{.State.Health.Status}}' <容器>` 看 `healthy`；`docker stop <容器>`，观察日志能看到 Nest 的 shutdown hook 执行（而不是被 SIGKILL）。

5. **验证安全项**：`docker exec <容器> id` 应显示 `uid=101(app)` 非 root；`docker run --rm blog-api:day41 ls /app` 确认没有 `src/`、没有 `.env`、没有 `test/`；`docker history blog-api:day41` 找不到任何带密钥的层。

6. **思考题**：如果把 Dockerfile 里「COPY package.json」和「COPY src」的顺序对调（先 COPY src 再装依赖），改一行代码会发生什么？为什么 `--prod` 装依赖时必须配 `--ignore-scripts`？少拷 `.prisma` 那一行，启动会报什么？

---

## ✅ 今日产出

- [ ] 跑通 `docker build` + `docker run`，`/health` 返回 200、`docker stop` 能优雅退出
- [ ] 用 `docker history` 看懂分层、用 `docker exec id` 确认非 root、确认 `.env` 没进镜像
- [ ] 在笔记里写下：alpine+Prisma 的坑怎么填、多阶段为什么、PID 1 / tini 解决什么、为什么密钥不能进镜像
- [ ] 提交代码到 GitHub

---

[⬅️ Day 40](../day-40/) | [➡️ Day 42](../day-42/)
