# syntax=docker/dockerfile:1.7
# ===========================================================================
# blog-api 生产镜像 —— Day 41：把 NestJS 应用打包成一个可移植、可重现的产物
# ---------------------------------------------------------------------------
# 三阶段构建（deps → build → runner）。核心矛盾：构建时需要的东西（typescript、
# @nestjs/cli、prisma CLI、源码）和运行时需要的东西（@prisma/client、编译后的 dist）
# 不是一回事。单阶段会让最终镜像带着编译器和源码——又大、又是攻击面。多阶段每段从
# 一个干净的 FROM 起，最后只保留 runner 段，前两段只是「中间产物」。
#
# 基础镜像选 node:20-alpine，和 blog-db 的 postgres:16-alpine / redis:7-alpine 一致，
# 体积最小。代价见 runner 段：Prisma 在 alpine（musl）上有个经典坑要填。
# ===========================================================================


# ── ① deps：装【全量】依赖 + 在容器内生成 Prisma client ─────────────────────
#    这是最慢的一段（pnpm install 几十秒），所以指令顺序专门为「命中缓存」设计。
FROM node:20-alpine AS deps

# alpine + Prisma 的经典坑：query engine 是按 glibc + openssl 编译的 .node 二进制，
# 在 musl 上要么报 "could not load library" 要么直接段错误。
#   - libc6-compat 提供 glibc 兼容层（musl 缺的那部分符号）；
#   - openssl 是引擎运行时动态链接的（Prisma 5 需要 openssl 1.1 / 3.x 的运行时库）。
# build 和 runner 都要装——别想着只在 build 装，运行时照样要。
RUN apk add --no-cache openssl libc6-compat

# corepack 读 package.json 的 packageManager 字段决定 pnpm 版本——版本不写死在
# Dockerfile 里，单一真相源是 package.json（我们已在那加了 "pnpm@10.15.0"）。
RUN corepack enable

WORKDIR /app

# 关键顺序：先只 COPY 依赖描述 + prisma schema，再 install。这样改业务代码不会让
# pnpm install 重跑——它只依赖 package.json / lockfile / schema 是否变化。
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

# BuildKit 缓存挂载：pnpm 的全局 store 跨多次 build 复用，不重复下载已装过的包。
# 没有 BuildKit（老 Docker）这行被忽略，退化为正常 install，不影响正确性。
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# 必须在【容器内】generate：Prisma 会下载匹配当前内核的 query engine（linux-musl-*）。
# 要是在 mac 上 generate 再把 node_modules 拷进镜像，引擎是 darwin 的，进容器直接报错。
RUN pnpm exec prisma generate


# ── ② build：编译 TypeScript → dist ─────────────────────────────────────────
#    从 deps 继承（复用已装好的 node_modules），只补源码和构建配置。
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm build


# ── ③ runner：最小运行时镜像 ─────────────────────────────────────────────────
#    从全新的 node:20-alpine 起，只搬运行时必需的东西进来。最终镜像不含 typescript、
#    源码、devDeps——任何「只是构建时才需要」的东西都被挡在这段之外。
FROM node:20-alpine AS runner

RUN apk add --no-cache openssl libc6-compat tini

ENV NODE_ENV=production

WORKDIR /app

# 非 root：容器默认是 root。应用一旦被 RCE，攻击者直接拿到容器内的 root——和 Day 40
# 「假设前一层被绕过」一脉相承的部署侧防御。建一个无特权用户 app 来跑应用。
RUN addgroup -S app && adduser -S app -G app

# 只装【生产】依赖：--prod 跳过 devDeps（typescript / @nestjs/cli / prisma CLI），
# --ignore-scripts 跳过 postinstall（=prisma generate）——生产装时 prisma CLI 是
# devDep 没装，postinstall 会炸。生成的 client 是构建产物、不是 npm 包，下一行单独拷。
RUN corepack enable
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# 把 deps 段【在容器内生成】的 Prisma client 拷过来：含查询引擎 .node 二进制（linux-musl）。
# 注意只拷 .prisma 这一个生成物目录，而不是整份 node_modules——pnpm 用 .pnsm 虚拟存储
# + symlink，跨阶段 COPY 整个 node_modules 会把符号链接搞坏。让 runner 自己 install
# 重建结构，只把生成物单独补进来，是 pnpm + Docker 多阶段的正确姿势。
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# 编译产物：纯 JS，运行时不需要 typescript、也不需要 ts 源码。
COPY --from=build /app/dist ./dist
COPY package.json ./

# 本地存储后端写封面图的目录。mkdir 默认归 root，非 root 的 app 写不进去 → 上传必 500。
# 建好就 chown 给 app。S3 后端用不到，留个空目录也不碍事。
RUN mkdir -p uploads && chown -R app:app uploads

# 进程级健康检查：/health 不查 DB、已 @SkipThrottle（Day 35），天生适合被高频探针打。
# 3 次连续失败才判 unhealthy，给网络抖动留余量。HEALTHCHECK 不走 ENTRYPOINT，独立执行。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null http://localhost:${PORT:-3000}/health || exit 1

USER app
EXPOSE 3000

# tini 作 PID 1：Node 自己当 PID 1 有两个老毛病——不回收僵尸进程、信号转发不可靠。
# Docker stop 发 SIGTERM，main.ts 的 enableShutdownHooks 本来能优雅关闭（等在途请求、
# 关连接池、触发 onModuleDestroy），但得先让信号正确送达。tini 负责接信号、转发、
# 回收僵尸，Node 专注业务——于是「docker stop」= 优雅退出，而非 SIGKILL 一刀切。
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
