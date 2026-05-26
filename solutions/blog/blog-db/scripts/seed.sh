#!/usr/bin/env bash
# 重新灌入 seed 数据。会先 TRUNCATE 现有数据，请确认是开发环境。
#
# Usage:
#   ./scripts/seed.sh             # 小数据：3 用户 / 10 文章
#   ./scripts/seed.sh --large     # 小数据 + 99990 篇文章（Day 23 用）

set -euo pipefail

CONTAINER="${CONTAINER:-pg-blog}"
DB_USER="${POSTGRES_USER:-blog}"
DB_NAME="${POSTGRES_DB:-blog}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SEED_FILE="${ROOT_DIR}/seed.sql"
LARGE_FILE="${ROOT_DIR}/seed_large.sql"

echo "→ seeding from ${SEED_FILE}"
docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" \
  -v ON_ERROR_STOP=1 < "$SEED_FILE"

if [[ "${1:-}" == "--large" ]]; then
  echo "→ also seeding large dataset from ${LARGE_FILE}"
  echo "  (this generates ~10w posts + ~30w post_tags, takes 20~60s)"
  docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" \
    -v ON_ERROR_STOP=1 < "$LARGE_FILE"
fi

echo "✅ seed 完成"
