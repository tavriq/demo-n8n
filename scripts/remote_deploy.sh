#!/usr/bin/env bash
# Выполняется на сервере в каталоге проекта (вызывает scripts/deploy.sh).
set -euo pipefail
cd "$(dirname "$0")/.."

# .env: создаётся из .env.example; в существующий дописываются только новые ключи,
# пустые секреты генерируются, заданные значения не трогаются и не печатаются
( umask 077 && python3 - <<'PY'
import os, secrets
gen = {
    "N8N_ENCRYPTION_KEY": lambda: secrets.token_hex(32),
    "IP_HASH_SALT": lambda: secrets.token_hex(16),
    "EVAL_BYPASS_TOKEN": lambda: secrets.token_hex(24),
}
cur = open(".env", encoding="utf-8").read().splitlines() if os.path.exists(".env") else []
keys = {l.split("=", 1)[0].strip() for l in cur if "=" in l and not l.lstrip().startswith("#")}
out = list(cur)
added = []
for line in open(".env.example", encoding="utf-8").read().splitlines():
    if "=" not in line or line.lstrip().startswith("#"):
        if not cur:
            out.append(line)
        continue
    key = line.split("=", 1)[0].strip()
    if key in keys:
        continue
    if key in gen and line.strip() == key + "=":
        line = key + "=" + gen[key]()
    out.append(line)
    added.append(key)
for i, l in enumerate(out):
    k = l.split("=", 1)[0].strip()
    if k in gen and l.strip() == k + "=":
        out[i] = k + "=" + gen[k]()
        added.append(k + " (сгенерирован)")
open(".env", "w", encoding="utf-8").write("\n".join(out) + "\n")
print("-- .env: " + ("добавлено " + ", ".join(added) if added else "без изменений"))
PY
)
chmod 600 .env

IDS=$(python3 -c 'import json,glob; print(" ".join(json.load(open(f))["id"] for f in sorted(glob.glob("workflows/*.json"))))')
PUBLISH=""
for id in $IDS; do PUBLISH="$PUBLISH && n8n publish:workflow --id=$id"; done

echo "-- остановка n8n (CLI и сервер не делят sqlite одновременно)"
docker compose stop n8n >/dev/null 2>&1 || true

echo "-- импорт и публикация: $IDS"
docker compose run --rm --no-deps -T --entrypoint sh n8n -c \
  "n8n import:workflow --separate --input=/workflows $PUBLISH" 2>&1 \
  | grep -v -i -E 'deprecat|^\s*$' || true

echo "-- запуск"
docker compose up -d --wait n8n
python3 scripts/wait_published.py

bash scripts/smoke.sh
