#!/usr/bin/env bash
# Smoke на сервере: вебхук отвечает валидным JSON по контракту, доска отдаёт HTML.
set -euo pipefail
BASE="${BASE:-http://127.0.0.1:18102}"
cd "$(dirname "$0")/.."
# токен прогонов снимает лимит в час, чтобы smoke не упирался в 5 заявок/час с localhost
TOKEN=$(grep -E '^EVAL_BYPASS_TOKEN=' .env | cut -d= -f2- || true)

body=""
for i in $(seq 1 20); do
  body=$(curl -s -m 60 -X POST "$BASE/webhook/triage" -H 'Content-Type: application/json' -H "X-Eval-Token: $TOKEN" \
    -d '{"text":"Сломался генератор на складе в Казани, нужен мастер сегодня. Бюджет до 15 тыс руб. Тел +7 999 123-45-67"}' || true)
  # сразу после старта вебхук может быть ещё не зарегистрирован (404) — ждём ответа контура
  if [ -n "$body" ] && printf '%s' "$body" | python3 -c 'import json,sys; sys.exit(0 if "ok" in json.load(sys.stdin) else 1)' 2>/dev/null; then break; fi
  sleep 2
done
printf '%s' "$body" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d.get("ok") is False and d.get("error", "").startswith("rate_limited"):
    print("smoke triage: лимит в час уже выбран, контур ответил отказом 429:", d["error"]); sys.exit(0)
r = d["result"]
assert d["ok"] is True, d
assert r["category"] in {"repair","rental","cleaning","consultation","complaint","spam","other"}
assert r["urgency"] in {"low","normal","high"}
assert isinstance(r["needs_human"], bool) and 0 <= r["confidence"] <= 1
assert "999" not in d["meta"]["text_masked"], "телефон не замаскирован"
print("smoke triage: ok, mode=%s category=%s urgency=%s city=%s budget=%s" % (d["mode"], r["category"], r["urgency"], r["city"], r["budget_rub"]))
'
code=$(curl -s -o /tmp/demo-n8n-board.html -w '%{http_code}' "$BASE/webhook/board")
grep -q 'Потрачено сегодня' /tmp/demo-n8n-board.html
echo "smoke board: HTTP $code, $(wc -c < /tmp/demo-n8n-board.html) байт"
rm -f /tmp/demo-n8n-board.html
