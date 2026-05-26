# blog-prisma — Day 25 / 26 参考实现

Prisma 独立 playground，连接 `../blog-db` 起的同一个 PG 实例。Day 27 才会把 Prisma 集成到 NestJS 的 blog-api 里，今天先在最小环境里把 API 用顺。

## 前置

`blog-db` 必须先跑起来：

```bash
cd ../blog-db
docker compose up -d
./scripts/migrate.sh
./scripts/seed.sh
```

## 快速开始

```bash
cp .env.example .env          # 默认连 5432，按需调整
pnpm install
pnpm prisma generate          # 从 schema.prisma 生成 Client
```

## 跑 demo

每个文件都可以独立运行：

```bash
pnpm demo:basics      # 01_basics.ts   findUnique / findMany / create / update / delete
pnpm demo:relations   # 02_relations.ts include vs select / connect / connectOrCreate
pnpm demo:aggregates  # 03_aggregates.ts count / _count / groupBy / having
pnpm demo:raw         # 04_raw.ts      $queryRaw / $executeRaw / 类型化
pnpm demo:real        # 05_real_queries.ts 真实业务查询 + Prisma 边界

pnpm demo:all         # 全跑一遍
```

或者打开 Prisma Studio 浏览数据：

```bash
pnpm prisma:studio    # 默认 http://localhost:5555
```

## 目录结构

```
blog-prisma/
├── package.json
├── tsconfig.json
├── .env.example
├── prisma/
│   └── schema.prisma         # 手写映射 blog-db 的 7 张表
└── src/
    ├── 01_basics.ts
    ├── 02_relations.ts
    ├── 03_aggregates.ts
    ├── 04_raw.ts
    └── 05_real_queries.ts
```

## 设计取舍

- **手写 schema.prisma 不用 `db pull`**：注释更清楚，能解释每个 `@db.X`、关联端为什么这么写。生产接手老项目时还是建议先 `db pull` 一次。
- **复用 blog-db 的 PG 实例**：避免数据/schema 多套漂移。Day 27 集成进 blog-api 也是同一个实例。
- **Prisma 不接管 migration**：blog-db 的 SQL migrations 是 schema 的唯一真实来源。Prisma 只是查询客户端，不跑 `migrate dev`。
- **demo 不做幂等清理**：每个 demo 跑完后数据库状态可能变。需要重置数据：`cd ../blog-db && ./scripts/seed.sh`。

## 常见问题

**`Error: P1001 Can't reach database server`**
确认 `blog-db` 容器在跑，且端口和 `.env` 里的 `DATABASE_URL` 匹配。

**`Cannot find module '@prisma/client'` 或类型全 any**
忘了 `pnpm prisma generate`。这一步会生成 `node_modules/.prisma/client/`，import 才有内容。

**`BigInt cannot be serialized to JSON`**
`$queryRaw` 返回的 count 类型是 `bigint`。处理：`Number(value)` 或在序列化时手动转。详见 `src/04_raw.ts`。

**改了 schema.prisma 之后 Client 没更新**
跑 `pnpm prisma generate`。tsx 不会自动重生成。
