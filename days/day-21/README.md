# Day 21 — 关系型数据库基础与 PostgreSQL

## 📋 今日目标

- 用 Docker 起一套带持久化卷的 PostgreSQL，理解为什么不直接装本机
- 把 SQL 的"声明式"思维补齐，从 ORM 倒回去看底层在做什么
- 写完 `CREATE TABLE / INSERT / SELECT / UPDATE / DELETE` 五件套，知道每个数据类型背后的取舍
- 把 Day 20 的 `Post` 实体落到真实的 schema 里，为 Day 25 接 Prisma 留下干净的底
- 用事务跑完一次"创建文章 + 关联标签"的写操作，亲手见到 ACID 不是 PPT 概念

---

## 📖 核心知识点

### 1. 为什么是 PostgreSQL，而不是 MySQL / MongoDB

选型不是品味问题，是约束问题。三个候选放一起对比：

| 维度 | PostgreSQL | MySQL | MongoDB |
|------|------------|-------|---------|
| 数据模型 | 关系 + JSONB + 数组 + 自定义类型 | 关系 + JSON（弱） | 文档 |
| 约束 / 外键 | 完整支持 | 部分引擎支持 | 应用层自己保证 |
| 事务 | 完整 ACID，含 DDL | 完整 ACID（InnoDB） | 4.0 之后支持多文档事务，但代价高 |
| 复杂查询 | 窗口函数、CTE、全文检索齐全 | 5.7+ 才慢慢补齐 | 聚合管道，语法独立 |
| 扩展性 | 插件生态（PostGIS / pgvector / TimescaleDB） | 插件较少 | 原生分片 |
| 默认隔离级别 | Read Committed | Repeatable Read | 文档级原子 |

博客这种**结构稳定、强一致、查询会越来越复杂**的场景，PostgreSQL 是更优解。文章和标签是多对多、文章和用户是一对多——这种关系用文档存会把"一致性"成本推给应用层，做久了就是补不完的坑。

MongoDB 不是不能用，但选它意味着放弃外键、放弃 JOIN、放弃数据库帮你兜底——除非你确定数据形态会频繁变化，否则不要为了"灵活"提前付这个税。

### 2. Docker 起 PostgreSQL：不要污染本机

本机 `brew install postgresql` 看起来简单，半年后会变成：本机一个版本、项目 A 一个版本、项目 B 又一个版本，端口冲突、初始化数据混在一起。

直接用 Docker：

```bash
docker run -d \
  --name pg-blog \
  -e POSTGRES_USER=blog \
  -e POSTGRES_PASSWORD=blog_dev_pwd \
  -e POSTGRES_DB=blog \
  -e TZ=Asia/Shanghai \
  -e PGTZ=Asia/Shanghai \
  -p 5432:5432 \
  -v pg-blog-data:/var/lib/postgresql/data \
  postgres:16-alpine
```

每一行的意思都值得记住：

- `-v pg-blog-data:/var/lib/postgresql/data`：**用命名卷而不是 bind mount**。bind mount 在 macOS 上跨文件系统翻译会拖慢 IO 一个量级；命名卷由 Docker 管理，`docker volume rm` 才会删，远比"手滑 `rm -rf`"安全。
- `-e TZ=...` + `-e PGTZ=...`：时区**容器层和数据库层都要设**，否则 `now()` 和系统时钟会差 8 小时，写日志时排查到怀疑人生。
- `postgres:16-alpine`：固定主版本。`postgres:latest` 会在某个早晨悄悄升到 17，schema 不兼容你才发现。
- 密码用 `*_dev_pwd` 这种明显的本地名字，提醒自己**这是开发用，不能复用到任何线上**。

更工程化的写法是 `docker-compose.yml`：

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: pg-blog
    environment:
      POSTGRES_USER: blog
      POSTGRES_PASSWORD: blog_dev_pwd
      POSTGRES_DB: blog
      TZ: Asia/Shanghai
      PGTZ: Asia/Shanghai
    ports:
      - "5432:5432"
    volumes:
      - pg-blog-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U blog -d blog"]
      interval: 5s
      retries: 5
volumes:
  pg-blog-data:
```

`healthcheck` 不是装饰品。Day 22 之后接 Nest 应用时，应用容器要 `depends_on: condition: service_healthy`，否则 PG 还没起来应用就开始连，第一次启动总是失败。

### 3. 连接方式：psql、GUI、连接串

三种连法各有适用场景：

- **psql**（命令行）：调试、跑 migration、写脚本时首选。`docker exec -it pg-blog psql -U blog -d blog`，进去之后 `\l`（列库）、`\dt`（列表）、`\d posts`（看表结构）、`\q` 退出。**这几个命令必须背下来**，比任何 GUI 都快。
- **GUI**（DBeaver / TablePlus / pgAdmin）：第一次理解 schema 时画面更直观，但**不要养成用 GUI 改表结构的习惯**——改完没有迁移文件，下一台机器复现不了。
- **连接串**（应用代码里）：`postgresql://blog:blog_dev_pwd@localhost:5432/blog?schema=public`。Day 25 给 Prisma 用的就是这个格式。**密码里有特殊字符要 URL 编码**，`@` 写成 `%40`，否则解析会把它当成 host 分隔符。

### 4. SQL 是声明式的：换一种思维写代码

应用代码是"做什么":`for (const p of posts) { if (p.status === 'published') ... }`。SQL 是"想要什么":`SELECT * FROM posts WHERE status = 'published'`。**怎么做交给查询优化器**。

这个差异的实际意义是：

- 不要在客户端做数据库能做的事。`SELECT *` 拉回十万行再 JS filter，是把数据库变成了"文件存储"。
- 不要把 SQL 当模板字符串拼。`WHERE name = '${userInput}'` 是教科书级注入漏洞，永远用参数化查询（`$1, $2`）。
- 写 SQL 时**先想清楚"我要的是什么"**，再去想索引、JOIN 顺序。优化是 Day 23 的事，今天先把表达写对。

### 5. CREATE TABLE：每个字段都是一次设计决策

下面是博客 `posts` 表的"够用"版本，先看代码再逐条拆：

```sql
CREATE TABLE posts (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        VARCHAR(120) NOT NULL UNIQUE,
  title       VARCHAR(200) NOT NULL,
  content     TEXT         NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'archived')),
  view_count  INTEGER      NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

逐字段拆：

- **`id UUID DEFAULT gen_random_uuid()`**：和 Day 20 的 Repository 抽象对齐。UUID 让你能在客户端先生成 ID，能跨库合并数据；自增 BIGINT 在单机性能好但分布式时痛苦。`gen_random_uuid()` 是 PG 13+ 内置的，老版本要 `CREATE EXTENSION pgcrypto`。
- **`slug VARCHAR(120) UNIQUE`**：`VARCHAR(n)` 的 `n` 在 PG 里**不是性能优化**，只是约束。和 MySQL 不一样，PG 里 `VARCHAR(120)` 和 `TEXT` 存储方式完全相同。写 `(120)` 的唯一意义是"我承诺业务上不会超过 120 字符"。能用 `TEXT + CHECK (length(...) <= 120)` 更显式，但行业惯例还是写 `VARCHAR(n)`。
- **`content TEXT`**：长文本就是 `TEXT`。不要看到 `VARCHAR(65535)` 这种 MySQL 习惯就照搬。
- **`status` 用 `VARCHAR + CHECK` 而不是 `ENUM`**：PG 是有 `CREATE TYPE ... AS ENUM` 的，但**枚举值变更需要 `ALTER TYPE`，且不能简单删值**。业务枚举经常会增删，长期看 `VARCHAR + CHECK` 更灵活，迁移代价也低。
- **`view_count INTEGER CHECK (>=0)`**：约束写进数据库，**不要只指望应用层校验**。哪天有个脚本绕过 Service 直接更新，CHECK 是最后一道防线。
- **`metadata JSONB`**：放那些"可能会加但还没定下结构"的字段（封面图、SEO 描述、自定义扩展）。**用 `JSONB` 不要用 `JSON`**——JSONB 是二进制存储，可索引、可用 `->`/`->>`/`@>` 操作符高效查询；JSON 只是带格式校验的文本。
- **`TIMESTAMPTZ` 而不是 `TIMESTAMP`**：带时区。PG 内部统一存 UTC，读出时根据会话时区转换。**写 `TIMESTAMP` 是新人最常踩的坑**——存进去是本地时间，跨时区部署立刻乱套。
- **`DEFAULT now()`**：让数据库管时间戳，不要让应用传。多个服务时钟可能漂移，数据库是唯一的真相源。

`updated_at` 这一列**不会自己更新**，需要触发器：

```sql
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
BEFORE UPDATE ON posts
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
```

Prisma 时代可以用 `@updatedAt` 让 ORM 来填，但**触发器版本是兜底**：任何绕过 ORM 的写入都会被覆盖到。

### 6. 约束：把业务规则写进 schema

约束不是"严格模式"的洁癖，是把**不变量下沉**——下沉一层，上层代码就少一份焦虑。

- `NOT NULL`：默认就写上。NULL 是数据库里最贵的语义，能不允许就别允许。
- `UNIQUE`：和 `PRIMARY KEY` 不同，可以多个、可以允许 NULL（且每个 NULL 都"不同")。`slug UNIQUE` 防止重复发布同名文章。
- `CHECK`：表达布尔表达式，例子里的 `status IN (...)` 和 `view_count >= 0` 都是。**复杂规则不要塞进 CHECK**，可读性会爆炸；中等规则正合适。
- `FOREIGN KEY`：明天要正式用，今天先理解它做两件事——**插入时验证父行存在，删除父行时按策略处理子行**（`CASCADE` / `SET NULL` / `RESTRICT`）。**默认是 `NO ACTION`，等同于 RESTRICT**：父行有子引用就不让删。这恰恰是博客大部分场景想要的——不要顺手写 `CASCADE`。
- `DEFAULT`：让数据库填，应用层就不用每次记着传。`created_at DEFAULT now()` 是经典。

一条经验：**约束应该写在最早能发现违规的层**。能在数据库层兜底的，就不要把保证交给应用——应用代码会被新人改坏，数据库 schema 不会。

### 7. 主键策略：UUID 还是自增

四种主流方案：

| 方案 | 优点 | 缺点 |
|------|------|------|
| `SERIAL` / `BIGSERIAL` | 简单、紧凑、索引性能好 | 暴露顺序（爬虫扫 ID）、跨库迁移痛苦 |
| `UUID v4`（随机） | 全局唯一、客户端可生成、不泄露顺序 | 索引随机插入，B+ 树分裂多，写入有成本 |
| `UUID v7`（时间有序） | UUID 优点 + B+ 树友好 | 生态支持还在补齐，PG 17 才内置 |
| `Snowflake` / `KSUID` | 有序 + 全局唯一 + 紧凑 | 需要应用层生成，多一个依赖 |

**博客这种规模，UUID v4 完全够用**。索引写入慢一点点（每次插入要去 B+ 树一个随机位置），但量级到不了瓶颈。Day 23 学完索引你会更理解这个权衡。

业务层和 Day 20 的 `randomUUID()` 对齐：应用生成 ID 再传给 DB，也可以 DB 生成（`DEFAULT gen_random_uuid()`）。**只选一种**，混用会让你在排查 bug 时怀疑人生——为什么有些行的 ID 是应用生成的，有些是 DB 生成的？

### 8. INSERT / SELECT / UPDATE / DELETE：实战要点

```sql
-- INSERT：永远配 RETURNING
INSERT INTO posts (slug, title, content)
VALUES ('hello-pg', '你好 PostgreSQL', '正文...')
RETURNING id, created_at;
```

`RETURNING` 是 PG 的杀器（MySQL 没有）。一次往返就拿到数据库生成的 `id` 和 `created_at`，应用代码不用再 `SELECT` 一次。

```sql
-- SELECT：永远显式列
SELECT id, slug, title, status, created_at
FROM posts
WHERE status = 'published'
ORDER BY created_at DESC
LIMIT 20 OFFSET 0;
```

**不要写 `SELECT *`**。两个原因：

1. 表加列时网络和内存白白增加（`content` 这种 TEXT 列尤其贵）。
2. 列顺序变了应用代码的"按位置取"会错位（ORM 没这个问题，但手写 SQL 有）。

```sql
-- UPDATE：永远带 WHERE，且永远 RETURNING
UPDATE posts
SET status = 'published', updated_at = now()
WHERE id = $1 AND status = 'draft'
RETURNING id, status;
```

注意 `AND status = 'draft'`——这是**乐观锁的雏形**：只有 draft 状态才允许发布，已发布的请求过来不会重复处理。`RETURNING` 拿到行说明改成功了，拿不到行说明状态不对，应用层据此决定是 404 还是 409。

`DELETE` 同理，**永远带 WHERE，永远 RETURNING**。没带 WHERE 的 `UPDATE/DELETE` 在生产环境是简历级事故。开发本机也最好**养成开事务的习惯**：

```sql
BEGIN;
DELETE FROM posts WHERE created_at < '2020-01-01' RETURNING id;
-- 看看删了多少，对不对劲
COMMIT;  -- 或 ROLLBACK;
```

### 9. WHERE 子句和 NULL 的陷阱

NULL 不是值，是"未知"。所以下面这条**永远返回空**：

```sql
SELECT * FROM posts WHERE deleted_at = NULL;  -- ❌ 永远是空
SELECT * FROM posts WHERE deleted_at IS NULL; -- ✅ 这才是判断
```

更隐蔽的是反向：

```sql
SELECT * FROM posts WHERE status != 'archived';
-- 如果 status 列允许 NULL，status IS NULL 的行不会被选中！
```

因为 `NULL != 'archived'` 的结果是 NULL，不是 TRUE。所以**字段尽量 NOT NULL**，少用 NULL 表达"未知"，宁可用 `''` 或者一个明确的枚举值。

`IN` 同理：`status IN ('a', NULL)` 不会匹配到 `status IS NULL` 的行。

### 10. 事务：ACID 不是抽象概念

博客里"创建文章 + 关联标签"是一次典型的多表写操作：

```sql
BEGIN;

INSERT INTO posts (id, slug, title, content)
VALUES ('11111111-1111-1111-1111-111111111111', 'tx-demo', '事务示例', '正文')
RETURNING id;

INSERT INTO post_tags (post_id, tag_id)
SELECT '11111111-1111-1111-1111-111111111111', id FROM tags WHERE name IN ('node', 'sql');

COMMIT;
```

如果第二条因为 `tags` 里没有这两条而插入了 0 行，但 `posts` 已经插了——上线后这就是"幽灵文章"。事务保证**要么全成功要么全失败**：

```sql
BEGIN;
INSERT INTO posts ...;
INSERT INTO post_tags ...;
-- 应用层判断标签数量是否符合预期，不对就 ROLLBACK
ROLLBACK;
```

ACID 四个字母里 Day 21 最该感受的是 **A（原子性）** 和 **D（持久性）**：

- **A**：上面这个例子，任何一条失败整个块回滚。
- **C**（一致性）：FK / CHECK / UNIQUE 全部在事务结束时验证，违反就回滚。
- **I**（隔离性）：明天细学，今天先记住 PG 默认是 `READ COMMITTED`——你读到的都是已提交的数据，但同一事务内两次读可能不一样（不可重复读）。
- **D**：`COMMIT` 返回后数据已经落盘，断电也不会丢。

实际项目中，**Service 方法是事务的天然边界**。Day 25 用 Prisma 时会看到 `prisma.$transaction([...])` 或 `prisma.$transaction(async tx => ...)` —— 现在打好 SQL 基础，到时一看就懂。

### 11. 博客系统的最小 schema

把今天的所有知识点汇总，给 Day 22 留好底：

```sql
-- 用户
CREATE TABLE users (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  email       VARCHAR(255) NOT NULL UNIQUE,
  username    VARCHAR(50)  NOT NULL UNIQUE,
  password    VARCHAR(255) NOT NULL,            -- 存 hash，永远不是明文
  role        VARCHAR(20)  NOT NULL DEFAULT 'user'
                CHECK (role IN ('user', 'author', 'admin')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 文章
CREATE TABLE posts (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id   UUID         NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slug        VARCHAR(120) NOT NULL UNIQUE,
  title       VARCHAR(200) NOT NULL,
  content     TEXT         NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'archived')),
  view_count  INTEGER      NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  metadata    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  published_at TIMESTAMPTZ,                     -- 允许 NULL：草稿还没发布
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 标签
CREATE TABLE tags (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(50)  NOT NULL UNIQUE,
  slug        VARCHAR(50)  NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 文章-标签关联（多对多）
CREATE TABLE post_tags (
  post_id     UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  tag_id      UUID NOT NULL REFERENCES tags(id)  ON DELETE CASCADE,
  PRIMARY KEY (post_id, tag_id)
);
```

几个关键决策：

- **`posts.author_id ... ON DELETE RESTRICT`**：用户被删时不允许，先要求迁移或软删文章。**不要随手 CASCADE 删用户连带删全部文章**，删错一个用户全公司数据消失的故事每年都在发生。
- **`post_tags` 用复合主键**：`(post_id, tag_id)` 自带 UNIQUE 又自带索引，比加一列 `id BIGSERIAL` 更干净。中间表一般都这么写。
- **`post_tags ... ON DELETE CASCADE`**：文章删除时关联记录自然清空。这里 CASCADE 是安全的，因为关联记录本身没有独立含义。**CASCADE 用在弱实体（依附存在的实体）上，不用在强实体上**。
- **`published_at` 单独一列**：和 `status = 'published'` 不冲突，是为了**未来支持定时发布**——`status = 'scheduled' AND published_at > now()`。schema 设计要为半年后的需求留一点点空间，但不要为三年后留。

### 12. 命名规范：一个项目坚持一套

PG 圈子约定俗成 `snake_case`：表名复数、字段全小写下划线。理由很现实——**PG 对不带引号的标识符自动转小写**：

```sql
CREATE TABLE Posts (Id UUID);
SELECT * FROM Posts;     -- 实际查的是 posts
SELECT * FROM "Posts";   -- 这才是大小写敏感的查询
```

混用 camelCase 唯一的做法就是到处加引号，写起来烦、出错率高。**统一 snake_case，ORM 那一层负责把 `created_at` 映射成 `createdAt`**。Prisma 默认就是这套约定。

其他几条惯例：

- 表名复数（`posts` 不是 `post`）：行（row）是单数，表是集合。
- 外键字段叫 `<其他表单数>_id`：`author_id` 而不是 `user_id`，让语义带上角色。
- 布尔列用 `is_` / `has_` 前缀：`is_published`、`has_cover`。
- 时间列统一 `_at` 后缀（时刻）或 `_on` 后缀（日期）。

### 13. Schema 文件管理：从一开始就用迁移

直接在 GUI 里点点点建表是**最大的坏习惯**。今天就把 schema 当代码：

```
day-21/solutions/blog-db/
├── docker-compose.yml
├── migrations/
│   ├── 001_init_users.sql
│   ├── 002_init_posts.sql
│   ├── 003_init_tags.sql
│   └── 004_init_post_tags.sql
└── seed.sql
```

跑 migration 的"穷人版"脚本：

```bash
for f in migrations/*.sql; do
  echo "applying $f"
  docker exec -i pg-blog psql -U blog -d blog < "$f"
done
```

Day 25 接 Prisma 后这套会被 Prisma Migrate 接管，但**今天手写 SQL 一遍**对理解迁移工具的价值至关重要——你才会知道 Prisma 帮你做了什么、什么时候不能完全信它（比如生产数据迁移）。

### 14. 通往 Day 22 的桥

今天搭起的 schema 明天会被反复 JOIN：

- "查每篇文章的作者名 + 标签列表" → 三表 JOIN + `array_agg`
- "查每个作者发了多少篇" → `GROUP BY` + `COUNT`
- "查从未被任何文章用过的标签" → `LEFT JOIN ... WHERE ... IS NULL`，或者 `NOT EXISTS`

为了明天顺利，**今天结束前一定要塞入足够的种子数据**：3 个用户、10 篇文章（混合状态）、5 个标签、合理的 post_tags 关联。空表上的 JOIN 看不出区别，有数据时 LEFT 和 INNER 才能展示差异。

---

## 💻 实践练习

### 主练习：搭起博客数据库

1. 在 `day-21/solutions/blog-db/` 下写 `docker-compose.yml`，包含 `healthcheck` 和命名卷
2. `docker compose up -d`，用 `docker exec -it pg-blog psql -U blog -d blog` 进 psql，验证 `\l` 看到 `blog` 库
3. 按第 11 节的 schema 拆成 `migrations/00X_*.sql`，每个文件只做一件事
4. 写一个 `seed.sql` 插入：3 个用户、5 个标签、10 篇文章（混合 draft/published/archived）、合理的 post_tags
5. 加 `updated_at` 触发器（第 5 节的 `trigger_set_updated_at`）
6. 写 `README.md`，给团队说明：怎么起、怎么进 psql、怎么跑 migration、怎么重置（`docker volume rm`）

### 加分练习：写一组 SQL 联系手感

不要打开 ORM，**纯 SQL** 完成：

1. 查所有已发布文章的 `id, slug, title, created_at`，按 `created_at` 倒序，取前 5
2. 用一条 `INSERT` 创建一篇带标签的文章（用事务，提交前 `ROLLBACK` 一次确认能回滚）
3. 把某篇文章从 `draft` 改成 `published`，并设置 `published_at = now()`，要求**只在状态是 draft 时生效**（参考第 8 节乐观锁写法），返回受影响的行
4. 查 `view_count > 100` 的文章数量
5. 软删一篇文章——给 `posts` 加 `deleted_at TIMESTAMPTZ`（允许 NULL），把"删除"改成 `UPDATE posts SET deleted_at = now()`；然后写一条查询确保**永远不返回已删除的文章**
6. 用 `EXPLAIN` 看一下 `WHERE slug = 'xxx'` 的查询计划（Day 23 会深入，今天先混个眼熟）

### 验收清单

```bash
# 容器与持久化
docker compose down && docker compose up -d   # 数据应该还在
docker exec -it pg-blog psql -U blog -d blog -c "SELECT count(*) FROM posts;"
# 数字和 seed 一致

# Schema 约束生效
docker exec -i pg-blog psql -U blog -d blog <<'SQL'
  INSERT INTO posts (author_id, slug, title, content, status)
  VALUES ('00000000-0000-0000-0000-000000000000', 'x', 't', 'c', 'unknown');
SQL
# 应报错：违反 CHECK 约束（status 非法）和 FK 约束（author 不存在）

# 触发器生效
docker exec -i pg-blog psql -U blog -d blog <<'SQL'
  UPDATE posts SET title = title || ' (edit)' WHERE slug = 'hello-pg';
  SELECT slug, updated_at FROM posts WHERE slug = 'hello-pg';
SQL
# updated_at 应该是当前时间，不是 created_at
```

---

## ⚠️ 常见误区

- **拿 MySQL 经验直接套**：`VARCHAR(n)` 在 PG 不是优化、`AUTO_INCREMENT` 写法不对、隔离级别默认值不同。把 PG 当作新东西去学，不要假设。
- **`TIMESTAMP` 不带时区**：跨时区部署立刻翻车。**所有时间列都用 `TIMESTAMPTZ`**。
- **`SELECT *` 一时爽**：表加列后老接口悄悄变大，前端解析出错才发现。
- **`UPDATE / DELETE` 不带 WHERE**：哪怕本地，养成开事务的习惯也能救你。
- **`ENUM` 用得太早**：业务初期枚举值经常增减，`VARCHAR + CHECK` 更灵活。
- **外键随手写 CASCADE**：在强实体（用户、文章）上 CASCADE 是定时炸弹，先用 RESTRICT 让数据库挡你一下。
- **本机直接装 PostgreSQL**：版本污染、卸载残留。**所有数据库都进 Docker**。
- **密码裸写进 docker-compose.yml 然后提交**：本地开发也要养成把敏感配置放 `.env` 的习惯，Day 20 已经讲过。
- **schema 改动只在 GUI 点**：明天就忘了改了什么，团队复现不了。**任何 schema 变更都进 migrations/**。

---

## ✅ 今日产出

- [ ] `docker-compose.yml` 启动 PostgreSQL 16，命名卷 + healthcheck + 时区
- [ ] `migrations/` 下分文件维护 users / posts / tags / post_tags 四张表
- [ ] 字段使用 `UUID / TIMESTAMPTZ / JSONB`，时间默认 `now()`
- [ ] 关键约束齐全：`NOT NULL / UNIQUE / CHECK / FK`，FK 删除策略有意识地选择
- [ ] `updated_at` 触发器生效
- [ ] `seed.sql` 注入足够练习的数据（3 用户 / 5 标签 / 10 文章）
- [ ] 至少完成主练习的 SQL 全套，验收清单全过
- [ ] 提交到 GitHub，commit message 写明 "day 21 postgres bootstrap"

---

## 📚 延伸阅读

- [PostgreSQL 官方文档 - Data Types](https://www.postgresql.org/docs/current/datatype.html)（字段类型权威参考）
- [PostgreSQL 官方文档 - Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL Tutorial](https://www.postgresqltutorial.com/)（适合入门快速过一遍语法）
- [Use The Index, Luke!](https://use-the-index-luke.com/)（Day 23 索引章节的前置读物）
- [PostgreSQL is the world's best database](https://www.tweag.io/blog/2024-01-04-postgresql-is-the-best/)（选型立场参考）
- [Don't Do This - PostgreSQL Wiki](https://wiki.postgresql.org/wiki/Don%27t_Do_This)（官方维护的反模式清单，强烈推荐）

---

[⬅️ Day 20](../day-20/) | [➡️ Day 22](../day-22/)
