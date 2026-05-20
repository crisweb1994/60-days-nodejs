#!/usr/bin/env bash
# 穷人版 migration runner：按文件名顺序把 migrations/*.sql 灌进容器
# Day 25 接入 Prisma Migrate 后这个脚本会被替换掉，
# 但理解它做的事情有助于看懂迁移工具背后在跑什么。

set -euo pipefail

CONTAINER="${CONTAINER:-pg-blog}"
DB_USER="${POSTGRES_USER:-blog}"
DB_NAME="${POSTGRES_DB:-blog}"
MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/migrations"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "❌ 容器 ${CONTAINER} 未运行，先执行 docker compose up -d" >&2
  exit 1
fi

echo "→ 等待 PostgreSQL 就绪..."
until docker exec "${CONTAINER}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" -q; do
  sleep 1
done

shopt -s nullglob
for sql in "${MIGRATIONS_DIR}"/*.sql; do
  name="$(basename "$sql")"
  echo "→ applying ${name}"
  docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" \
    -v ON_ERROR_STOP=1 -q < "$sql"
done

echo "✅ migrations 应用完成"
