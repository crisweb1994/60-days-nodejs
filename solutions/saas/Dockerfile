FROM node:20-alpine AS base

ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PRISMA_ENGINES_MIRROR=https://binaries.prisma.sh

RUN apk add --no-cache libc6-compat openssl
RUN corepack enable

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1


FROM base AS deps

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

RUN --mount=type=cache,id=saas-pnpm,target=/root/.local/share/pnpm/store \
    pnpm config set registry "${NPM_REGISTRY}" \
    && PRISMA_ENGINES_MIRROR="${PRISMA_ENGINES_MIRROR}" pnpm install --frozen-lockfile


FROM deps AS builder

COPY . .

# Next 会在构建期加载服务端模块。这里的值只用于完成构建；容器启动时必须
# 通过环境变量注入真实连接串和密钥。NEXT_PUBLIC_* 会写入浏览器静态资源。
ARG NEXT_PUBLIC_APP_NAME="SaaS Task Platform"
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
    REDIS_URL="redis://127.0.0.1:6379" \
    SESSION_SECRET="build-only-session-secret-at-least-32-bytes" \
    NEXT_PUBLIC_APP_NAME="${NEXT_PUBLIC_APP_NAME}" \
    pnpm build


# 一次性迁移任务使用这个目标。它保留 Prisma CLI 和 migration 文件，但不对外提供服务。
FROM deps AS migration

ENV NODE_ENV=production

CMD ["pnpm", "prisma:deploy"]


FROM node:20-alpine AS runner

RUN apk add --no-cache libc6-compat openssl

WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs

# standalone 已包含 Next 服务实际追踪到的生产依赖；静态资源需单独复制。
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/.worker/mail-worker.cjs ./dist/mail-worker.cjs

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/trpc/health.ping" || exit 1

CMD ["node", "server.js"]
