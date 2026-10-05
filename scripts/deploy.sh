#!/usr/bin/env bash
# Деплой с рабочей машины на сервер. Идемпотентный: повторный запуск
# обновляет файлы, переимпортирует и заново публикует воркфлоу.
#   DEPLOY_HOST=vps DEPLOY_DIR=/opt/demos/n8n scripts/deploy.sh
set -euo pipefail

HOST="${DEPLOY_HOST:-vps}"
DIR="${DEPLOY_DIR:-/opt/demos/n8n}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "== проверка сборки воркфлоу"
python3 "$ROOT/scripts/build_workflows.py" --check
if command -v node >/dev/null 2>&1; then
  node "$ROOT/tests/test_lib.js"
  node "$ROOT/tests/check_workflows.js"
fi

echo "== rsync -> $HOST:$DIR"
ssh "$HOST" "mkdir -p '$DIR'"
# .env живёт только на сервере: исключён из передачи и из --delete
rsync -rlptz --delete \
  --exclude='.git/' --exclude='.env' --exclude='.DS_Store' --exclude='tmp/' \
  "$ROOT/" "$HOST:$DIR/"

echo "== сервер: .env, импорт, публикация, запуск"
ssh "$HOST" "cd '$DIR' && bash scripts/remote_deploy.sh"
