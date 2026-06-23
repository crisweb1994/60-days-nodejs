# Day 42 — Docker Compose 与多服务编排

> Day 41 把应用打成了一个能独立 `docker build` + `docker run` 的镜像。但那天练习里有个尴尬的尾巴：想真把它跑起来，你得先 `cd ../blog-db && docker compose up -d` 手动起 PG + Redis，再 `--add-host=host.docker.internal=...` 让容器绕一圈去连宿主机的端口，迁移还要自己手动跑——而且这一切有个**绕不过去的顺序问题**：api 比 DB 先起来怎么办？
>
> 当时留了三条线：「多服务编排 + depends_on」「迁移 job」「就绪探针（terminus）」。今天把这三条一次性收掉。核心不是学 YAML 语法——Compose 的 YAML 一小时就能读懂——而是搞清楚**一个多服务系统「怎么自己按正确的顺序长起来」**：谁先起、起没起好的判据是什么、库结构谁负责、流量什么时候才该导进来。
>
> 一句话目标：`docker compose up -d` 一条命令，把 api + PostgreSQL + Redis + 迁移 job 按依赖顺序拉起，且**只有当应用真能服务请求时**才认为它就绪。

## 📋 今日目标

- 把 Day 41 的单镜像 + PG + Redis 编排成一份 compose，**一条命令拉起整个栈**
- 想透**启动顺序**：`depends_on` 的三种 condition（`service_started` / `service_healthy` / `service_completed_successfully`），以及为什么默认的 `service_started` 几乎没用
- 写一个**一次性迁移 job**：`prisma migrate deploy` 在 api 起来之前先跑完——并讲清为什么迁移不能让 api 自己干
- 把 Day 41 留的**就绪探针**补上：接 `@nestjs/terminus`，分清**存活（liveness）vs 就绪（readiness）**，并让 compose 用就绪探针当「能不能接流量」的判据
- 讲清容器网络（`localhost` 是容器自己、服务名 DNS）和**数据卷**持久化、`down` vs `down -v` 的区别
- 把环境变量从镜像里**彻底搬出来**：`environment` / `env_file` / `${VAR:-默认}` vs `${VAR:?必填}`，密钥仍然绝不进镜像

> 配套代码：`solutions/blog/`。新增 `docker-compose.yml`（全栈编排）+ `.env.example` + `.gitignore`；`solutions/blog/blog-api/` 里新增就绪探针：`src/health/redis.health.ts`（自定义 terminus 指标）、`src/health/health.controller.ts` 加 `/health/ready`、`health.module.ts` 接入 `TerminusModule`；`package.json` 补 `prisma:migrate:deploy` 脚本；`test/health.e2e.test.ts` 验两条探针的语义差异。
> Day 41 的 `Dockerfile` / `.dockerignore` 一行不改——今天只在外面包编排。

---

## 📖 核心知识点

### 1. 这天在解决什么：从「一个镜像」到「一套能自己长起来的系统」

先看「Day 41 的镜像 + 手动起依赖」到底哪里别扭，对照 compose 怎么接：

| 手动编排的痛点 | 真实后果 | Compose 的对策 |
|---|---|---|
| 谁先起？api 抢跑 | PrismaService 启动即 `$connect()`（fail-fast），DB 没起 → api 进程当场崩，得人工重试 | `depends_on: postgres: condition: service_healthy`，DB 没就绪 api 根本不起 |
| 迁移谁负责？ | 多个 api 副本各自 migrate 会互相踩（迁移要串行） | 独立的**一次性 migrate job**，api 等它 `service_completed_successfully` |
| 服务怎么互访？ | 容器里的 `localhost` 是容器自己，连不到别的服务 | 同一 compose 自动建网络，**服务名即 DNS**（`postgres` / `redis`） |
| 重启丢数据吗？ | 容器一删，DB 数据、上传的封面图全没 | **命名卷**挂出去，容器重建数据还在 |
| 一套配置散落各处 | 端口、密码、连接串靠人记、靠 README 传 | 一份 `docker-compose.yml` + `.env`，声明即真相 |
| 一条命令拉起 | 得开三个终端分别 `docker run` | `docker compose up -d` 一次全起、按依赖排序 |

带着这张表读后面，会发现 compose 的每个特性都在回答同一个问题：**怎么把「跑起一套系统需要的全部条件和顺序」，从口头约定变成一份可复现、可执行的声明。**

### 2. 一份 compose 的骨架：services / volumes / networks

顶层就三个关键键。我们的 `solutions/blog/docker-compose.yml` 结构是：

```yaml
services:   # 每个服务 = 一个容器（镜像 + 它的配置：端口、环境、卷、健康检查、依赖）
  postgres: ...
  redis: ...
  migrate: ...
  api: ...
volumes:    # 命名卷 = Docker 管理的持久化目录，容器删了数据还在
  pg-data:
  uploads:
  redis-data:
# networks:  ← 我们没写，但【它存在】
```

**`networks` 我们一行没写，为什么服务之间还能互通？** 因为 compose 默认会给这份编排自动建一个网络（名字是 `<项目名>_default`，项目名取自 `name:` 字段或目录名），并把所有服务都接进去。接进去的服务互相就能用**服务名当主机名**解析——`api` 连 `postgres:5432`、`migrate` 连 `postgres:5432`，DNS 由 Docker 内置的 DNS 服务负责。

这条「服务名 = 主机名」是今天最该记住的一个事实，也是 Day 41 那个 `--add-host=host.docker.internal=host-gateway` 绕路操作的终结者：**同网络内，直接用服务名。**

只有当你想跨多份 compose 互通、或显式隔离时，才需要手写 `networks`。我们这份自包含的栈，默认网络就够了。

### 3. depends_on 的三种 condition：启动顺序的全部秘密

这是今天概念最密集的一节。先看我们 `api` 服务的依赖声明：

```yaml
api:
  depends_on:
    postgres:
      condition: service_healthy
    redis:
      condition: service_healthy
    migrate:
      condition: service_completed_successfully
```

三种 `condition`，从弱到强：

| condition | 含义 | 为什么单用它在大多数场景不够 |
|---|---|---|
| `service_started`（默认） | 依赖的容器**进程已启动** | 启动 ≠ 就绪。postgres 进程起来了，但还在做 crash recovery、还没接受连接——api 这时连上去照样崩 |
| `service_healthy` | 依赖容器的**健康检查判为 healthy** | 这才是「真就绪」。前提：依赖服务**必须配了 healthcheck**，否则永远没有 healthy 这个状态 |
| `service_completed_successfully` | 依赖容器**跑完并以 0 退出** | 专门给一次性 job 用：迁移 job 成功退出，才放 api 起 |

新手最常踩的坑就是只写 `depends_on: [postgres, redis]`（等价于全用 `service_started`）。结果是**间歇性启动失败**：本地快、DB 起得快时碰巧没事；CI 上 DB 慢一点，api 就在 DB 还没就绪时冲上去 `$connect()` 崩掉，留下一个玄学的「我本地能跑、CI 挂」。

解药是**把「就绪」显式化**：给每个依赖配 healthcheck，再用 `service_healthy` 把它当启动闸门。我们的 postgres / redis 都配了：

```yaml
postgres:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U blog -d blog"]
    interval: 5s
    timeout: 3s
    retries: 10
    start_period: 5s
redis:
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    ...
```

`pg_isready` 是 postgres 镜像自带的探活命令——它问的是「数据库进程起来了、能接受连接」，正好就是 `service_started` 答不了的那个问题。`retries: 10` + `interval: 5s` 给 DB 足够的窗口从「刚起」走到「就绪」，避免一次抖动就判死。

> `start_period` 是个容易看漏的字段：它表示「容器启动后这段时间内的失败不计入 retries」——给慢启动的服务（Nest 冷启动、PG 初始化）一个宽限期，否则冷启动那几秒的健康检查失败会把容器过早标成 unhealthy。

整条启动链就靠这套 condition 串起来：**postgres 健康了 → migrate 才跑 → migrate 成功退出 + redis 健康 → api 才起**。任何一环没就位，后面的服务就老老实实等着。

### 4. 迁移 job：为什么不让 api 自己 migrate

「在应用启动时顺带 `prisma migrate deploy`」是个很有诱惑力的简化——少一个服务、少几行 YAML。但它有两个硬伤，今天我们用独立 job 规避：

**① 横向扩容时的并发踩踏。** 生产里 api 通常跑 N 个副本（多机器 / 多容器）。如果每个副本启动都去 migrate，N 个进程会**同时**去改同一套库结构——Prisma 的迁移表 `_prisma_migrations` 会竞争、迁移可能被重复应用或互相打断。迁移是一个**需要串行、需要独占**的动作，天生不该由「会扩成多个」的 api 来干。独立的 migrate job 永远只有一份，天然串行。

**② 迁移失败时的 fail-closed。** job 跑 `prisma migrate deploy`，失败就以非 0 退出。而 api 用了 `condition: service_completed_successfully`——job 没**成功**退出，api 就**不会启动**。库结构没就绪，就不让 api 接流量，这正是 fail-fast / fail-closed 哲学在部署侧的体现。要是让 api 自己 migrate，迁移失败往往只是日志里一条错，api 照样起、照样接流量、然后在第一个请求上崩——晚暴露总不如不暴露。

我们的 migrate 服务：

```yaml
migrate:
  build:
    context: ./blog-api
    target: deps          # ← 关键：用 Dockerfile 的【deps 段】，不是 runner 段
  command: ["pnpm", "exec", "prisma", "migrate", "deploy"]
  environment:
    DATABASE_URL: postgresql://blog:...@postgres:5432/blog?schema=blog_api
  depends_on:
    postgres:
      condition: service_healthy
  restart: "no"           # 一次性 job：跑完即退，不重启
```

这里有两个非显然的点：

**为什么 `target: deps`？** Day 41 的 Dockerfile 是三阶段，最终镜像是 `runner` 段，它用 `--prod` 装依赖——**没有 `prisma` CLI**（CLI 是 devDep）。在 runner 镜像里跑 `prisma migrate deploy` 会直接 `command not found`。而 `deps` 段是全量安装，有 prisma CLI、还 `COPY` 了 `prisma/`（schema + migrations + migration_lock.toml）——正好是 migrate 需要的全部输入。拿 deps 段当这个一次性 job 的镜像，最省也最对：migrate 只需要 CLI 和迁移文件，不需要编译产物。

**`prisma migrate deploy` 是幂等的。** 它只应用**尚未应用**的迁移，已应用的不动。所以你反复 `docker compose up`，第一次它建表，之后每次都打印「No pending migrations」然后干净退出（0）——不会重复建表。这也是为什么它配 `restart: "no"` 安心当个一次性任务。

> 对比一下：本地开发用的是 `prisma migrate dev`（会【生成】新迁移、还会改库），生产/部署必须用 `migrate deploy`（只【应用】已有迁移、绝不生成）——两者绝不能混。`package.json` 里分别叫 `prisma:migrate` 和 `prisma:migrate:deploy`，就是为了把这个区别落到脚本名上。

### 5. 存活 vs 就绪：编排器真正该问的问题

这是今天概念上的核心，也是 Day 41 那句「真正的 readiness 要接 terminus」的兑现。

**两个问题，别混成一个：**

| 探针 | 问的是 | 答案取决于 | 挂了的处理 |
|---|---|---|---|
| 存活（liveness） | 进程**在不在** | 进程本身 | 重启容器 |
| 就绪（readiness） | **能不能接流量** | 进程 + 下游依赖（DB/Redis） | **不重启**，只是先别把流量导过来 |

为什么必须分开？因为「进程活着」和「能服务请求」是两回事：api 进程活得好好的，但它依赖的 DB 刚好抖了一下——这时候**不该重启 api**（进程没毛病，重启纯属添乱），只该**暂时别给它导流量**，等 DB 恢复。把两件事捏成一个探针，要么该重启时不重启、要么不该重启时瞎重启。Kubernetes 之所以有 `livenessProbe` 和 `readinessProbe` 两个独立探针，就是这个原因。

我们用 `@nestjs/terminus` 实现就绪探针，分两个端点：

```ts
// health.controller.ts
@Get()              // 存活：进程级，不碰 DB/Redis
liveness() {
  return { status: 'ok', uptime: process.uptime(), timestamp: ... };
}

@Get('ready')       // 就绪：查 DB + Redis，任一不可用 → terminus 抛 503
@HealthCheck()
readiness() {
  return this.health.check([
    () => this.prisma.pingCheck('database', this.db),   // 底层一条 SELECT 1
    () => this.redis.pingCheck('redis'),                // 一条 PING
  ]);
}
```

`/health` 沿用 Day 35 就 `@SkipThrottle` 过的那个进程级端点——又快又稳，**不查任何下游**，适合被高频探。`/health/ready` 才真正查依赖：terminus 对每条指标跑一次（DB 是 `SELECT 1`、Redis 是 `PING`），任一失败就把整体状态判为 down、抛 `ServiceUnavailableException(503)`。

**这个分离在 compose 里怎么兑现？** 这是今天最值得想透的接线：

```dockerfile
# Day 41 的 Dockerfile 里，镜像内置的 HEALTHCHECK 打的是 /health（存活）：
HEALTHCHECK ... CMD wget ... http://localhost:${PORT:-3000}/health
```

```yaml
# Day 42 的 compose 里，api 的 healthcheck 把它【覆盖】成 /health/ready（就绪）：
api:
  healthcheck:
    test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost:3000/health/ready"]
```

为什么 compose 要覆盖镜像里的探针？因为编排器用 healthcheck 来回答「**这个服务能不能接流量了**」——这正是**就绪**问题，不是存活。镜像内置的 `/health` 只能说「进程在」，DB 连不上它照样 200，编排器据此放流量就会把请求导进一个必定 500 的实例。覆盖成 `/health/ready` 后：DB 或 Redis 没就绪 → 503 → 探针判 unhealthy → 编排器不导流量；等依赖恢复 → 200 → healthy → 流量回来。

> 那 Dockerfile 里的 `/health` 存活探针还有用吗？有。`docker run` 单独跑镜像时（Day 41 的场景），没有 compose 帮你做依赖编排，存活探针告诉你「进程在不在」就够了。**镜像自包含（存活）、compose 按需覆盖（就绪）**——两者各司其职，正是一份镜像既能单独跑、又能进编排的关键。

### 6. 写 terminus 自定义指标踩的坑：必须「抛」，不能只「返回」

实现就绪探针时撞了个 terminus 的反直觉约定，值得单独拎出来。terminus 内置了一堆指标（Prisma / TypeORM / Mongoose / DNS…），偏没有 ioredis 的——所以 Redis 这条得自己写个 `RedisHealthIndicator` 继承 `HealthIndicator`。第一版照着「返回结果对象」的直觉写：

```ts
// ❌ 反面：只返回 { status: 'down' }，terminus 不认账
async pingCheck(key: string) {
  const isHealthy = await this.redis.ping();
  return this.getStatus(key, isHealthy);   // false 时返回 { redis: { status: 'down' } }
}
```

跑起来发现 Redis 断了 `/health/ready` 还是 200——响应体里 `redis.status: 'down'` 清清楚楚，但整体 `status` 仍是 `ok`。翻 terminus 内置 `PrismaHealthIndicator` 的源码才看清约定：

```ts
// ✅ terminus 的约定（和内置指标一致）
if (isHealthy) {
  return this.getStatus(key, true);
}
// 不健康必须【抛】HealthCheckError，光返回 down 没用
throw new HealthCheckError(`${key} is not available`, this.getStatus(key, false));
```

terminus 的判定逻辑是：**指标函数正常返回 = 当作 info（健康）；指标抛 `HealthCheckError` = 才算 error、才把整体状态翻成 down、才会让 `@HealthCheck` 返回 503。** 光返回一个 `{status:'down'}` 的对象，terminus 把它当普通信息塞进 `info`，整体依旧是 ok。这个「健康靠返回、不健康靠抛」的不对称，不看源码很难猜到——记下来，以后写任何 terminus 自定义指标都受用。

（`RedisHealthIndicator` 最终版就是上面那 5 行 `if/throw`，见 `src/health/redis.health.ts`。`ping()` 复用了 `RedisService` 已有的方法——它内部已经 try/catch、连不上返回 false 而不是抛，符合「缓存挂了不搞崩进程」的降级哲学。）

### 7. 就绪判定的边界：DB 必查，Redis 呢？

就绪探针查哪些依赖，是个**没有标准答案的 SLO 决策**，今天我们做了个明确取舍并讲清理由。

- **DB 必查。** 它是真相源，应用的所有读写都依赖它；PrismaService 启动即 `$connect()`、连不上直接崩。DB 挂了应用根本没法服务任何请求——不查它，就绪探针就失去意义。
- **Redis 也查（但有争议）。** 按应用的设计，Redis 是**可选**的缓存层：连不上时 `RedisService` 静默降级、请求直连 DB，应用照样能跑（只是变慢）。所以「Redis 挂了算不算 not ready」可以两说。

我们选择**把 Redis 也纳入就绪判定**，理由是：在这套 compose 里 Redis 一定会起；把它纳入就绪，能让编排器在缓存层没就绪时**先别导流量**——避免应用刚起、缓存还是空的，首批请求一股脑穿透到 DB（cache stampede，把刚启动的 DB 打懵）。这个取舍的本质是：**就绪探针查什么，取决于「你的 SLO 里，少这个东西服务还达不达标」**。

如果你的部署里 Redis 真的可能缺席（比如某些环境就是不开缓存），又希望 api 照常 ready，改法只有一行——从 `health.check([...])` 的数组里删掉 Redis 那条，让就绪只判 DB。控制器里的注释把这一点写明了，README 这里再强调一次：**就绪判定的边界是设计选择，不是天条。**

### 8. 网络与卷：localhost 是容器自己，数据要搬出容器

两个 Day 41 已经埋下、今天正式解决的问题。

**① 网络与服务名。** 容器里的 `localhost` 指的是**容器自己**，不是宿主机，更不是别的容器。所以 compose 里 api 的依赖地址全从 Day 41 练习里的 `host.docker.internal` 换成了服务名：

```yaml
api:
  environment:
    DATABASE_URL: postgresql://blog:...@postgres:5432/blog?schema=blog_api   # 不是 localhost
    REDIS_URL: redis://redis:6379
```

`postgres`、`redis` 是同一 compose 网络里的服务名，Docker 内置 DNS 负责解析成对应容器的内网 IP。比 Day 41 那个 `--add-host=host.docker.internal=host-gateway` 干净得多——不用再让流量绕出容器、经过宿主机再绕回来。

**② 数据卷。** 容器的文件系统是**临时的**：容器一删，里面写的所有东西（DB 数据、上传的封面图）全没。要持久化，得把「需要活过容器生命周期的目录」挂成命名卷：

```yaml
volumes:
  pg-data:       # PG 数据目录 → 重建容器不丢库
  uploads:       # 本地存储后端的封面图 → 重建容器不丢图
  redis-data:    # 我们关了 redis 持久化，这个卷基本空着，留作将来开 appendonly
```

宿主机上这些卷由 Docker 管理（不在你的项目目录里，避免污染）。配两个常被混淆的命令：

```bash
docker compose down          # 停并删容器 + 网络，但【保留卷】→ 数据还在
docker compose down -v       # 同上，且【连卷一起删】→ DB 数据、上传图全清空，回到出厂
```

`down -v` 是「彻底重置」——第一次跑通栈、想从头再来时用；日常停服务用 `down` 就够，下次 `up` 数据还在。**别养成 `down -v` 的肌肉记忆**，会丢数据。

> 顺带一个设计决定：这份 compose 里 **PG 和 Redis 都不映射宿主机端口**（只有 `api` 暴露 3000）。它们只给同网络的 api / migrate 访问，不对宿主机裸露——少一个攻击面，也避免和 `blog-db/docker-compose.yml` 那套 dev 栈抢 5435/6379 端口（两套栈能共存）。要进 DB 看数据：`docker compose exec postgres psql -U blog -d blog`。

### 9. 环境变量：从镜像里搬出来，运行时注入

Day 41 立的「配置绝不进镜像」红线，今天在 compose 这层落地。三种注入姿势，各有适用场景：

**① `environment:` —— 直接写死或用插值。** 适合非敏感、或跟随服务名变化的配置。我们的连接串就写在这：

```yaml
environment:
  DATABASE_URL: postgresql://blog:${POSTGRES_PASSWORD:-blog_dev_pwd}@postgres:5432/blog?schema=blog_api
```

**② `${VAR:-默认}` vs `${VAR:?必填}` —— 两种插值，哲学相反。**

- `${POSTGRES_PASSWORD:-blog_dev_pwd}`：有就用你的，没有就用默认——**友好降级**，dev 友好。
- `${JWT_ACCESS_SECRET:?在 .env 里设置 ...}`：**没有就报错退出**。为什么 JWT 用这个？因为镜像硬编码了 `NODE_ENV=production`，而 `config.validation.ts` 在 production 下会**拒绝** `.env.example` 的示例 secret——所以 compose 必须拿到一个真 secret，少一个字符应用都起不来。用 `${VAR:?}` 把这个要求前移到 compose 层：你没设，连 `up` 都别想成功，错误信息还指名道姓告诉你去哪设。和应用的 fail-fast 是同一个哲学，只是提前了一道闸。

**③ `env_file` / compose 自动读 `.env`。** compose 会自动读取**和 compose 文件同目录**的 `.env`，把它里面的变量用于 `${...}` 插值。所以我们配了 `solutions/blog/.env.example`，用法是 `cp .env.example .env` 填好 secret 再 `up`——标准 compose 工作流。`.env` 进了 `.gitignore`（含密钥，绝不提交）。

> 不管用哪种姿势，**密钥仍然不进镜像**（Day 41 的红线）。区别只是「运行时怎么喂给它」：Day 41 的 `docker run -e` 是手动喂，compose 的 `environment` / `env_file` 是声明式地喂——本质都是「镜像和环境无关，换套变量就能从开发切到生产」。

### 10. 怎么验证（本机连不上镜像仓库）

本机环境连不上镜像仓库（`docker build` / `pull` 会卡在拉镜像层），没法在这里完整 `docker compose up` 跑通。改用三层验证——和 Day 41 同一套思路：

1. **语法 + 变量插值**：`docker compose -f solutions/blog/docker-compose.yml config`。它不拉镜像、不构建，只解析 YAML、做 `${...}` 插值、校验服务/依赖/卷的引用是否合法。这份 compose 用它跑过，输出里 `depends_on` 的三个 condition、`target: deps`、卷引用都正确展开。（`config` 在缺 `${JWT_ACCESS_SECRET:?}` 时会主动报错退出——正好验证了第 9 节的 fail-fast 闸门。）
2. **业务逻辑层**：`pnpm build` + `tsc --noEmit` 验证就绪探针代码能编译；`docker-compose.yml` 引用的 Dockerfile 是 Day 41 已验证过的，今天没动它。
3. **静态审查**：人工核对 depends_on 链无环、healthcheck 都配了、卷和端口引用一致、服务名和 `environment` 里的连接串对得上。

> 想真跑构建，配个国内可达的 registry mirror（阿里云 / daocloud）或可拉的镜像源即可。本机这条网络限制是环境的，不是 compose/Dockerfile 的问题。

---

## 改动清单（接进 solutions/blog）

| 文件 | 改了什么 |
|---|---|
| `solutions/blog/docker-compose.yml` | **新增**：全栈编排（postgres + redis + migrate job + api）。`depends_on` 三 condition 串启动顺序；migrate 用 `target: deps` 跑 `migrate deploy`；api 的 healthcheck 覆盖成 `/health/ready`（就绪）；PG/Redis 不暴露宿主机端口，命名卷持久化 |
| `solutions/blog/.env.example` | **新增**：`JWT_ACCESS_SECRET`（必填，≥32 字符）+ `POSTGRES_PASSWORD` / `API_PORT` 可选默认。`cp .env.example .env` 后 `docker compose up` |
| `solutions/blog/.gitignore` | **新增**：忽略 `.env`（含密钥） |
| `blog-api/src/health/health.controller.ts` | `/health` 改名 `liveness`（行为不变，探针仍只查进程）；**新增 `/health/ready`** 就绪探针，terminus 查 DB + Redis，任一不可用 503 |
| `blog-api/src/health/redis.health.ts` | **新增**：自定义 terminus 指标 `RedisHealthIndicator`（terminus 没内置 ioredis 指标）。踩了「不健康必须抛 `HealthCheckError`」的坑（见 §6） |
| `blog-api/src/health/health.module.ts` | 接入 `TerminusModule.forRoot()`；provide 自定义的 `RedisHealthIndicator` |
| `blog-api/package.json` | 描述补到 Day 42；新增 `prisma:migrate:deploy` 脚本（生产部署用，区别于 dev 用的 `prisma:migrate`） |
| `blog-api/test/health.e2e.test.ts` | **新增**：验两条探针——存活 `/health` 恒 200；就绪 `/health/ready` 健康时 200、Redis 掉线时 503 而存活仍 200（断开 RedisService 连接模拟掉线） |

---

## ✅ 一份诚实清单

✅ **今天到位的：**
- 一份 `docker-compose.yml` 把 api + PG + Redis + 迁移 job 编排在一起，`docker compose up -d` 一条命令拉起
- `depends_on` 三 condition 讲透并正确使用：`service_healthy`（PG/Redis）+ `service_completed_successfully`（迁移 job）+ 默认 `service_started` 为什么不够
- 独立迁移 job（`target: deps` + `migrate deploy` + `restart: no`），讲清为什么不入队 api、为什么 idempotent、为什么 fail-closed
- 存活 vs 就绪的分离落地：`@nestjs/terminus` 实现 `/health/ready`；compose 覆盖镜像内置探针用就绪当流量闸门；Dockerfile 的存活探针仍服务「单独 run」场景
- terminus 自定义指标的真实坑（不健康必须抛 `HealthCheckError`）写进代码注释和 §6
- 容器网络（服务名 DNS）+ 命名卷持久化 + `down` vs `down -v` + PG/Redis 不暴露宿主机端口
- 环境变量三层姿势 + `${VAR:-x}` vs `${VAR:?x}` 的 fail-fast 闸门；密钥仍不进镜像

⚠️/❌ **还没做、留给后面的：**
- **真跑一次完整构建**：本机连不上镜像仓库，`docker compose up` 的端到端跑通留待配 registry mirror 后验证；当前用 `compose config` + `pnpm build` + 静态审查三层兜底
- **生产级编排**：这份是单机 compose（demo / 小规模够用）。真正的生产编排是 Kubernetes——`Deployment`/`StatefulSet`/`Job`/`livenessProbe`/`readinessProbe`/`ConfigMap`/`Secret`，对应关系几乎是一一映射（compose 的每节都能在 k8s 找到对应物）
- **配置与密钥管理**：`.env` + `env_file` 适合开发；生产该上集中式密钥管理（Vault / 云 KMS / Sealed Secrets），密钥不落盘明文
- **多环境 compose override**：`docker-compose.yml` + `docker-compose.prod.yml`（override 机制），开发 / 预发 / 生产共用一份基础编排 + 各自覆盖——今天只写了一份
- **优雅停机与零停机部署**：今天 `depends_on` 只管启动顺序；滚动更新（新版 api 顶替旧版时不丢请求）要靠编排器的 rolling update + readiness 闸门，是更后面的话题

---

## 💻 实践练习

> 本机连不上镜像仓库，下面的 `docker compose up` 类操作需要配 registry mirror 后才能完整跑通。`docker compose config` 这类纯解析操作现在就能跑。

1. **校验编排文件**（不拉镜像、不构建，现在可跑）：
   ```bash
   cd solutions/blog
   JWT_ACCESS_SECRET=test-secret-at-least-thirty-two-chars-long \
     docker compose -f docker-compose.yml config | less
   ```
   读输出，确认：`api.depends_on` 有三个 condition、`migrate.build.target` 是 `deps`、PG/Redis 没有 `ports`、`api.healthcheck` 打的是 `/health/ready`。把 `JWT_ACCESS_SECRET` 去掉再跑一次，应看到 compose 直接报错退出（验证 `${VAR:?}` 闸门）。

2. **准备配置**：
   ```bash
   cd solutions/blog
   cp .env.example .env
   # 用 openssl rand -base64 32 生成一个真 secret，填进 .env 的 JWT_ACCESS_SECRET
   ```

3. **拉起整套栈**（需可拉镜像）：
   ```bash
   docker compose up -d --build
   docker compose ps                 # 看 postgres/redis healthy、migrate exited(0)、api healthy
   docker compose logs migrate       # 应看到迁移逐条应用，最后 "No pending migrations"
   ```

4. **验证两条探针的差异**（核心练习）：
   ```bash
   curl -s localhost:3000/health        # 存活：{ data: { status: "ok", uptime, ... } }
   curl -s localhost:3000/health/ready  # 就绪：{ data: { status: "ok", info: { database:{status:up}, redis:{status:up} }, ... } }
   ```
   然后模拟缓存掉线，看就绪探针怎么变红而存活不变：
   ```bash
   docker compose stop redis
   sleep 15                            # 等一轮 healthcheck interval
   curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/health        # 仍 200
   curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/health/ready  # 503
   docker compose ps                                                   # api 变成 unhealthy
   docker compose start redis; sleep 15                                # 恢复
   curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/health/ready  # 回到 200，api 重新 healthy
   ```
   这一段把「进程在 ≠ 能接流量」演给你看：redis 一停，存活还是 200、就绪翻 503、编排器把 api 标 unhealthy（不再导流量）；redis 回来，一切自愈。

5. **验证持久化**：
   ```bash
   docker compose down                # 注意：不加 -v
   docker compose up -d
   # 数据还在（migrate 显示 No pending、之前注册的账号还在）
   docker compose down -v             # 这才彻底清空（卷一起删）
   ```

6. **思考题**：
   - 如果删掉 `migrate` 服务和 api 对它的 `depends_on`，第一次 `up` 会怎样？第二次呢？（提示：迁移没人跑，api 起来一查表全没有。）
   - compose 里 api 的 healthcheck 打 `/health/ready`、Dockerfile 里打 `/health`——把两者对调会发生什么？（存活探针太严，DB 抖一下就重启 api；就绪探针太松，DB 挂了还导流量。）
   - `depends_on` 管的是**启动顺序**。如果 postgres 在 api 已经 healthy 之后崩溃，`depends_on` 会让 api 重启或暂停接流量吗？（不会——`depends_on` 只在启动时生效；运行时依赖挂了，要靠 readiness 探针变红让编排器停止导流量，或靠应用自身的降级。这正是 §5 存活/就绪分离的价值。）

---

## ✅ 今日产出

- [ ] `docker compose config` 通过；读懂输出里的 depends_on 链、target、healthcheck、卷引用
- [ ] （可拉镜像时）`docker compose up -d` 一条命令拉起整套栈，`compose ps` 全 healthy
- [ ] `curl /health` 恒 200；`curl /health/ready` 健康时 200、redis 停时 503——亲手看到存活/就绪的差异
- [ ] 在笔记里写下：三种 depends_on condition 的区别、迁移 job 为什么独立、存活 vs 就绪、terminus 自定义指标必须「抛」的坑、服务名 DNS、`down` vs `down -v`
- [ ] 提交代码到 GitHub

---

[⬅️ Day 41](../day-41/) | [➡️ Day 43](../day-43/)
