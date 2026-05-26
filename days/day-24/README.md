# Day 24 — 数据库建模实战

## 📋 今日目标

- 把范式（1NF/2NF/3NF/BCNF）背后的"消除什么样的依赖"想清楚，而不是死记定义
- 知道**什么时候该反范式**，以及反范式的代价该怎么兜底
- 学会三种"树形数据"的存储方案（邻接表 / 路径枚举 / 嵌套集合），按场景选
- 能从一句"我要做评论 + 点赞 + 通知"的产品需求，推导出完整可落地的 schema
- 用触发器维护"赞数"这类反范式计数列，保证它和真实数据不漂移
- 把 Day 21 搭好的博客 schema 扩展到生产可用的形态（加 comments / likes / notifications）

---

## 📖 核心知识点

### 1. 为什么要"建模"

很多人对建模的第一反应是"我要做 X，那就 `CREATE TABLE X`"。问题是这种顺序写出来的 schema 半年后必崩——加一个字段牵动 5 张表，业务想做"按时间排所有动态"发现拼不出来。

建模本质上是**回答"数据之间是什么关系"**：

- 谁是实体（Entity，独立存在的事物）
- 谁是属性（Attribute，依附于实体的特征）
- 谁是关系（Relationship，实体之间的连接）

"评论"是实体还是属性？是实体——评论有自己的 id、作者、时间，能被独立查询和修改。"评论的点赞数"是实体的属性还是另一个实体？取决于你要不要追溯"谁点的赞"——要就是实体，不要就是属性。

**建模的第一步永远是问需求，不是问技术**。先想清楚业务上"评论是否要支持楼中楼"，再决定怎么存。需求决定 schema，而不是反过来。

### 2. 实体-关系图：纸笔就够

ER 图的目的是让你和团队对齐"我们在讨论什么"，不是搞工艺品。一张纸 + 三种符号就够：

```
┌───────┐         1     N    ┌───────┐
│ User  │─────────────────── │ Post  │
└───────┘                    └───────┘
                                 │
                                 │ 1
                                 │
                                 │ N
                             ┌───────┐
                             │Comment│
                             └───────┘
```

- 矩形 = 实体
- 线 = 关系
- 线两端的 `1` / `N` = 基数（cardinality）

工具列表（任选其一就够，别花太多时间在选工具上）：

- [dbdiagram.io](https://dbdiagram.io/)——免费，用 DBML 写代码自动出图
- [drawio](https://app.diagrams.net/)——通用画图工具
- 文字版（如上）——团队 review 时最快

**关键不是图本身，是"我能在 5 分钟内向同事讲清楚这个 schema 在干嘛"**。能讲清楚就不用画图，讲不清楚画了也没用。

### 3. 关系类型：四种就够

实体之间的关系归纳就四种：

| 关系 | 例子 | 怎么建表 |
|------|------|---------|
| **1:1** | User ↔ UserProfile | 子表加 `user_id UNIQUE`，或合并成一张表 |
| **1:N** | User → Post | 多的一方加外键 `author_id` |
| **N:M** | Post ↔ Tag | 中间表 `post_tags(post_id, tag_id)` |
| **自引用** | Comment → Comment (回复) | 同一张表加 `parent_id` 指向自己 |

**1:1 关系常被滥用**。如果两张表永远 1:1，且总是一起查，合并成一张表更简单。拆开的理由通常只有：列分组的语义清晰（敏感字段隔离）、或某一列大且不常用（profile 里的长 bio）。

**N:M 关系的中间表**应该有自己的命名（`post_tags` 而不是 `posts_tags_mapping`），且通常用复合主键 `(post_id, tag_id)`——自带 UNIQUE 和索引，省一个 BIGSERIAL id 列。

### 4. 第一范式（1NF）：列不可再分

1NF 的要求：**每个字段都是原子值，不存"列表"或"对象"**。

```sql
-- ❌ 违反 1NF：tags 列存逗号分隔
CREATE TABLE posts (id INT, title TEXT, tags TEXT);
INSERT INTO posts VALUES (1, 'Hello', 'pg,nodejs,tutorial');

-- ✅ 1NF：tags 独立成表
CREATE TABLE post_tags (post_id INT, tag_id INT);
```

实际项目里 1NF 经常被"为了方便"破坏。最典型的就是逗号分隔的状态列、JSON 字符串当数组用。代价：

- 查"打过 pg 标签的文章"得写 `WHERE tags LIKE '%pg%'`，索引用不上
- 删一个标签要 string replace，并发改容易丢
- 报表无法 GROUP BY 标签

**例外**：PG 的 `JSONB` 和数组类型在某种意义上不违反 1NF——它们有专门的索引（GIN）和操作符。**但只在"几乎从来不按这个字段过滤/聚合"时才用**，详见 §13。

### 5. 第二范式（2NF）：消除部分依赖

前提是表有**复合主键**。2NF 要求：**非主键列必须依赖整个主键，不能只依赖其中一部分**。

举例：订单明细表

```sql
-- ❌ 违反 2NF：主键 (order_id, product_id)，但 product_name 只依赖 product_id
CREATE TABLE order_items (
  order_id    INT,
  product_id  INT,
  product_name TEXT,   -- ★ 只依赖 product_id 不依赖 order_id
  quantity    INT,
  PRIMARY KEY (order_id, product_id)
);

-- ✅ 拆出来
CREATE TABLE products (id INT PRIMARY KEY, name TEXT);
CREATE TABLE order_items (
  order_id   INT,
  product_id INT REFERENCES products(id),
  quantity   INT,
  PRIMARY KEY (order_id, product_id)
);
```

代价：product 改名字时不用更新所有 order_items。这就是范式的核心收益——**消除冗余、消除更新异常**。

注意：2NF **只在复合主键时才是问题**。单列主键的表天然满足 2NF。

### 6. 第三范式（3NF）：消除传递依赖

非主键列不能依赖**另一个非主键列**。

```sql
-- ❌ 违反 3NF：city → province，province 不直接依赖主键
CREATE TABLE users (
  id       INT PRIMARY KEY,
  name     TEXT,
  city     TEXT,
  province TEXT   -- ★ 依赖 city，不依赖 id
);

-- ✅ 拆
CREATE TABLE cities (
  id       INT PRIMARY KEY,
  name     TEXT,
  province TEXT
);
CREATE TABLE users (
  id      INT PRIMARY KEY,
  name    TEXT,
  city_id INT REFERENCES cities(id)
);
```

3NF 的核心还是**消除更新异常**——某个 city 改省份归属时，不用扫一遍所有 users。

**3NF 是大多数业务表的目标**。BCNF 更严格但日常很少需要，记得名字就行。

### 7. 反范式化：明确知道在交换什么

范式化的代价是：**查询要 JOIN**。`SELECT user_name, post_title, comment_content` 在严格 3NF 下要 JOIN 三张表。

反范式化就是为了减少 JOIN，主动引入冗余：

```sql
-- 经典反范式：posts 上冗余 author_name
CREATE TABLE posts (
  id          UUID PRIMARY KEY,
  author_id   UUID REFERENCES users(id),
  author_name TEXT,   -- ★ 冗余：本可以 JOIN users 拿到
  title       TEXT
);
```

**值不值得反范式，看三件事**：

1. **读写比**：读 1000 次写 1 次的字段值得冗余；写 1000 次读 1 次的不值得
2. **一致性容忍度**：author 改名后 posts 里的 author_name 立刻能改吗？能就 OK，不能就别冗余
3. **JOIN 成本**：JOIN 真的慢吗？大多数情况是少了索引而不是 JOIN 本身的锅

最常见的反范式场景是 **计数列**：`posts.like_count`、`users.followers_count`。每次现算 `count(*)` 一定慢，存一个值定时维护。代价是要解决"怎么保证它和真实数据一致"——见 §11。

**反范式不是"加列就完了"，是要主动承担同步成本**。同步靠触发器、靠应用层事务、靠定时任务对账——三选一，但必须有一个。

### 8. 主键策略：UUID / BIGSERIAL / 复合

| 选择 | 优点 | 缺点 |
|------|------|------|
| `BIGSERIAL` | 4 字节、有序、索引小 | 暴露业务量、跨服务无法预生成、分库分表难 |
| `UUID v4` | 全局唯一、客户端可生成、不暴露顺序 | 16 字节、随机插入导致 B-tree 页分裂 |
| `UUID v7`（PG 17+）| UUID 优点 + 按时间递增 + 索引友好 | 需要新版 PG |
| 复合主键 | 自带业务语义（如 `post_tags(post_id, tag_id)`) | 外键引用麻烦 |

博客这种现代系统默认用 UUID。性能担忧基本是过度优化——B-tree 页分裂的影响在百万行级别才看得到。

**禁忌**：用"邮箱"、"手机号"、"slug"这种**自然键**当主键。这些值会变，外键就崩。一律加一个代理主键（id），自然键单独 UNIQUE 约束。

### 9. 时间戳列：四个就够

成熟的博客 schema 上每张表的时间列基本是这四个：

```sql
created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 何时创建
updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 何时改过（触发器维护）
deleted_at   TIMESTAMPTZ,                          -- 软删除，NULL=未删
published_at TIMESTAMPTZ,                          -- 何时对外可见
```

几条铁律：

- **永远 `TIMESTAMPTZ` 不 `TIMESTAMP`**。前者带时区信息，跨时区部署不翻车
- **`created_at` 业务上永远不应该被改**。改了就违背语义
- **`updated_at` 用触发器维护**，别指望应用层每次记得
- **软删除和发布时间分开**：`deleted_at IS NOT NULL` 是物理可见性、`published_at IS NULL` 是业务可见性，不要复用

### 10. 树形数据：三种存储方案

评论场景的核心问题：**回复**。"评论 A 回复评论 B"形成一棵树，怎么存？

**方案一：邻接表（Adjacency List）**

```sql
CREATE TABLE comments (
  id        UUID PRIMARY KEY,
  post_id   UUID REFERENCES posts(id),
  parent_id UUID REFERENCES comments(id),  -- 指向父评论，NULL=顶层
  author_id UUID REFERENCES users(id),
  content   TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

- **优点**：写入简单（指一下父节点）；改父节点 = 改一行
- **缺点**：查"某文章全部评论树"要递归——用 PG 的 `WITH RECURSIVE` 解决
- **适用**：大多数场景。**默认选这个**。

**方案二：路径枚举（Path Enumeration / Materialized Path）**

```sql
CREATE TABLE comments (
  id    UUID PRIMARY KEY,
  path  TEXT,  -- 例如 '1/3/7' 表示祖先链
  ...
);
```

- **优点**：查"某节点所有后代"超快（`WHERE path LIKE '1/3/%'`）
- **缺点**：移动子树要更新所有后代的 path；path 长度有限制
- **适用**：树很深（比如分类树）、且很少改结构

**方案三：嵌套集合（Nested Set）**

每个节点存一个 `[lft, rgt]` 区间，包含关系 = 区间包含。

- **优点**：查后代/祖先都是简单的范围查询
- **缺点**：插入/删除一个节点要更新一大批行的 lft/rgt，写性能极差
- **适用**：几乎只读的树（部门组织架构、商品分类）

**对评论场景的结论**：**邻接表 + WITH RECURSIVE**。评论结构频繁变化（每条新回复都改结构）——嵌套集合的写代价不能接受；路径枚举的限制是评论嵌套 3 层以上就长得离谱。邻接表是工业界默认答案。

### 11. 点赞表：N:M + 计数列的标准范式

需求：
- 一个用户可以点赞多篇文章
- 一篇文章可以被多个用户点赞
- 同一对 (user, post) 只能点赞一次
- 文章详情页要显示"赞数"

最朴素的设计：

```sql
CREATE TABLE likes (
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE,
  post_id    UUID REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

-- 查赞数：
SELECT count(*) FROM likes WHERE post_id = ?;
```

10w 文章每篇 1000 赞，`count(*)` 每次都要扫一遍——首页 20 篇文章 = 20 次 count，加起来上百 ms。

**反范式**：在 `posts` 上加一个 `like_count`：

```sql
ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0;
```

读 0 代价。问题来了——**这个值怎么维护？**

三种方案：

1. **应用层维护**：业务代码 INSERT likes 之后 UPDATE posts。**容易漂移**——任何一个写入路径忘记更新就完蛋。
2. **数据库触发器**：每次 INSERT/DELETE likes 自动 +1/-1。**强一致**但有性能开销。
3. **定时任务对账**：异步统计后批量纠正。**容忍一段时间的不一致**，但绝对值正确。

**博客场景默认用触发器**。点赞写入频率不高（几十次/秒级别），触发器开销可接受，换来一致性是值得的。

```sql
CREATE OR REPLACE FUNCTION posts_like_count_sync() RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_likes_count
AFTER INSERT OR DELETE ON likes
FOR EACH ROW EXECUTE FUNCTION posts_like_count_sync();
```

注意：**`AFTER` 而不是 `BEFORE`**——确保 like 行真的写入后再改计数。另外要在生产上配合一个"定时对账"任务（一周一次）兜底，防止极端情况下漂移：

```sql
UPDATE posts p SET like_count = sub.cnt
FROM (SELECT post_id, count(*) AS cnt FROM likes GROUP BY post_id) sub
WHERE p.id = sub.post_id AND p.like_count != sub.cnt;
```

### 12. 通知表：异质事件的统一存储

"通知"是典型的异质事件——可能是"被点赞"、"被评论"、"被关注"，每种事件的附带数据都不一样。

错误设计：每种事件一张表（`like_notifications` / `comment_notifications` / ...）。问题：

- 查"用户的全部通知按时间排序"要 UNION 一堆表
- 加新事件类型要建新表
- 通用功能（标记已读、删除）要在每张表都写一遍

**正确设计**：一张表 + `type` 枚举 + `JSONB payload`：

```sql
CREATE TABLE notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type         VARCHAR(40) NOT NULL,    -- 'post_liked' / 'comment_replied' / ...
  payload      JSONB NOT NULL,          -- 类型特定的附加数据
  read_at      TIMESTAMPTZ,             -- NULL = 未读
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_recipient_unread
  ON notifications(recipient_id, created_at DESC)
  WHERE read_at IS NULL;
```

`payload` 例子：

```json
{ "type": "post_liked",  "post_id": "...", "post_title": "Hello", "liker_id": "...", "liker_name": "alice" }
{ "type": "comment_replied", "comment_id": "...", "parent_id": "...", "snippet": "..." }
```

`payload` 里**做轻度反范式**（liker_name、post_title），让通知列表页直接渲染不用 JOIN。代价是 user/post 改名时旧通知里还是旧名——业务上完全可接受。

### 13. JSONB 该用在哪、不该用在哪

PG 的 JSONB 很强，但也很容易被滥用。原则：

**该用**：
- 真正异质的扩展字段（如 `posts.metadata`）
- 短期演进的 schema（不想每加一个字段就建一张表）
- 上面的 `notifications.payload` 这种"异质事件"场景

**不该用**：
- **任何需要按值过滤/聚合的字段**——`SELECT ... WHERE metadata->>'tag' = 'x'` 即使有 GIN 索引也比正经列慢
- **任何有强类型约束的字段**——JSONB 里 `{"age": "25"}` 和 `{"age": 25}` 是不同的，错了 PG 也不报
- **任何关系字段**——把 `tag_ids: [1,2,3]` 塞进 JSONB 等于放弃外键完整性

判断标准：**这个字段是否需要被独立查询、约束、统计？需要就拆成列，不需要才塞 JSONB**。

### 14. Schema 演进：哪些列动得起、哪些动不起

线上数据库的 schema 变更是高危操作。永远要分清"安全的"和"危险的"：

| 操作 | 危险度 | 说明 |
|------|--------|------|
| `ADD COLUMN col TYPE NULL` | 🟢 低 | PG 11+ 不需要重写表 |
| `ADD COLUMN col TYPE DEFAULT 'x'` | 🟢 低 | PG 11+ 默认值是元数据级 |
| `DROP COLUMN` | 🟡 中 | 列只是标记删除，磁盘空间要 VACUUM FULL 才回收 |
| `RENAME COLUMN` | 🟡 中 | 元数据级，但所有用 col 的代码要同步改 |
| `ALTER TYPE` | 🔴 高 | 多数情况会重写整张表，大表会锁很久 |
| `ADD CONSTRAINT NOT NULL` | 🔴 高 | 默认要全表扫描验证；用 `NOT VALID` + `VALIDATE` 分两步 |
| `CREATE INDEX` | 🟡 中 | 必须用 `CONCURRENTLY`，否则锁表 |
| 改主键类型 | 🔴 高 | 牵动所有外键引用，几乎要停机 |

**永远的安全做法**：

1. 新列默认 NULL，应用层填好之后再加约束
2. 删列分两步：先停止写、后续 release 再 `DROP`
3. 任何索引操作加 `CONCURRENTLY`
4. 大表的复杂变更走"双写 + 在线迁移"

### 15. 实战：把博客 schema 扩展到生产形态

把 Day 21 的四张表（users / posts / tags / post_tags）扩展成现在的真实业务需求：

```
users ─┬─< posts ─┬─< post_tags >─ tags
       │          ├─< comments ─ (self-ref via parent_id)
       │          └─< likes (N:M with users)
       └─< notifications
```

新增三张表：

- `comments`：邻接表，支持楼中楼回复
- `likes`：N:M + 触发器同步 `posts.like_count`
- `notifications`：异质事件统一表，按 `recipient_id + created_at` 索引

具体 SQL 见 `solutions/blog/blog-db/migrations/007_comments.sql ~ 009_notifications.sql`。每个 migration 文件头都写了设计取舍。

### 16. 通往 Day 25 的桥

至此博客的 schema 完整了——用户、文章、标签、评论、点赞、通知。Day 25 开始用 **Prisma** 把这套 schema 映射成代码：

- Prisma Schema（SDL）怎么写、和 SQL DDL 是什么关系
- 关联在 Prisma 里怎么定义（`@relation`、`@@unique`、`@@index`）
- `prisma migrate dev` vs `prisma db push` 该用哪个
- 用 Prisma Client 写 CRUD，跟今天的"裸 SQL + node-pg"对比

后面几天 Prisma 链路会接上 NestJS（Day 27），那时博客 API（Day 14~20 的内存版）才真的变成"持久化的后端"。**今天先把建模做对，后面 ORM 才有意义**——见过太多人 ORM 用得飞起，schema 一塌糊涂。

---

## 💻 实践练习

### 主练习：把博客 schema 补完

在 `solutions/blog/blog-db` 上追加：

1. `migrations/007_comments.sql` — 评论表（邻接表，自引用 parent_id）
2. `migrations/008_likes.sql` — 点赞表 + 触发器同步计数
3. `migrations/009_notifications.sql` — 通知表 + 部分索引

跑完之后博客有 7 张表，schema 算完整。

### 加分练习：自己想清楚再看答案

不看 `solutions/`，自己先答一遍：

1. **comments 表的 `parent_id` 用什么 ON DELETE 行为？** RESTRICT / CASCADE / SET NULL 各自意味着什么业务效果？
2. **删除一篇 post 时，相关的 comments / likes / notifications 该怎么级联？**
3. **likes 表为什么不需要单独的 id 列？**
4. **如果业务要"取消通知后再次触发同种类型的事件可以重新出现"，notifications 表要不要去重？怎么去重？**
5. **comments 上要不要冗余 `post_id`？还是只通过 `parent_id` 递归找？**

每个问题答完再去看 migration 文件里的注释对比。**这才是建模的训练**——不是抄一份 schema，是练判断力。

### 验收清单

```bash
# 1. 应用新 migrations
./scripts/migrate.sh
# 应看到 007/008/009 三个文件被 apply

# 2. 表数量到 7
docker exec -it pg-blog psql -U blog -d blog -c "\dt"
# users / posts / tags / post_tags / comments / likes / notifications

# 3. 灌点评论 / 点赞 / 通知数据（seed 已扩展）
./scripts/seed.sh

# 4. 评论树查询（递归 CTE）
docker exec -i pg-blog psql -U blog -d blog -f /workspace/queries/10_comments_tree.sql

# 5. 点赞 + 计数列自动同步
docker exec -i pg-blog psql -U blog -d blog -f /workspace/queries/11_likes.sql
# 关键观察：INSERT/DELETE likes 之后 posts.like_count 自动跟着变
```

---

## ⚠️ 常见误区

- **把"列表"塞进一列**（逗号分隔、JSON 字符串当数组）：违反 1NF，查询和约束都瘸。要么拆表要么用 PG 数组/JSONB（且只在不过滤时）。
- **自然键当主键**：邮箱、手机号、slug 都会变，外键引用一变全崩。永远代理主键 + 自然键 UNIQUE。
- **`updated_at` 应用层维护**：迟早漏掉一个写入路径，靠触发器才稳。
- **反范式不维护**：加了 `like_count` 就甩手不管，半年后跟真实点赞数差三个数量级。永远配套触发器或定时对账。
- **触发器写 `BEFORE` 不是 `AFTER`**：BEFORE 阶段写入还没完成，rollback 后计数列对不上。
- **评论用嵌套集合（Nested Set）**：写性能极差，每个新回复要更新整棵子树。日常默认邻接表 + WITH RECURSIVE。
- **每种通知一张表**：查"用户最近通知"要 UNION，加事件类型要建新表。一律单表 + type + payload。
- **JSONB 当关系字段用**：`tag_ids: [1,2,3]` 塞 JSONB 等于放弃外键完整性。
- **生产上 `ALTER TABLE ADD CONSTRAINT NOT NULL` 不分步**：全表扫描，大表锁很久。用 `NOT VALID` + 后台 `VALIDATE`。
- **`CREATE INDEX` 不加 CONCURRENTLY**：写锁整张表。生产永远 CONCURRENTLY。

---

## ✅ 今日产出

- [ ] 能讲清 1NF/2NF/3NF 各消除什么样的依赖（不是死记定义）
- [ ] 能说出三种树形存储方案的取舍，并解释为什么评论默认用邻接表
- [ ] 能描述"反范式计数列"的三种维护方案及各自代价
- [ ] migrations 007/008/009 全部 apply 成功，`\dt` 看到 7 张表
- [ ] `queries/10_comments_tree.sql / 11_likes.sql` 全部跑通
- [ ] 演示一次：INSERT likes → posts.like_count +1；DELETE likes → posts.like_count -1
- [ ] 提交到 GitHub，commit message 写明 "day 24 modeling comments/likes/notifications"

---

## 📚 延伸阅读

- [Database Design for Mere Mortals](https://www.amazon.com/Database-Design-Mere-Mortals-Hands/dp/0136788041)（建模圣经，工业界标准教材）
- [Use The Index, Luke! — The Tree of Pain](https://use-the-index-luke.com/) 评论树相关章节
- [PostgreSQL 官方文档 — WITH Queries (Recursive CTE)](https://www.postgresql.org/docs/current/queries-with.html)
- [PostgreSQL 官方文档 — Triggers](https://www.postgresql.org/docs/current/triggers.html)
- [Joe Nelson — UUIDs vs Serial](https://www.2ndquadrant.com/en/blog/sequential-uuid-generators/)（主键选择的工程视角）
- [PostgreSQL Wiki — Don't Do This](https://wiki.postgresql.org/wiki/Don%27t_Do_This)（schema 设计反模式合集）
- [dbdiagram.io](https://dbdiagram.io/)（在线 ER 图工具，DBML 语法）

---

[⬅️ Day 23](../day-23/) | [➡️ Day 25](../day-25/)
