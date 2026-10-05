#!/usr/bin/env python3
"""Записывает прогоны пресетов песочницы через боевой POST /webhook/triage.

Запуск на сервере из каталога проекта, результат — в stdout:
  python3 scripts/record_presets.py --env-file .env > /tmp/recordings.json
и потом в репо: sandbox/recordings.json, node scripts/build_sandbox.js.
Токен прогонов (EVAL_BYPASS_TOKEN) снимает лимит в час, дневной лимит токенов действует.
Только стандартная библиотека Python.
"""
import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def token_from(env_file):
    p = Path(env_file)
    if not p.exists():
        return ""
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.startswith("EVAL_BYPASS_TOKEN="):
            return line.split("=", 1)[1].strip()
    return ""


def post(url, text, token):
    req = urllib.request.Request(url, data=json.dumps({"text": text}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "X-Eval-Token": token})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "null")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base", default="http://127.0.0.1:18102")
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--pause", type=float, default=1.0)
    ap.add_argument("--allow-mock", action="store_true", help="принять ответы заглушки (только для вёрстки, не в репо)")
    args = ap.parse_args()
    token = token_from(args.env_file)
    presets = json.loads((ROOT / "sandbox" / "content.json").read_text(encoding="utf-8"))["presets"]
    runs = {}
    for p in presets:
        status, body = post(args.base.rstrip("/") + "/webhook/triage", p["text"], token)
        ok = status == 200 and isinstance(body, dict) and body.get("ok") is True and (args.allow_mock or body.get("mode") == "llm")
        print(f"{p['id']}: HTTP {status}, mode={body.get('mode') if isinstance(body, dict) else None}", file=sys.stderr)
        if not ok:
            print("запись прервана: нужен ответ модели (mode=llm)", file=sys.stderr)
            sys.exit(1)
        runs[p["id"]] = {"text": p["text"], "response": body}
        time.sleep(args.pause)
    out = {"recorded_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"), "runs": runs}
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
