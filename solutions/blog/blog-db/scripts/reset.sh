#!/usr/bin/env bash
# 危险操作：销毁容器和数据卷，从零重建。
# 仅用于开发环境，生产永远不要这么干。

set -euo pipefail

cd "$(dirname "$0")/.."

read -r -p "⚠️  这会删除 pg-blog-data 卷里的所有数据，确认？(y/N) " ans
if [[ "${ans}" != "y" && "${ans}" != "Y" ]]; then
  echo "已取消"
  exit 0
fi

docker compose down -v
docker compose up -d
./scripts/migrate.sh
./scripts/seed.sh
