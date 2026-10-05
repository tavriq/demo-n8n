#!/usr/bin/env python3
"""Прогон evals через боевой вебхук POST /webhook/triage.

Запуск на сервере из каталога проекта:
  python3 evals/run_evals.py --env-file .env --out evals/results/<дата>-<режим>.json

Токен прогонов (EVAL_BYPASS_TOKEN) читается из .env и не печатается: он снимает
лимиты в час, дневной бюджет в долларах продолжает действовать.
Только стандартная библиотека Python.
"""
import argparse
import datetime as dt
import json
import statistics
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATEGORIES = {"repair", "rental", "cleaning", "consultation", "complaint", "spam", "other"}
URGENCIES = {"low", "normal", "high"}
CHECKED = ["category", "urgency", "city", "budget_rub", "needs_human"]


def read_env(path):
    env = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def post(url, text, token, timeout=90):
    data = json.dumps({"text": text}).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Content-Type": "application/json", "X-Eval-Token": token})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, body = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode()
    return status, body, round((time.monotonic() - t0) * 1000)


def contract_ok(d):
    """Ответ соответствует контракту: все поля, типы, перечисления, диапазоны."""
    try:
        r = d["result"]
        return (d.get("ok") is True
                and r["category"] in CATEGORIES and r["urgency"] in URGENCIES
                and (r["city"] is None or isinstance(r["city"], str))
                and (r["budget_rub"] is None or isinstance(r["budget_rub"], (int, float)))
                and isinstance(r["summary"], str) and 0 < len(r["summary"].split()) <= 20
                and isinstance(r["next_step"], str) and r["next_step"]
                and isinstance(r["needs_human"], bool)
                and isinstance(r["confidence"], (int, float)) and 0 <= r["confidence"] <= 1)
    except (KeyError, TypeError):
        return False


def field_match(expected, got):
    if isinstance(expected, list):
        return got in expected
    return got == expected


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18102")
    ap.add_argument("--env-file", default=".env")
    ap.add_argument("--cases", default=str(ROOT / "cases.jsonl"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--n8n-version", default="2.41.6")
    args = ap.parse_args()

    token = read_env(args.env_file).get("EVAL_BYPASS_TOKEN", "")
    cases = [json.loads(l) for l in Path(args.cases).read_text(encoding="utf-8").splitlines() if l.strip()]
    url = args.base.rstrip("/") + "/webhook/triage"
    started = dt.datetime.now(dt.timezone.utc)

    rows = []
    for c in cases:
        status, body, ms = post(url, c["text"], token)
        try:
            d = json.loads(body)
        except ValueError:
            d = {}
        exp = c["expected"]
        res = d.get("result") or {}
        checks = {f: field_match(exp[f], res.get(f)) for f in CHECKED if f in exp and d.get("ok")}
        leaks = [s for s in exp.get("pii", []) if s in body]
        rows.append({
            "id": c["id"],
            "http_status": status,
            "mode": d.get("mode"),
            "contract_ok": contract_ok(d),
            "checks": checks,
            "pii_expected": len(exp.get("pii", [])) > 0,
            "pii_leaks": leaks,
            "latency_ms": ms,
            "cost_usd": (d.get("meta") or {}).get("cost_usd", 0),
            "attempts": (d.get("meta") or {}).get("attempts"),
            "expected": {k: v for k, v in exp.items() if k != "pii"},
            "got": {f: res.get(f) for f in CHECKED + ["summary", "next_step", "confidence"]} if res else None,
            "error": None if d.get("ok") else d.get("error"),
        })
        print(f"{c['id']:<22} {status} {d.get('mode')!s:<12} contract={rows[-1]['contract_ok']!s:<5} "
              + " ".join(f"{k}={'+' if v else '-'}" for k, v in checks.items()))

    def acc(field):
        vals = [r["checks"][field] for r in rows if field in r["checks"]]
        return {"correct": sum(vals), "total": len(vals)}

    lat = [r["latency_ms"] for r in rows if r["http_status"] == 200]
    modes = sorted({r["mode"] for r in rows if r["mode"]})
    summary = {
        "date_utc": started.strftime("%Y-%m-%d %H:%M"),
        "n8n_version": args.n8n_version,
        "modes": modes,
        "cases": len(rows),
        "http_200": sum(1 for r in rows if r["http_status"] == 200),
        "contract_ok": sum(1 for r in rows if r["contract_ok"]),
        "accuracy": {f: acc(f) for f in CHECKED},
        "pii_cases": sum(1 for r in rows if r["pii_expected"]),
        "pii_leaks": sum(len(r["pii_leaks"]) for r in rows),
        "retries": sum(1 for r in rows if r["attempts"] == 2),
        "latency_ms_p50": int(statistics.median(lat)) if lat else None,
        "latency_ms_max": max(lat) if lat else None,
        "cost_usd_total": round(sum(r["cost_usd"] or 0 for r in rows), 6),
    }
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
