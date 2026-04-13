# SQL 速查手册

## 基础 CRUD

```sql
-- 创建表
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  age INTEGER CHECK (age > 0),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 插入
INSERT INTO users (name, email, age) VALUES ('张三', 'zhang@example.com', 28);

-- 查询
SELECT * FROM users WHERE age > 25 ORDER BY created_at DESC LIMIT 10 OFFSET 0;

-- 更新
UPDATE users SET name = '李四', age = 30 WHERE id = 1;

-- 删除
DELETE FROM users WHERE id = 1;
```

## JOIN

```sql
-- INNER JOIN（两表都匹配）
SELECT u.name, p.title
FROM users u
INNER JOIN posts p ON u.id = p.author_id;

-- LEFT JOIN（左表全部 + 右表匹配）
SELECT u.name, COUNT(p.id) AS post_count
FROM users u
LEFT JOIN posts p ON u.id = p.author_id
GROUP BY u.id, u.name;

-- 多表 JOIN
SELECT p.title, u.name AS author, c.content AS comment
FROM posts p
JOIN users u ON p.author_id = u.id
LEFT JOIN comments c ON p.id = c.post_id;
```

## 聚合

```sql
COUNT(*)       -- 行数
SUM(amount)    -- 求和
AVG(score)     -- 平均值
MAX(price)     -- 最大值
MIN(price)     -- 最小值

-- GROUP BY + HAVING
SELECT author_id, COUNT(*) AS post_count
FROM posts
GROUP BY author_id
HAVING COUNT(*) > 5;
```

## 子查询

```sql
-- WHERE 子查询
SELECT * FROM users
WHERE id IN (SELECT author_id FROM posts WHERE status = 'published');

-- FROM 子查询
SELECT avg_count FROM (
  SELECT author_id, COUNT(*) AS avg_count
  FROM posts GROUP BY author_id
) AS sub;

-- EXISTS
SELECT * FROM users u
WHERE EXISTS (SELECT 1 FROM posts p WHERE p.author_id = u.id);
```

## 窗口函数

```sql
-- ROW_NUMBER
SELECT *, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS row_num
FROM posts;

-- RANK（有并列）
SELECT *, RANK() OVER (ORDER BY score DESC) AS rank
FROM students;

-- 分区排名
SELECT *, ROW_NUMBER() OVER (
  PARTITION BY category_id ORDER BY created_at DESC
) AS rank_in_category
FROM posts;
```

## 索引

```sql
-- 创建索引
CREATE INDEX idx_posts_author ON posts(author_id);
CREATE INDEX idx_posts_status_created ON posts(status, created_at);
CREATE UNIQUE INDEX idx_users_email ON users(email);

-- 查看查询计划
EXPLAIN ANALYZE SELECT * FROM posts WHERE author_id = 1;
```

## 事务

```sql
BEGIN;
  UPDATE accounts SET balance = balance - 100 WHERE id = 1;
  UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;

-- 回滚
ROLLBACK;
```

## 常用 PostgreSQL 数据类型

```
SERIAL         自增整数
INTEGER        整数
BIGINT         大整数
NUMERIC(10,2)  精确小数
VARCHAR(255)   可变长字符串
TEXT           无限长文本
BOOLEAN        布尔值
TIMESTAMP      时间戳
JSONB          JSON 二进制存储
UUID           UUID
```
