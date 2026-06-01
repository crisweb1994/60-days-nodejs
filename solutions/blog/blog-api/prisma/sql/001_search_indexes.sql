-- ============================================================================
-- 搜索相关的"高级索引" —— 生产环境的性能优化，按需应用
-- ----------------------------------------------------------------------------
-- ⚠️ 为什么独立于 prisma/migrations/：
--   表达式索引 / 扩展，Prisma 的 schema.prisma 表达不了，纳不进它的迁移管理。
--   代价要知道：手动建在库里、不在迁移历史中的对象，会被 `prisma migrate dev` 视作
--   "drift"——它会提示你 `migrate reset`，而 reset 按迁移重建库、连带把这些手动对象
--   一起丢掉，之后得重跑本文件。所以：
--     · 开发期跑完 `migrate dev` / `reset`，记得重新应用本 SQL；
--     · 生产 / CI 用 `prisma migrate deploy`（只应用迁移、不做 drift 重置），更稳。
--   这是 ORM 边界外对象（触发器 / 物化视图 / 表达式索引）的通用处理方式。
--
-- 应用方式（连同一个 PG，但要进到 blog_api schema）：
--   psql "postgresql://blog:blog_dev_pwd@localhost:5432/blog" \
--     -c "SET search_path TO blog_api;" \
--     -f prisma/sql/001_search_indexes.sql
--
-- 这些索引是**可选优化**：不建，全文 / 模糊搜索照样能跑（只是走全表扫）。
-- 教学数据量小，跑不跑都行；上了万级数据，差距是数量级。
-- ============================================================================

-- 1) 全文搜索（FTS）：表达式 GIN 索引
--    让 `to_tsvector(...) @@ websearch_to_tsquery(...)` 走索引，而不是每行现算 tsvector。
--    注意索引里的表达式必须和查询里的**完全一致**（同样的 'simple'、同样的 title||' '||content），
--    否则规划器认不出来、用不上索引。
CREATE INDEX IF NOT EXISTS posts_fts_idx
  ON posts
  USING gin (to_tsvector('simple', title || ' ' || content));

-- 2) 模糊搜索（ILIKE '%关键词%'）：三元组（trigram）索引
--    前导通配符 '%kw%' 用不上普通 B-Tree 索引（B-Tree 只能用左前缀）。
--    pg_trgm 把字符串拆成 3 字符片段建 GIN 索引，让 ILIKE 包含匹配也能走索引。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS posts_title_trgm_idx
  ON posts USING gin (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS posts_content_trgm_idx
  ON posts USING gin (content gin_trgm_ops);
