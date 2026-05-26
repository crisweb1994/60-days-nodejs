# blog-db — Day 21 / 22 / 23 / 24 参考实现

Day 21 搭好的 schema 和测试数据，Day 22 追加 JOIN / 聚合 / 子查询，Day 23 追加索引、`EXPLAIN`、窗口函数，Day 24 把 schema 扩展到生产形态（评论树、点赞 + 反范式计数、通知）。Docker 起 PostgreSQL 16，按文件顺序应用 migration，灌入 seed，所有练习直接在 psql 里跑。

## 目录结构

```
blog-db/
├── docker-compose.yml          # PG 16-alpine + healthcheck + 命名卷
├── .env.example                # 复制为 .env 使用
├── migrations/                 # 按文件名顺序应用
│   ├── 001_init_extensions_and_trigger.sql
│   ├── 002_users.sql
│   ├── 003_posts.sql
│   ├── 004_tags.sql
│   ├── 005_post_tags.sql
│   ├── 006_indexes.sql                # Day 23：业务相关的索引集合
│   ├── 007_comments.sql               # Day 24：评论（邻接表 + 自引用）
│   ├── 008_likes.sql                  # Day 24：点赞 + 反范式 like_count + 触发器
│   └── 009_notifications.sql          # Day 24：通知（type + JSONB payload）
├── seed.sql                    # 3 用户 / 5 标签 / 10 文章 / 11 标签关联 + 评论树 + 点赞 + 通知
├── seed_large.sql              # Day 23 用：再补 47 用户 + ~10w 文章 + ~30w 标签关联
├── scripts/
│   ├── migrate.sh              # 跑 migrations
│   ├── seed.sh                 # 重灌 seed（--large 同时跑大数据集）
│   └── reset.sh                # 销毁卷重建（危险，本地用）
└── queries/                    # 练习 SQL
    ├── 01_basics.sql            # Day 21：SELECT / WHERE / 简单过滤
    ├── 02_write_with_tx.sql     # Day 21：INSERT/UPDATE/DELETE + 事务
    ├── 03_null_and_explain.sql  # Day 21：NULL 陷阱与 EXPLAIN 入门
    ├── 04_joins.sql             # Day 22：INNER/LEFT/反连接/自连接
    ├── 05_aggregates.sql        # Day 22：count/GROUP BY/HAVING/FILTER
    ├── 06_subqueries.sql        # Day 22：标量/相关/EXISTS/CTE
    ├── 07_explain.sql           # Day 23：EXPLAIN ANALYZE / BUFFERS / JOIN 算法
    ├── 08_indexes.sql           # Day 23：联合/部分/表达式/GIN 索引
    ├── 09_window.sql            # Day 23：窗口函数全家桶
    ├── 10_comments_tree.sql     # Day 24：递归 CTE 遍历评论树
    └── 11_likes.sql             # Day 24：点赞 + 计数列同步 + 对账
```

## 快速开始

```bash
cp .env.example .env            # 默认值就能用，按需改密码/端口
docker compose up -d            # 起容器，等 healthcheck 通过
./scripts/migrate.sh            # 应用所有 migrations
./scripts/seed.sh               # 灌入测试数据
```

进 psql 玩起来：

```bash
docker exec -it pg-blog psql -U blog -d blog
```

几个高频命令：

| 命令 | 作用 |
|------|------|
| `\l` | 列出所有数据库 |
| `\dt` | 列出当前库的表 |
| `\d posts` | 查看 posts 表结构（含约束、索引） |
| `\df` | 列出函数（看 `trigger_set_updated_at`） |
| `\timing on` | 打开查询计时，方便和 EXPLAIN 对照 |
| `\q` | 退出 |

## 跑练习

```bash
# 推荐：逐条执行体会语义
docker exec -it pg-blog psql -U blog -d blog -f /tmp/01_basics.sql
# 或者直接 cat 出来手工粘
```

更直观的方式是开 psql 后 `\i /path/to/queries/01_basics.sql` 一次性执行。

## 重置数据

只清空业务数据、保留 schema：

```bash
./scripts/seed.sh                # 小数据：3 用户 / 10 文章
./scripts/seed.sh --large        # 小数据 + 10w 文章，Day 23 的 EXPLAIN 才看得出区别
```

连容器和卷都炸掉、从零重建：

```bash
./scripts/reset.sh   # 会二次确认
```

## 设计要点速查

| 决策 | 选择 | 理由 |
|------|------|------|
| 主键 | UUID v4 + `gen_random_uuid()` | 跨服务可生成、不暴露顺序、Day 20 Repository 接口对齐 |
| 时间列 | 全部 `TIMESTAMPTZ` | 跨时区部署不翻车 |
| 枚举 | `VARCHAR + CHECK` | 比 `CREATE TYPE ENUM` 易演进 |
| `updated_at` | 触发器自动更新 | 兜底任何绕过 ORM 的写入 |
| `users → posts` FK | `ON DELETE RESTRICT` | 用户删除前必须先处理文章，避免一刀切 |
| `posts → post_tags` FK | `ON DELETE CASCADE` | 关联是弱实体，文章没了关联也没意义 |
| 软删除 | `posts.deleted_at TIMESTAMPTZ` | 历史可追溯，列表查询永远带 `IS NULL` |
| 多对多 | 复合主键 `(post_id, tag_id)` | 自带 UNIQUE 和索引，无需多余 id 列 |
| 扩展字段 | `JSONB` | 二进制存储 + 可索引，JSON 类型不要碰 |

## 常见问题

**`docker compose up -d` 后立刻跑 migrate 报连接拒绝？**
PG 启动需要几秒，`migrate.sh` 已带 `pg_isready` 轮询。如果你直接用 `psql` 连，等几秒或者看 `docker logs pg-blog` 里出现 `database system is ready to accept connections`。

**`gen_random_uuid()` 报函数不存在？**
PG 13 之前需要 `pgcrypto`；migration 001 已经 `CREATE EXTENSION IF NOT EXISTS pgcrypto`，正常应用就有。

**改了 migration 文件，怎么"重跑"？**
迁移文件应当是**追加式**的。已经应用过的文件不要改，错了就写 `006_fix_xxx.sql` 修。开发期可以 `./scripts/reset.sh` 直接重来，生产没这个奢侈。

**端口冲突？**
本机已经有 PG 占了 5432，编辑 `.env` 把 `POSTGRES_PORT` 改成 `5433` 即可，连接串里也对应改。

## 验收清单

跑完一遍下面这些命令，全部符合预期才算过关：

```bash
# 1. 表数量
docker exec -it pg-blog psql -U blog -d blog -c "\dt"
# Day 21 期望：4 张（users / posts / tags / post_tags）
# Day 24 后期望：7 张（追加 comments / likes / notifications）

# 2. seed 数据数量
docker exec -it pg-blog psql -U blog -d blog -c \
  "SELECT 'posts',count(*) FROM posts UNION ALL SELECT 'tags',count(*) FROM tags;"
# posts=10, tags=5

# 3. CHECK 约束生效
docker exec -i pg-blog psql -U blog -d blog <<'SQL'
  INSERT INTO posts (author_id, slug, title, content, status)
  VALUES ('22222222-2222-2222-2222-222222222222', 'bad', 't', 'c', 'wtf');
SQL
# 应报错：violates check constraint "posts_status_check"

# 4. 触发器生效
docker exec -i pg-blog psql -U blog -d blog <<'SQL'
  UPDATE posts SET title = title || ' (edit)' WHERE slug = 'hello-postgres';
  SELECT slug, (updated_at > created_at) AS updated_after_create
  FROM posts WHERE slug = 'hello-postgres';
SQL
# updated_after_create 应为 t

# 5. 持久化
docker compose down && docker compose up -d
sleep 5
docker exec -it pg-blog psql -U blog -d blog -c "SELECT count(*) FROM posts;"
# 仍是 10
```
