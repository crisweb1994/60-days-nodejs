# Day 44 — 云部署实战

> Day 41 把应用打成了镜像、Day 42 用 compose 把它和 PG/Redis/迁移 job 编排成一键拉起的栈、Day 43 又把「构建 + 推 GHCR」自动化了。但到昨天为止，那个镜像还**躺在 registry 里没服务过任何一个真实请求**——Day 43 的 `deploy` job 是个「形状」：里面只有一行被注释掉的 `ssh prod 'docker compose pull ...'`，因为我诚实地承认：连哪台主机、连哪个库、域名怎么解析，这个学习仓库都还没有。
>
> 这一天就是来把这层填满的。核心不是「学某个平台的按钮」——按钮半小时就会点——而是想透几件部署时绕不开、且容易想当然的事：这套镜像**为什么不该上 Vercel**（常驻进程 vs serverless，BullMQ worker 和本地存储直接打架）；托管数据库和托管 Redis **替你扛掉了什么**，又**塞给你什么新坑**（PgBouncer 连接池 + Prisma）；迁移在生产**到底谁来跑**（这里有个 Day 41 镜像留下的真坑）；以及容器里的 `/app/uploads` **为什么不能当生产存储**。
>
> 一句话目标：给 Day 41 的镜像配齐两套真实可用的部署形态（Fly.io + Railway），写一份生产环境变量清单，并把「域名 + HTTPS 怎么落地」讲清。本机连不上云、也跑不了真部署，验证方式见 §13——和 Day 41/42/43 同一个现实约束，同一套诚实兜底。

## 📋 今日目标

- 想透**平台选型**：为什么 Day 41 的常驻进程镜像选 Fly / Railway 而不是 Vercel——把「serverless 函数」和「常驻服务」的执行模型差别讲死
- 把 Day 41-43 的镜像部署成**两个真实形态**：Fly.io（`fly.toml`，Docker 原教旨 + 机型 + 健康检查）和 Railway（`railway.json`，最省心的一键）
- 选**托管 PostgreSQL**（Supabase / Neon）和**托管 Redis**（Upstash），不再自己 `docker compose up postgres`——并讲清 PgBouncer 连接池给 Prisma 带来的 `directUrl` 坑
- 把「迁移在生产谁跑」想死：Day 41 的生产镜像**不带 `prisma/` 迁移目录**，所以迁移不能在 prod 镜像里跑——给出 CI / 一次性容器两条正确姿势
- 理解**启动顺序的 fail-fast**：`PrismaService.onModuleInit` 握手 DB，连不上**启动即崩**（我实测的 P1001）——这正是平台 `restartPolicy` 和就绪探针要兜的事
- 把容器内 `/app/uploads` 换成 **S3 / R2 对象存储**，并说清「自动停机」为什么会饿死 BullMQ worker
- 配齐**域名 + HTTPS**：平台默认子域 + 自动 Let's Encrypt 证书，自定义域要同步改 `CORS_ORIGIN` 和 OAuth 回调

> 配套代码：`solutions/blog/blog-api/`。**新增** `fly.toml`（Fly 部署：机型 / 健康检查 / 关自动停机保 worker）、`railway.json`（Railway 部署：healthcheck + restartPolicy + 关睡眠）、`.env.production.example`（生产环境变量逐项清单）。
> Day 41 的 `Dockerfile`、Day 42 的 `docker-compose.yml`、所有 `src/` 业务代码**一行没动**——今天只在镜像之外配「它跑在哪、连什么」。

---

## 📖 核心知识点

### 1. 这天在解决什么：从「镜像在仓库」到「应用在公网」

先把 Day 41-43 留的「尾巴」摆出来，对照今天怎么接：

| Day 41-43 的状态 | 还差什么才叫「上线」 | Day 44 怎么补 |
|---|---|---|
| 镜像在 GHCR 里，`deploy` job 是注释掉的 `ssh` | 没有任何环境在跑它 | 选平台（Fly / Railway），把镜像跑成**常驻服务** |
| PG / Redis 是 compose 里的容器 | 容器一停数据就没了、没有备份、没有连接池 | 换**托管数据库 / 托管 Redis**，交给云方运维 |
| 迁移靠 Day 42 的 compose `migrate` job | 云平台上没有那个 job | 定清**迁移在生产谁跑**（§6，一个真坑） |
| 封面图写到容器 `/app/uploads` | 重启 / 多实例各写各的，互相看不见 | 换 **S3 / R2 对象存储**（§9） |
| 只有 `localhost:3000` 能访问 | 公网打不开、没 HTTPS | 配**域名 + 自动证书**（§12） |
| 没有「它到底活没活着」的外部视角 | 崩了没人知道 | 平台**健康检查 + 重启策略**（§7-8） |

带着这张表读后面，会发现「部署」不是点个按钮，而是**把「本地能跑」时被默认值糊过去的每一项（数据存哪、迁移谁跑、图存哪、流量怎么进来、崩了怎么办），逐个换成生产级的明确答案**。

### 2. 先选平台：为什么这套镜像不选 Vercel

这一节值得放在最前面，因为它是新手部署 NestJS 时**最常见、最浪费时间**的错误方向。

Day 41-43 产出的是一个**常驻进程**：一个 `node dist/main` 进程一直开着，里面同时跑着 Nest HTTP 服务器 **和** BullMQ worker（`src/queue/mail.processor.ts`，注册用户后异步发欢迎邮件靠它常驻轮询 Redis）。

Vercel 的执行模型是**无服务器函数（serverless function）**：请求来 → 起一个函数实例 → 处理 → **立刻销毁**。它没有「一直开着的进程」。这套里有两样东西和它**天然打架**：

- **BullMQ worker**：靠进程常驻才能消费队列。函数跑完即灭，队列里排着的邮件**永远没人取**——用户注册后那封欢迎邮件，要等下一次有人打 API 时函数才被唤起、才有机会顺带消费一下。这不是「慢」，是「基本不工作」。
- **本地文件存储 `/app/uploads`**：Day 39 的 `STORAGE_BACKEND=local` 把封面图写到磁盘。Vercel 的文件系统是**只读 + 临时**的，写进去的文件，这个请求结束、下一个请求就没了——图传完就丢。

| 执行模型 | 代表 | 常驻进程？ | BullMQ worker | 本地写文件 | 适合这套镜像吗 |
|---|---|---|---|---|---|
| Serverless 函数 | Vercel / Netlify Functions | ❌ 请求级起灭 | ❌ 没人消费 | ❌ 临时只读 | ❌ |
| 常驻容器 | Fly / Railway / Render | ✅ 一直开着 | ✅ 正常 | ✅（但见 §9 要换 S3） | ✅ |
| 编排器 | Kubernetes / ECS | ✅ N 个副本 | ✅ | ✅（要挂卷） | ✅（重，留到后面） |

Fly 和 Railway 都是「给你一台/几台**常驻的 Docker 主机**」——进程一直开着、能写卷、想缩到 0 也行。这才是 Day 41 镜像的正确归宿。Vercel 留给纯前端 / 边缘函数那类「无状态、按请求计费」的工作负载。

> 一句话判断标准：**你的代码里有没有「请求之外还要持续运行的东西」**（worker、定时任务、WebSocket、缓存预热）。有 → 要常驻进程 → 别上 serverless 函数平台。

### 3. 两个候选：Fly.io 与 Railway

都吃 Docker、都给常驻进程，差别在「你想管多细」：

| | Railway | Fly.io |
|---|---|---|
| 心智模型 | **最省心**：连仓库、选 Dockerfile、自动检测、给个子域就能跑 | **Docker 原教旨**：`fly.toml` 把机型 / 区域 / 健康检查全写明 |
| 配置文件 | `railway.json`（可选，不写也能跑，靠自动检测） | `fly.toml`（`fly launch` 生成，强烈建议提交） |
| 数据库 / Redis | 一键加「plugin」（自带 PG/Redis），也可连外部托管 | 要自己配托管 DB/Redis（Fly 也有但偏原始） |
| 缩到 0 | 默认不缩（可开 sleep） | `auto_stop_machines`，粒度更细 |
| 健康 / 重启 | `healthcheckPath` + `restartPolicy` | `[[http_service.checks]]` + 机器自动重启 |
| 适合 | 想最快上线、不想碰基础设施细节 | 想精确控制机型 / 区域 / 卷，或要部署到多个区域 |

今天给**两套都配齐**：Railway（`railway.json`）是「五分钟上线」的那条路；Fly（`fly.toml`）是「把部署形态写成代码、可 review」的那条路。两套指向**同一个 Day 41 镜像**——这正是 Day 41「镜像自包含、和运行环境无关」设计的回报：换平台只换外面的配置，镜像不动。

### 4. 托管 PostgreSQL：Supabase / Neon，和 PgBouncer 的坑

本地我们 `docker compose up postgres` 起一个 PG 容器。生产里**别这么干**——自己运维一个数据库要扛：备份、版本升级、连接数上限、磁盘扩容、高可用。这些全交给**托管 PostgreSQL**（Supabase / Neon / Railway 自带 PG / Render PG）：

- 给你一个 `postgresql://...` 连接串，云方负责它活着、有备份、能扩。
- 免费 tier 够学习项目用；正式项目按用量付费。

但托管 PG 几乎都**在前面挡了一层 PgBouncer 连接池**（Supabase 的 pooler 端口 6543、Neon 的 pooled 连接）。连接池的作用：PG 一个连接很贵（每个 fork 进程吃内存），池子用少量长连接复用服务大量客户端。可它和 Prisma 有个**经典冲突**：

> Prisma 默认用 **prepared statement**（预编译 SQL）。PgBouncer 的「事务模式」下，事务结束连接就还回池子、可能换给别的客户端，而 prepared statement 是**绑定在某条连接上的**——于是报错：`prepared statement "..." does not exist`。

解法两步（我们这一版**先用直连、绕开它**，把它记成「流量大了再做」）：

1. 连池子的 URL 带参数：`?pgbouncer=true&connection_limit=1`（让 Prisma 知道在池子后面、且每次只用一条连接）。
2. **迁移走直连**：`migrate deploy` 不能走事务模式的池子（它自己要开事务管迁移表）。Prisma 的 schema 加 `directUrl`：
   ```prisma
   datasource db {
     url      = env("DATABASE_URL")           // 运行时：走池子
     directUrl = env("DIRECT_DATABASE_URL")   // 迁移：走直连
   }
   ```

我们当前的 `prisma/schema.prisma` 只有 `url = env("DATABASE_URL")`、没 `directUrl`——所以 `.env.production.example` 里**默认给的是直连串**（Supabase/Neon 都提供非池化的 direct 连接），迁移和运行时用同一条，最省事、零坑。等并发连接数真的成为瓶颈，再按上面两步切到池子 + directUrl。**别一上来就上连接池**——多数学习 / 中小项目，直连的连接数上限（Supabase 直连 ~60-100）完全够用，多一层池子只是多一个能踩的坑。

### 5. 托管 Redis：Upstash，和本地 localhost 的差别

Day 36 起 Redis 做缓存、Day 38 起做队列。本地是 compose 里的 `redis` 容器（`redis://localhost:6379`）。生产换 **Upstash**（或 Railway/Render 的 Redis）：

- 给一个 `rediss://` 连接串——注意是 **`rediss`**（多一个 s = TLS）。`config.validation.ts` 的 refine 同时接受 `redis://` 和 `rediss://`，所以 Upstash 的 TLS 串直接能用，不用改代码。
- 缓存和队列在我们这套里都是**可选降级层**：Redis 临时不通，API 退回直连 DB（缓存 miss）、邮件降级为下次补发（队列堆积），不会 500。这和数据库的**必填**正好相反——见下一节的 fail-fast 对比。

> 选 Upstash 的一个理由：它的免费 tier 基于「每请求数据量」计费，且支持 `rediss://`（TLS）开箱即用；很多廉价 Redis 托管只给明文 `redis://`，公网裸奔不安全。公网连 Redis，**必须 TLS**。

### 6. 迁移在生产谁跑：Day 41 镜像留下的真坑

这是今天**最该想清楚的一节**。本地/Day 42 里，迁移靠一个独立的 `migrate` job：它 `target: deps`（用 Dockerfile 的 deps 段，那里有**完整依赖含 prisma CLI** + `COPY prisma` 了**迁移目录**），跑 `prisma migrate deploy`，成功后 api 才起。

到了云平台，问题来了。看 Day 41 的 `Dockerfile` **runner 段（最终镜像）装了什么**：

```dockerfile
RUN ... pnpm install --frozen-lockfile --prod --ignore-scripts   # ① 只装生产依赖，prisma CLI 是 devDep → 没有
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma # ② 只拷生成出的 client，不拷 prisma CLI
COPY --from=build /app/dist ./dist                                # ③ 只拷编译产物
```

注意它**既没有 `prisma` CLI，也没有 `COPY prisma`（迁移目录都没进镜像）**。这是 Day 41 有意的最小化——生产镜像越精简越安全。但代价是：**你没法在 prod 镜像里跑 `prisma migrate deploy`**（没 CLI、没迁移文件）。Railway 的 `preDeployCommand`、想在 deploy 时顺手 migrate 的念头，**在这里会直接失败**。

所以迁移必须从**镜像之外**跑。两条正确姿势：

**① 从 CI 跑（推荐，和 Day 43 衔接最顺）。** 在 Day 43 的 `docker-publish.yml` 里、`deploy` 之前加一个 `migrate` job：checkout 全量代码 → 装 prisma → `prisma migrate deploy`，`DATABASE_URL` 用仓库 Encrypted Secret（指向生产库）。迁移成功，才放行 deploy。CI runner 有完整代码 + 网络，不受镜像精简影响。

**② 跑一次性容器（手动 / 脚本）。** 用 Dockerfile 的 `deps` 段起个一次性容器（那里有 prisma + 迁移），指 prod 库跑一次：

```bash
# 在 blog-api 目录：用 deps 段（含 prisma + 迁移）跑一次性 migrate，指向生产库
docker build --target deps -t blog-migrate:tmp .
docker run --rm -e DATABASE_URL='<生产直连串>' blog-migrate:tmp pnpm exec prisma migrate deploy
```

> 本机连不上镜像仓库，这条没法在这跑——但它是 Day 42「独立 migrate job」思想在云上的直接平移：**迁移是一次性、要串行、要独占**的动作，永远不该塞进随时可能横向扩 N 份的应用进程里。

### 7. 启动顺序的 fail-fast：连不上 DB，启动即崩

我本机实测了一件事（见 §13）：用生产环境变量起 `node dist/main`，但 PG 没起——应用**不是「起来了但 /health/ready 返回 503」，而是直接崩**：

```
PrismaClientInitializationError: Can't reach database server at `localhost:5435`
  ...at Proxy.onModuleInit (.../prisma.service.js:24:9)
```

原因在 `src/prisma/prisma.service.ts`：`PrismaService implements OnModuleInit`，启动时主动 `await this.$connect()`。**这是有意的 fail-fast**——「连不上数据库」在启动第一秒就暴露，而不是等第一个用户请求进来才报错（和 Day 20 的 zod env 校验同一个哲学）。

这给部署带来两个**直接后果**，都得接住：

- **DB 必须在应用启动前就可达 + 已迁移。** 顺序是死的：托管 PG 起好 → 迁移跑完 → 才能拉起应用。否则应用一启动、`$connect()` 失败、崩。这正是 §6「迁移在 deploy 前跑」的根本原因。
- **平台的 `restartPolicy` 是兜底。** 万一启动时 DB 还在冷启动（托管 PG 首次唤醒要几秒），应用会崩——Railway 的 `restartPolicy: { name: "ON_FAILURE", maxRetries: 3 }` 让它自动重试几次，给 DB 抢到就绪时间。`maxRetries` 不能太大，否则变成无限重启循环掩盖真问题。

> 对比一下数据库和 Redis 的**不对称**：DB 连不上 → 启动即崩（必填，fail-fast）；Redis 连不上 → 照常启动、降级直连 DB（可选，见 §5）。我实测里 DB 和 Redis 都没起，崩在 Prisma 的 P1001 而不是 Redis——印证了 Redis 那层是惰性 + 容错的。这个不对称是这套设计的主轴：**真相源（DB）必须到位才能服务，加速层（Redis/缓存/队列）缺了只降级**。

### 8. 健康检查映射到平台：/health 与 /health/ready 各打给谁

Day 42 已经把两个探针分开了（`health.controller.ts`），云平台正好接上：

| 端点 | 查什么 | 返回 | 平台拿它干什么 |
|---|---|---|---|
| `GET /health` | **进程级**：进程在不在（不碰 DB/Redis） | 永远 200（进程活着） | Railway 的 `healthcheckPath` / Fly 的轻量存活探针：判「这实例起来没」 |
| `GET /health/ready` | **就绪**：DB + Redis 都 `pingCheck` 得通 | 任一不通 → **503** | Fly `[[http_service.checks]]`：判「这实例**能不能接流量**」，503 就不导流给它 |

- 两个端点都 `@SkipThrottle`（Day 35）——平台探针每几秒高频打一次，不豁免会被限流误伤成 429，探针以为服务挂了。
- Fly 的 `fly.toml` 用 `/health/ready` 当流量检查：它 503 说明下游没就绪，Fly 就不把流量往这台导（和 Day 42 compose `depends_on: service_healthy` 的就绪闸门一个意思）。
- Railway 的 `healthcheckPath` 用 `/health`：Railway 的健康检查主要答「部署成没成」（进程起来没），用进程级 `/health` 更稳——避免因为 Redis 抖一下 503、被误判成「部署失败」而回滚。

> 这个分配不是死的。若你希望「DB 没就绪就别让 Railway 认为部署成功」，把 `healthcheckPath` 也指 `/health/ready` 即可——代价是 DB/Redis 任何一个抖动都可能让部署判定失败。多数情况，进程级 `/health` 管「起来」、就绪探针管「接流量」，是更宽容也更正确的分工。

### 9. 容器里的 /app/uploads 不持久：换 S3 / R2

Day 39 默认 `STORAGE_BACKEND=local`，封面图写到 `/app/uploads`，Day 41 的 Dockerfile 还专门 `mkdir uploads && chown` 给非 root 用户。**本地 / 单实例够用，生产不行**，三个理由：

- **重启即丢**：容器是临时的，重新部署 = 新容器 = 空的 `/app/uploads`（除非挂持久卷）。
- **多实例各写各的**：扩到 2 台，A 实例传的图存进 A 的本地盘，B 的本地盘里没有 → 用户下次从 B 读，404。
- **和 §2 的 Vercel 同病**：任何「文件系统是临时」的环境，本地存储都靠不住。

生产换 **S3 兼容对象存储**（AWS S3 / Cloudflare R2 / MinIO，Day 39 已经写好了同一套 `@aws-sdk/client-s3` 适配）——`.env.production.example` 里 `STORAGE_BACKEND=s3` + R2 配置。对象存储天然多副本、跨实例共享、不受容器生命周期影响。

> Fly 的 `fly.toml` 里留了个注释掉的 `[[mounts]]`（持久卷到 `/app/uploads`）。**只有当你铁了心用本地存储 + 永远单实例**时才取消注释——多实例下本地卷是各自一份、互不共享的，治标不治本。正解永远是 S3。

### 10. 自动停机的陷阱：别饿死 BullMQ worker

Fly 一个很诱人的省钱特性是 `auto_stop_machines = true`——没流量时自动把机器停掉、按需再起（scale-to-zero）。但**对这套镜像要关掉它**（`fly.toml` 里 `auto_stop_machines = false` + `min_machines_running = 1`），原因就是 §2 那个 BullMQ worker：

> 机器停了 = 进程没了 = 没人消费队列。用户注册、入队欢迎邮件，但因为没流量、机器睡着，这封邮件要等下次有人打 API 唤醒机器才会被处理。「省了空闲机器的钱」换来了「邮件可能延迟几分钟到几小时」——对注册欢迎邮件这种「该即时发」的，不可接受。

Railway 那边对等的是 `sleepApplication: false`（别在空闲时睡）。**只要你的应用里有常驻轮询的东西（worker / 定时任务 / WebSocket），就别开 scale-to-zero**——它和常驻进程的本质就是冲突的。要省钱，宁可缩机型（`memory = "512mb"`、`cpu_kind = "shared"`），也别停机。

### 11. 生产环境变量：.env.production.example 逐项

`.env.production.example` 是一份**对照清单**——上线时在平台的 Variables（Railway）/ `fly secrets set`（Fly）里逐项填进去。几条原则：

- **生产里没有 `.env` 文件进容器。** 本地靠 `.env`，生产靠平台注入的环境变量。`.env` 永远不进 Git（`.gitignore`），生产密钥更不进镜像（Day 41 的红线）。
- **`NODE_ENV=production` 触发校验收紧**：`config.validation.ts` 的 `superRefine` 会**拒绝** `.env.example` 里那个 `dev-only-access-secret-change-me-please`——占位 secret 上线 = 谁都能伪造 token，所以启动即崩。生产 `JWT_ACCESS_SECRET` 必须是 `openssl rand -base64 32` 生成的强随机串。
- **必填 vs 降级，分清**：`DATABASE_URL`（必填，连不上启动崩）、`JWT_ACCESS_SECRET`（必填）、`CORS_ORIGIN`（必填，填真实域名）属于**必须配对**；`REDIS_URL`（降级）、`GITHUB_CLIENT_*`（不配只是禁用 GitHub 登录）属于**缺了也能起**。
- **CORS 和 OAuth 回调要同步改**：上线后 `CORS_ORIGIN` 改成 `https://你的域名`，`GITHUB_CALLBACK_URL` 改成 `https://你的域名/auth/github/callback`，并去 GitHub OAuth App 把回调地址也改一致——三处对不上，前端跨域被拒、或 GitHub 回调 404。

### 12. 域名 + HTTPS：谁来终止 TLS

到昨天为止只有 `localhost:3000` 能访问。今天让它上公网 + HTTPS：

- **默认子域 + 自动证书**：Fly 给 `xxx.fly.dev`、Railway 给 `xxx.up.railway.app`，平台自动签 Let's Encrypt 证书、自动续期——**零配置就有 HTTPS**。`fly.toml` 的 `force_https = true` 把 http 请求 301 到 https。
- **自定义域**：在平台加你的域名（CNAME 指到平台给的目标），平台同样自动签证书。绑域名后，记得回头改 §11 说的 `CORS_ORIGIN` / OAuth 回调。
- **TLS 在平台终止（TLS termination）**：浏览器 →（HTTPS）→ 平台边缘 →（平台内部，http）→ 你的容器。你的应用**只听 http**（`PORT` 上的明文），HTTPS 由平台处理——所以应用代码完全不用管证书。这也是为什么 `CORS_ORIGIN` 要写 `https://`：浏览器看到的协议是 https，CORS 校验按浏览器的来。

### 13. 怎么验证：镜像真构建过、栈真起来过

先把两类「验证」分开——它们能验证的东西不同：

- **镜像构建 + 本地 compose 栈**：本机能真跑（docker hub 虽不通，但配 DaoCloud 镜像 `docker.m.daocloud.io` 后拉得到 `node:20-alpine` 等）。**Day 44 已经实跑 `docker compose up -d` 全链路验证**：postgres/redis/migrate/api 全 healthy，`GET /health/ready` → 200，注册→建文章→列表全通，BullMQ worker 真消费了欢迎邮件。详见下方第 5 层。
- **云平台真部署**（`fly deploy` / Railway 上线）：本机仍连不上云、也没账号，没法在此跑——靠下面 1-4 层静态兜底 + §练习里的真上线路径。

**真跑构建还顺带抓出 Day 41 Dockerfile 的两个潜伏 bug**（此前只做静态审查、从没真 build 过，所以一直没暴露，详见 [[改动清单]] 最后一行）：

1. runner 段在 `COPY package.json` 之前就 `pnpm install` → corepack 读不到 `packageManager: pnpm@10.15.0`，去拉了 latest（pnpm 11.9.0，不兼容 Node 20）→ `ERR_UNKNOWN_BUILTIN_MODULE` 启动即崩。
2. `COPY --from=deps /app/node_modules/.prisma` 指向不存在的路径 → pnpm 把生成物放在虚拟存储 `.pnpm/@prisma+client@5.22.0.../node_modules/.prisma`（不是顶层 `.prisma`），`@prisma/client` 按相对自己包目录解析它。两个都改了（见 Dockerfile 注释）。

> 这正是 Day 43 那条道理的回声：**静态审查会漏时序/路径这类 bug，真跑构建才抓得到**。Day 41 当初因 docker hub 不通只做了静态审查，把这两个坑留到了今天。

四层静态验证（针对云部署那些没法本地跑的部分）：

1. **配置文件语法**（现在可跑）：
   ```bash
   jq . solutions/blog/blog-api/railway.json >/dev/null                          # JSON 合法
   python3 -c "import tomllib;tomllib.load(open('solutions/blog/blog-api/fly.toml','rb'))"  # TOML 合法
   ```
   两份都解析通过。
2. **应用读 PORT、`rediss://` 被接受**：读 `config.validation.ts`——`PORT` 有默认 3000、从 env 读（所以 Railway 注入的 `PORT` 直接生效）；`REDIS_URL` 的 refine 同时收 `redis://` 和 `rediss://`（Upstash TLS 串能用）。这是静态事实，读码即验。
3. **fail-fast 实测**（我跑过的）：用生产环境变量起 `node dist/main`、但 PG 不通——应用在 `PrismaService.onModuleInit` 的 `$connect()` 处崩成 `P1001 Can't reach database server`。这**正面验证了** §7 的论断：DB 没就绪，应用启动即崩，而非软成 503。`/health` 与 `/health/ready` 的行为由 `health.controller.ts` 决定，逻辑确定（`/health` 永远 200、`/ready` 任一下游不通则 503），受限于 DB 起不来没法在此 curl 亲眼看，但读码即明。
4. **静态审查**：人工核对——`fly.toml` 的 `internal_port=3000` 和应用默认 PORT 对得上；`/health/ready` 路径和 controller 一致；`auto_stop_machines=false` 保 worker；`railway.json` 没设 `startCommand`（让 Dockerfile 的 `ENTRYPOINT[tini]+CMD[node dist/main]` 原样跑）；`.env.production.example` 每一项都能在 `config.validation.ts` 找到对应 schema。

5. **镜像真构建 + 栈真起来**（Day 44 实跑过）：
   ```bash
   # 配 DaoCloud 镜像后（见 §13 开头），本机能完整构建 + 起栈
   JWT_ACCESS_SECRET=$(openssl rand -base64 32) \
     docker compose -f solutions/blog/docker-compose.yml up -d --build
   curl localhost:3000/health/ready   # → 200, database/redis 均 up
   ```
   实测：postgres→migrate(job 退出)→api healthy 全自动；注册拿 Token→建文章→列表 `total:1`；日志里 BullMQ worker 消费了 `[welcome]` 邮件。镜像 `blog-stack-api` ≈ 289MB。**这套实跑同时暴露并修掉了上面两个 Day 41 Dockerfile bug。**

> 想看真绿灯，最直接的路：按 `.env.production.example` 在 Supabase 建库、在 Upstash 建 Redis、`fly launch`（或 Railway 连仓库）填齐变量、跑一次 §6 的迁移、部署。这是把今天所有配置从「读得懂」变成「跑得起来」的临门一脚——但需要真实云账号和（Fly）信用卡，不在本仓库能完成的范围内。

---

## 改动清单（接进 solutions/blog）

| 文件 | 改了什么 |
|---|---|
| `blog-api/fly.toml` | **新增**：Fly 部署配置。`[build]` 指同目录 Dockerfile；`[http_service]` internal_port=3000 + `force_https` + `auto_stop_machines=false`/`min_machines_running=1`（保 BullMQ worker）；`[[http_service.checks]]` 打 `/health/ready`（就绪闸门）；`[[vm]]` 起步机型；注释掉的 `[[mounts]]`（建议用 S3 而非本地卷） |
| `blog-api/railway.json` | **新增**：Railway 部署配置。`healthcheckPath: /health` + `restartPolicy`（ON_FAILURE/3 次，兜 DB 冷启动）+ `sleepApplication: false`（保 worker）；**不设** `startCommand`——让 Dockerfile 的 tini+CMD 原样跑 |
| `blog-api/.env.production.example` | **新增**：生产环境变量清单。托管 PG（直连，附 PgBouncer + directUrl 进阶注释）、Upstash `rediss://`、强随机 JWT secret、`STORAGE_BACKEND=s3`（R2）、真实域名的 CORS/OAuth 回调 |
| `blog-api/Dockerfile`（Day 41 的） | **修了两个潜伏 bug**（§13 实跑抓出的）：① runner 段 `COPY package.json pnpm-lock.yaml` 挪到 `pnpm install` 前（否则 corepack 拉到 pnpm 11.x 崩）；② Prisma 生成物的 `COPY --from=deps` 源/目标改成 pnpm 虚拟存储路径 `.pnpm/@prisma+client@5.22.0.../node_modules/.prisma`（顶层 `.prisma` 不存在）。两处都加了 why 注释 |

> Day 42 `docker-compose.yml`、所有 `src/` 业务代码今天没动。Day 41 的 `Dockerfile` 改了两行——但那是修它**一直存在的 bug**（此前没真构建过、没暴露），不是改部署形态。这也再次兑现 Day 41 的设计：**同一个镜像，本地 compose、Fly、Railway 三处都能跑，只换外面的配置**——只是这个镜像头一次真的能构建出来了。

---

## ✅ 一份诚实清单

✅ **今天到位的：**
- 平台选型讲死：这套常驻进程镜像**为什么不上 Vercel**（BullMQ worker + 本地存储 vs serverless 函数），给了「有没有请求外常驻逻辑」的判断标准
- 两套真实可用的部署形态：Fly（`fly.toml`：机型/区域/健康检查/卷）+ Railway（`railway.json`：healthcheck/restart/睡眠），都指向同一个 Day 41 镜像
- 托管 PG（Supabase/Neon）的 PgBouncer + Prisma `directUrl` 坑讲透，且给出「先用直连绕开」的务实选择
- 托管 Redis（Upstash `rediss://` TLS）和本地 localhost 的差别讲清；Redis 降级 vs DB 必填的不对称点明
- 迁移在生产谁跑想死：Day 41 prod 镜像**不带 prisma CLI / 不带迁移目录**，所以迁移必须从 CI 或一次性容器跑（不能靠平台 preDeploy）
- 启动 fail-fast 实测验证：`PrismaService.onModuleInit` 握手 DB，连不上启动即崩（P1001），restartPolicy 兜底
- `/health`（liveness）与 `/health/ready`（readiness）映射到平台探针的不同用途讲清
- 本地 `/app/uploads` 不持久 → 生产 S3/R2（呼应 Day 39）；自动停机会饿死 worker → 关 scale-to-zero
- 生产环境变量清单（`.env.production.example`）逐项 + 必填/降级分清 + CORS/OAuth 回调同步改
- 域名 + HTTPS：平台默认子域 + 自动 Let's Encrypt、自定义域、TLS 在平台终止（应用只听 http）

⚠️/❌ **还没做、留给后面的：**
- **真上线一次**：本机跑不了云，端到端验证留待你有真实云账号（+ Fly 需信用卡）后做（§13 练习）。当前用语法校验 + fail-fast 实测 + 静态审查四层兜底
- **CI 迁移 job**：§6 推荐的「deploy 前从 CI 跑 `migrate deploy`」只在 README 给了姿势，没写进 Day 43 的 `docker-publish.yml`（要连真生产库 + 配 secret，不在学习仓库能落地）
- **连接池（PgBouncer + directUrl）**：当前默认直连，扛并发连接数的池化方案留到真有压力时
- **多区域 / 多实例**：Fly/Railway 都先按单实例配。跨区域部署、多副本 + 共享存储（S3 已就绪，但 BullMQ 多 worker 并发要去重）、蓝绿 / canary 都没做
- **Day 45 的可观测**：今天只有平台级健康检查和重启。结构化日志（Pino）、错误上报（Sentry）、指标/告警——是明天的主题
- **真正的零停机滚动更新**：单实例下「部署」=短暂中断。多实例 + readiness 闸门逐个替换才零停机，留到上编排器（k8s）那天
- **secret 轮换 / 证书可见性**：JWT secret 怎么轮换不踢掉所有用户、平台证书过期监控，都没覆盖

---

## 💻 实践练习

> 真上线需要云账号（Fly 还要信用卡）；下面的「读配置 / 本地验证」现在就能做，「真部署」是你自己的临门一脚。

1. **读两份部署配置，对照讲清每一行为什么**（现在可做）：
   ```bash
   cat solutions/blog/blog-api/fly.toml
   cat solutions/blog/blog-api/railway.json
   ```
   - `fly.toml`：`auto_stop_machines` 为什么是 `false`？`internal_port=3000` 和应用的 `PORT` 是什么关系？健康检查为什么打 `/health/ready` 而不是 `/health`？
   - `railway.json`：为什么**没有** `startCommand`？（提示：Dockerfile 已经声明了 `ENTRYPOINT [tini]` + `CMD [node dist/main]`，设了反而可能盖掉 tini。）`restartPolicy` 兜的是什么场景？

2. **校验配置文件语法**（现在可做）：
   ```bash
   jq . solutions/blog/blog-api/railway.json >/dev/null && echo "railway.json OK"
   python3 -c "import tomllib;tomllib.load(open('solutions/blog/blog-api/fly.toml','rb'));print('fly.toml OK')"
   ```

3. **亲眼看 fail-fast**（现在可做，本机 PG 不通时最明显）：
   ```bash
   cd solutions/blog/blog-api && pnpm build   # 确保 dist 在
   NODE_ENV=production PORT=3099 \
     JWT_ACCESS_SECRET='prod-deploy-verify-secret-thirty-two-chars-or-more' \
     DATABASE_URL='postgresql://blog:blog_dev_pwd@localhost:5435/blog?schema=blog_api' \
     REDIS_URL='redis://localhost:6379' \
     node dist/main
   # 期望：应用启动、模块初始化一路绿灯，到 PrismaService.onModuleInit 崩成 P1001
   # 这就是 §7 的论断——DB 没就绪，应用启动即崩，而非软成 503。
   ```
   （PG 通的话，`curl localhost:3099/health` → 200；`curl localhost:3099/health/ready` → 200。断了 DB/Redis 再看 `/health/ready` → 503。）

4. **核对生产环境变量清单**（现在可做）：
   ```bash
   cat solutions/blog/blog-api/.env.production.example
   ```
   逐项和 `config.validation.ts` 的 schema 对一遍：哪些是必填（缺了启动崩）、哪些有默认（不填也起）、哪些是降级层（连不通只降级不崩）。确认 `NODE_ENV=production` + 示例 JWT secret 会被 `superRefine` 拒绝。

5. **真上线一次**（需云账号，临门一脚）：
   - Supabase / Neon 建库，拿**直连**串；Upstash 建 Redis，拿 `rediss://` 串
   - 按 `.env.production.example` 在平台填齐变量（`JWT_ACCESS_SECRET` 用 `openssl rand -base64 32`）
   - **先迁移**：本地（或 CI）`DATABASE_URL='<生产直连串>' pnpm exec prisma migrate deploy`
   - `fly launch`（在 `blog-api/` 目录）或 Railway 连仓库；填同样变量；部署
   - `curl https://你的子域/health` → 200；`curl https://你的子域/health/ready` → 200；带 Swagger 的 `https://你的子域/docs` 能开

6. **思考题**：
   - 为什么 `fly.toml` 里 `auto_stop_machines = false`，对一个「只是 CRUD 的纯 API」却可以开成 `true`？（提示：看你的进程里有没有 §2 说的「请求之外还要持续运行的东西」。纯无状态 CRUD 没有常驻 worker，scale-to-zero 是纯赚；有 BullMQ worker 就不行。）
   - 把迁移写进 Railway 的 `preDeployCommand`，按 Day 41 当前镜像会失败——**为什么**？要让它成立，最小改动是什么？（提示：runner 段没 prisma CLI、没 `COPY prisma` 迁移目录。要么把 prisma 弄进 prod 镜像+拷迁移，要么别在镜像里 migrate、改从 CI 跑。后者更符合 Day 41 的最小化哲学。）
   - 生产里把 `STORAGE_BACKEND` 留成 `local`、Fly 也只跑单实例——图能存住吗？再扩到 2 个实例呢？（提示：单实例 + 持久卷能存；2 实例各一份本地盘，A 传 B 读不到。正解是 S3，跨实例共享。）
   - 我们把 Fly 的流量健康检查指到 `/health/ready`（查 DB+Redis）。如果 Upstash 那一刻抖了一下返回 503，Fly 会做什么？这**好不好**？（提示：Fly 认为这台不健康、不导流量给它；重则重启。好处是不把流量导给「连不上缓存」的实例；坏处是缓存一抖就重启实例，可能过度反应。改成 `/health` 会更宽容但语义变弱——这是个真实的权衡，没有标准答案。）

---

## ✅ 今日产出

- [ ] 读懂 `fly.toml` + `railway.json`，能讲清每一行为什么（尤其 `auto_stop_machines=false`、不设 `startCommand`、健康检查路径选择）
- [ ] 两份配置通过语法校验（jq + tomllib）
- [ ] 亲眼看 fail-fast：PG 不通时 `node dist/main` 在 `PrismaService.onModuleInit` 崩成 P1001，印证「DB 必须在应用启动前就绪」
- [ ] 核对 `.env.production.example` 每一项在 `config.validation.ts` 都有对应 schema，分清必填 / 默认 / 降级
- [ ] 在笔记里写下：这套镜像为什么不上 Vercel、托管 PG 的 PgBouncer 坑、迁移在生产谁跑、本地存储为什么不持久、TLS 在哪终止
- [ ] （有云账号的话）真上线一次：建托管 DB/Redis → 迁移 → 部署 → `curl https://子域/health/ready` 见 200
- [ ] 提交代码到 GitHub

---

[⬅️ Day 43](../day-43/) | [➡️ Day 45](../day-45/)
