#!/usr/bin/env bash
# 重新灌入 seed.sql。会先 TRUNCATE 现有数据，请确认是开发环境。

set -euo pipefail

CONTAINER="${CONTAINER:-pg-blog}"
DB_USER="${POSTGRES_USER:-blog}"
DB_NAME="${POSTGRES_DB:-blog}"
SEED_FILE="$(cd "$(dirname "$0")/.." && pwd)/seed.sql"

echo "→ seeding from ${SEED_FILE}"
docker exec -i "${CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" \
  -v ON_ERROR_STOP=1 < "$SEED_FILE"

echo "✅ seed 完成"
