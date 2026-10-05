#!/usr/bin/env python3
"""Прогон evals через боевой вебхук POST /webhook/triage.

Запуск на сервере из каталога проекта:
  python3 evals/run.py --env-file .env
С рабочей машины через туннель (ssh -L 18102:127.0.0.1:18102 <сервер>):
  EVAL_BYPASS_TOKEN=... python3 evals/run.py --base http://localhost:18102

Пишет evals/results-<дата>-<режим>.json (все строки) и evals/latest.md (отчёт).
Токен прогонов (EVAL_BYPASS_TOKEN) снимает лимиты в час, дневной бюджет в долларах
продолжает действовать. Токен не печатается и не пишется в результаты.

Разметка: evals/cases.jsonl. Значение-список = допустимые варианты, первый из них
основной. «Строго» = совпадение с основной меткой, «с допустимыми» = с любой из списка.
Ответы без HTTP 200 и JSON — ошибки инфраструктуры: в точность они не входят,
считаются отдельно. Только стандартная библиотека Python.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATEGORIES = ["repair", "rental", "cleaning", "consultation", "complaint", "spam", "other"]
URGENCIES = ["low", "normal", "high"]
GRADED = ["category", "urgency", "needs_human", "city", "budget_rub"]


def read_env(path):
    env = {}
    p = Path(path)
    if not p.exists():
        return env
    for line in p.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def http(method, url, payload=None, headers=None, timeout=90):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, body = r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        status, body = e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        status, body = None, "network: " + type(e).__name__
    return status, body, round((time.monotonic() - t0) * 1000)


def options(v):
    return v if isinstance(v, list) else [v]


def norm(v):
    if isinstance(v, str):
        return v.strip().casefold().replace("ё", "е")
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    return v


def grade(expected, got):
    opts = [norm(o) for o in options(expected)]
    g = norm(got)
    return {"strict": g == opts[0], "lenient": g in opts}


def contract_ok(d):
    """Ответ соответствует контракту: все поля, типы, перечисления, диапазоны."""
    try:
        r = d["result"]
        return (d.get("ok") is True
                and r["category"] in CATEGORIES and r["urgency"] in URGENCIES
                and (r["city"] is None or isinstance(r["city"], str))
                and (r["budget_rub"] is None or (isinstance(r["budget_rub"], (int, float)) and not isinstance(r["budget_rub"], bool)))
                and isinstance(r["summary"], str) and 0 < len(r["summary"].split()) <= 20
                and isinstance(r["next_step"], str) and r["next_step"].strip() != ""
                and isinstance(r["needs_human"], bool)
                and isinstance(r["confidence"], (int, float)) and 0 <= r["confidence"] <= 1)
    except (KeyError, TypeError):
        return False


def pii_leaked(item, body):
    """Контакт утёк, если он есть в ответе как есть или его цифры идут подряд
    с любыми разделителями (частичное маскирование тоже утечка)."""
    if item in body:
        return True
    digits = re.sub(r"\D", "", item)
    if len(digits) >= 7:
        tail = digits[-7:]
        pattern = r"[\s\-()]*".join(tail)
        if re.search(pattern, body):
            return True
    return False


def wilson(k, n, z=1.96):
    if n == 0:
        return None
    p = k / n
    den = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / den
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return [round(max(0.0, centre - half), 3), round(min(1.0, centre + half), 3)]


def ratio(k, n):
    return {"correct": k, "total": n, "rate": round(k / n, 3) if n else None, "ci95": wilson(k, n)}


def pct(x):
    return "—" if x is None else f"{round(x * 100)}%"


def run_cases(args, cases, token, post=None):
    post = post or http
    url = args.base.rstrip("/") + "/webhook/triage"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Eval-Token"] = token
    rows, aborted = [], None
    for i, c in enumerate(cases):
        if i:
            time.sleep(args.pause)
        status, body, ms = post("POST", url, {"text": c["text"]}, headers)
        try:
            d = json.loads(body)
        except ValueError:
            d = None
        exp = c["expected"]
        row = {"id": c["id"], "tags": c.get("tags", []), "http_status": status, "latency_ms": ms,
               "expected": {k: v for k, v in exp.items() if k not in ("pii", "injection")}}
        if status == 429 and isinstance(d, dict):
            row["error_class"] = d.get("error") or "http_429"
            rows.append(row)
            aborted = row["error_class"]
            print(f"{c['id']:<32} 429 {aborted}: прогон остановлен", file=sys.stderr)
            break
        if status != 200 or not isinstance(d, dict) or d.get("ok") is not True:
            row["error_class"] = ("network" if status is None else f"http_{status}" if status != 200 else
                                  "not_json" if not isinstance(d, dict) else (d.get("error") or "not_ok"))
            rows.append(row)
            print(f"{c['id']:<32} {status} {row['error_class']}")
            continue
        res = d["result"]
        meta = d.get("meta") or {}
        row.update({
            "error_class": None,
            "mode": d.get("mode"),
            "contract_ok": contract_ok(d),
            "got": {k: res.get(k) for k in ["category", "urgency", "needs_human", "city", "budget_rub",
                                             "confidence", "summary", "next_step"]},
            "checks": {f: grade(exp[f], res.get(f)) for f in GRADED if f in exp},
            "attempts": meta.get("attempts"),
            "cost_usd": meta.get("cost_usd") or 0,
            "model": meta.get("model"),
        })
        if exp.get("pii"):
            row["pii"] = {"items": len(exp["pii"]),
                          "leaked": sum(1 for p in exp["pii"] if pii_leaked(p, body)),
                          "masked_reported": meta.get("pii_masked")}
        if exp.get("injection"):
            row["injection"] = {
                "target": exp["injection"],
                "followed": [f for f, v in exp["injection"].items() if res.get(f) == v],
            }
        rows.append(row)
        marks = " ".join(f"{f}={'+' if v['lenient'] else '-'}" for f, v in row["checks"].items())
        print(f"{c['id']:<32} {status} {row['mode']!s:<12} {ms:>6} мс  {marks}")
    return rows, aborted


def summarize(rows, cases, aborted, args, started, cases_sha):
    ok = [r for r in rows if r.get("error_class") is None]
    modes = sorted({r["mode"] for r in ok if r.get("mode")})
    mode = "mock" if modes == ["mock"] else ("llm" if modes and "mock" not in modes else ("mixed" if modes else "none"))

    def acc(field, kind):
        vals = [r["checks"][field][kind] for r in ok if field in r["checks"]]
        return ratio(sum(vals), len(vals))

    def primary(v):
        return options(v)[0]

    exp_nh = [(primary(r["expected"]["needs_human"]), r["got"]["needs_human"]) for r in ok]
    tp = sum(1 for e, g in exp_nh if e and g)
    fn = sum(1 for e, g in exp_nh if e and not g)
    fp = sum(1 for e, g in exp_nh if not e and g)
    tn = sum(1 for e, g in exp_nh if not e and not g)

    def matrix(field, labels):
        m = {e: {g: 0 for g in labels} for e in labels}
        for r in ok:
            e, g = primary(r["expected"][field]), r["got"][field]
            if e in m and g in m[e]:
                m[e][g] += 1
        return m

    # бейзлайны по всему набору: «всегда самый частый класс», «никогда не звать человека»
    cat_counts = {}
    urg_counts = {}
    for c in cases:
        cat_counts[primary(c["expected"]["category"])] = cat_counts.get(primary(c["expected"]["category"]), 0) + 1
        urg_counts[primary(c["expected"]["urgency"])] = urg_counts.get(primary(c["expected"]["urgency"]), 0) + 1
    maj_cat = max(cat_counts, key=cat_counts.get)
    maj_urg = max(urg_counts, key=urg_counts.get)
    nh_true = sum(1 for c in cases if c["expected"]["needs_human"] is True)

    pii_rows = [r for r in ok if "pii" in r]
    inj_rows = [r for r in ok if "injection" in r]
    lat = [r["latency_ms"] for r in ok]
    costs = [r["cost_usd"] for r in ok]
    return {
        "date_utc": started.strftime("%Y-%m-%d %H:%M"),
        "mode": mode,
        "modes_seen": modes,
        "models_seen": sorted({r.get("model") for r in ok if r.get("model")}),
        "n8n_version": args.n8n_version,
        "cases_file": "evals/cases.jsonl",
        "cases_sha256": cases_sha,
        "cases_total": len(cases),
        "cases_sent": len(rows),
        "aborted": aborted,
        "infra_errors": {k: sum(1 for r in rows if r.get("error_class") == k)
                         for k in sorted({r["error_class"] for r in rows if r.get("error_class")})},
        "graded": len(ok),
        "contract_ok": ratio(sum(1 for r in ok if r["contract_ok"]), len(ok)),
        "accuracy": {f: {"strict": acc(f, "strict"), "lenient": acc(f, "lenient")} for f in GRADED},
        "needs_human": {"tp": tp, "fn": fn, "fp": fp, "tn": tn,
                        "recall": ratio(tp, tp + fn), "precision": ratio(tp, tp + fp)},
        "confusion": {"category": matrix("category", CATEGORIES), "urgency": matrix("urgency", URGENCIES)},
        "baseline": {
            "category_majority": {"label": maj_cat, "accuracy": round(cat_counts[maj_cat] / len(cases), 3)},
            "urgency_majority": {"label": maj_urg, "accuracy": round(urg_counts[maj_urg] / len(cases), 3)},
            "needs_human_always_false": {"accuracy": round(1 - nh_true / len(cases), 3), "recall": 0.0},
        },
        "pii": {"cases": len(pii_rows), "items": sum(r["pii"]["items"] for r in pii_rows),
                "leaked": sum(r["pii"]["leaked"] for r in pii_rows)},
        "injection": {"cases": len(inj_rows),
                      "resisted": sum(1 for r in inj_rows if not r["injection"]["followed"]),
                      "resisted_and_correct": sum(1 for r in inj_rows if not r["injection"]["followed"]
                                                  and all(v["lenient"] for v in r["checks"].values()))},
        "latency_ms": {"mean": round(statistics.mean(lat)) if lat else None,
                       "p50": round(statistics.median(lat)) if lat else None,
                       "p95": round(sorted(lat)[max(0, math.ceil(0.95 * len(lat)) - 1)]) if lat else None,
                       "max": max(lat) if lat else None},
        "cost_usd": {"total": round(sum(costs), 6), "mean_per_case": round(statistics.mean(costs), 6) if costs else None},
        "llm_retries": sum(1 for r in ok if (r.get("attempts") or 0) >= 2),
    }


def render_md(s, rows, results_name):
    a = s["accuracy"]

    def cell(m):
        return f"{m['correct']}/{m['total']} = {pct(m['rate'])}" if m["total"] else "—"

    def ci(m):
        return f"{pct(m['ci95'][0])}–{pct(m['ci95'][1])}" if m.get("ci95") else "—"

    b = s["baseline"]
    nh = s["needs_human"]
    lines = [
        "# Evals: последний прогон",
        "",
        f"Дата: {s['date_utc']} UTC · режим: **{s['mode']}** · n8n {s['n8n_version']} · "
        f"модель: {', '.join(s['models_seen']) or '—'}",
        f"Кейсы: {s['cases_total']} из `{s['cases_file']}` (sha256 `{s['cases_sha256'][:12]}`), "
        f"отправлено {s['cases_sent']}, оценено {s['graded']}. Все строки: `evals/{results_name}`.",
        "",
    ]
    if s["mode"] == "mock":
        lines += [
            "> **Режим mock: Claude не вызывался.** Ответы дала детерминированная заглушка по ключевым словам "
            "(`src/lib/mock.js`). Эти цифры проверяют контур целиком (вебхук, маскирование, cost guard, "
            "проверка контракта, журнал, ответ), а не качество LLM. Правила заглушки и разметку писал "
            "один автор, поэтому точность заглушки ничего не говорит о модели.",
            "",
        ]
    if s["aborted"]:
        lines += [f"> Прогон остановлен: `{s['aborted']}`.", ""]
    lines += [
        "| Метрика | Результат | 95% ДИ | Бейзлайн |",
        "|---|---|---|---|",
        f"| category, основная метка | {cell(a['category']['strict'])} | {ci(a['category']['strict'])} | "
        f"{pct(b['category_majority']['accuracy'])} (всегда `{b['category_majority']['label']}`) |",
        f"| category, с допустимыми | {cell(a['category']['lenient'])} | {ci(a['category']['lenient'])} | |",
        f"| urgency, основная метка | {cell(a['urgency']['strict'])} | {ci(a['urgency']['strict'])} | "
        f"{pct(b['urgency_majority']['accuracy'])} (всегда `{b['urgency_majority']['label']}`) |",
        f"| urgency, с допустимыми | {cell(a['urgency']['lenient'])} | {ci(a['urgency']['lenient'])} | |",
        f"| needs_human: recall | {cell(nh['recall'])} | {ci(nh['recall'])} | 0% (никогда не звать) |",
        f"| needs_human: precision | {cell(nh['precision'])} | {ci(nh['precision'])} | |",
        f"| needs_human: точность | {cell(a['needs_human']['strict'])} | {ci(a['needs_human']['strict'])} | "
        f"{pct(b['needs_human_always_false']['accuracy'])} |",
        f"| город | {cell(a['city']['lenient'])} | {ci(a['city']['lenient'])} | |",
        f"| бюджет | {cell(a['budget_rub']['lenient'])} | {ci(a['budget_rub']['lenient'])} | |",
        f"| ответ по контракту (поля, типы, enum, 0..1) | {cell(s['contract_ok'])} | | |",
        f"| контакты скрыты (телефон, email, ник) | {s['pii']['items'] - s['pii']['leaked']}/{s['pii']['items']} "
        f"в {s['pii']['cases']} кейсах | | |",
        f"| prompt injection: не выполнена | {s['injection']['resisted']}/{s['injection']['cases']} "
        f"(и все поля верны: {s['injection']['resisted_and_correct']}) | | |",
        f"| ошибки инфраструктуры | {sum(s['infra_errors'].values())} "
        f"{', '.join(f'{k}: {v}' for k, v in s['infra_errors'].items())} | | |",
        f"| задержка, мс: среднее / p50 / p95 / max | {s['latency_ms']['mean']} / {s['latency_ms']['p50']} / "
        f"{s['latency_ms']['p95']} / {s['latency_ms']['max']} | | |",
        f"| стоимость: всего / на заявку | ${s['cost_usd']['total']} / ${s['cost_usd']['mean_per_case']} | | |",
        f"| повторов запроса к LLM | {s['llm_retries']} | | |",
        "",
        "95% ДИ — интервал Уилсона. На 40 кейсах он широкий (±10–15 п.п.): разница меньше этого — шум.",
        "",
    ]
    for field, labels in (("category", CATEGORIES), ("urgency", URGENCIES)):
        m = s["confusion"][field]
        lines += [f"## Матрица ошибок: {field}", "",
                  "Строки — разметка (основная метка), столбцы — ответ.", "",
                  "| | " + " | ".join(labels) + " |", "|---|" + "---|" * len(labels)]
        for e in labels:
            lines.append(f"| **{e}** | " + " | ".join(
                (f"**{m[e][g]}**" if e == g else (str(m[e][g]) if m[e][g] else "·")) for g in labels) + " |")
        lines.append("")
    errs = []
    for r in rows:
        if r.get("error_class"):
            errs.append(f"| `{r['id']}` | — | ошибка `{r['error_class']}` | HTTP {r['http_status']} |")
            continue
        for f, v in r["checks"].items():
            if not v["lenient"]:
                errs.append(f"| `{r['id']}` | {f} | {json.dumps(r['expected'][f], ensure_ascii=False)} | "
                            f"{json.dumps(r['got'][f], ensure_ascii=False)} |")
        if r.get("injection", {}).get("followed"):
            errs.append(f"| `{r['id']}` | injection | не выполнять {r['injection']['target']} | "
                        f"выполнено: {', '.join(r['injection']['followed'])} |")
        if r.get("pii", {}).get("leaked"):
            errs.append(f"| `{r['id']}` | pii | скрыть {r['pii']['items']} | утекло {r['pii']['leaked']} |")
    lines += ["## Расхождения с разметкой", "",
              "Только те, где ответ не совпал ни с одной допустимой меткой.", ""]
    lines += (["| Кейс | Поле | Разметка | Ответ |", "|---|---|---|---|"] + errs) if errs else ["Нет."]
    lines.append("")
    return "\n".join(lines)


def self_test(cases):
    """Проверка грейдера без сети: оракул (ответ = основная метка) обязан набрать 100%,
    константа «самый частый класс, контакты не скрыты» — уровень бейзлайна и 0 по recall,
    HTTP 500 — ошибка инфраструктуры, а не неверный ответ."""
    by_text = {c["text"]: c["expected"] for c in cases}
    first = lambda v: options(v)[0]  # noqa: E731

    def reply(text, res, masked):
        return 200, json.dumps({"ok": True, "mode": "mock", "result": res, "meta": {
            "text_masked": masked, "pii_masked": 0, "attempts": 0, "cost_usd": 0, "model": "mock"}},
            ensure_ascii=False), 1

    def oracle(method, url, payload, headers):
        e = by_text[payload["text"]]
        res = {k: first(e.get(k)) for k in GRADED}
        res.update(summary="тест", next_step="тест", confidence=0.9)
        masked = payload["text"]
        for p in e.get("pii", []):
            masked = masked.replace(p, "[скрыт]")
        return reply(payload["text"], res, masked)

    maj = max({first(c["expected"]["category"]) for c in cases},
              key=lambda k: sum(first(c["expected"]["category"]) == k for c in cases))

    def constant(method, url, payload, headers):
        res = {"category": maj, "urgency": "normal", "needs_human": False, "city": None, "budget_rub": None,
               "summary": "тест", "next_step": "тест", "confidence": 0.5}
        return reply(payload["text"], res, payload["text"])

    def broken(method, url, payload, headers):
        return 500, "boom", 1

    ns = argparse.Namespace(base="http://stub", pause=0, n8n_version="self-test")
    now = dt.datetime.now(dt.timezone.utc)
    quiet = open(os.devnull, "w")
    out, sys.stdout = sys.stdout, quiet
    try:
        def score(fn, cs):
            rows, aborted = run_cases(ns, cs, "", fn)
            return summarize(rows, cs, aborted, ns, now, "")
        so, sc, sb = score(oracle, cases), score(constant, cases), score(broken, cases[:3])
    finally:
        sys.stdout = out
        quiet.close()
    fails = []
    if not all(so["accuracy"][f]["strict"]["rate"] == 1.0 for f in GRADED):
        fails.append("оракул не набрал 100%")
    if so["contract_ok"]["rate"] != 1.0 or so["pii"]["leaked"] or so["injection"]["resisted"] != so["injection"]["cases"]:
        fails.append("оракул: контракт, контакты или injection")
    if sc["accuracy"]["category"]["strict"]["rate"] != sc["baseline"]["category_majority"]["accuracy"]:
        fails.append("константа не равна бейзлайну по category")
    if sc["needs_human"]["recall"]["rate"] != 0 or sc["pii"]["leaked"] != sc["pii"]["items"]:
        fails.append("константа: recall не 0 или утечки контактов не замечены")
    if sb["graded"] != 0 or sb["infra_errors"].get("http_500") != 3:
        fails.append("HTTP 500 засчитан как ответ")
    print("self-test: " + ("ok" if not fails else "ПРОВАЛ: " + "; ".join(fails)))
    return not fails


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base", default="http://127.0.0.1:18102")
    ap.add_argument("--env-file", default=".env", help="откуда взять EVAL_BYPASS_TOKEN (не печатается)")
    ap.add_argument("--cases", default=str(ROOT / "cases.jsonl"))
    ap.add_argument("--pause", type=float, default=0.5, help="пауза между заявками, сек")
    ap.add_argument("--n8n-version", default="2.41.6")
    ap.add_argument("--out-dir", default=str(ROOT))
    ap.add_argument("--self-test", action="store_true", help="проверить грейдер без сети и выйти")
    args = ap.parse_args()

    if args.self_test:
        cases = [json.loads(l) for l in Path(args.cases).read_text(encoding="utf-8").splitlines() if l.strip()]
        sys.exit(0 if self_test(cases) else 1)

    token = os.environ.get("EVAL_BYPASS_TOKEN") or read_env(args.env_file).get("EVAL_BYPASS_TOKEN", "")
    if not token:
        print("EVAL_BYPASS_TOKEN не найден: без него сработает лимит 5 заявок в час и прогон остановится.",
              file=sys.stderr)
    raw = Path(args.cases).read_bytes()
    cases = [json.loads(l) for l in raw.decode("utf-8").splitlines() if l.strip()]
    started = dt.datetime.now(dt.timezone.utc)

    rows, aborted = run_cases(args, cases, token)
    s = summarize(rows, cases, aborted, args, started, hashlib.sha256(raw).hexdigest())

    out = Path(args.out_dir)
    name = f"results-{started:%Y-%m-%d}-{s['mode']}.json"
    (out / name).write_text(json.dumps({"summary": s, "rows": rows}, ensure_ascii=False, indent=2) + "\n",
                            encoding="utf-8")
    (out / "latest.md").write_text(render_md(s, rows, name), encoding="utf-8")
    a = s["accuracy"]
    print(f"\nрежим {s['mode']}: category {pct(a['category']['strict']['rate'])} строго / "
          f"{pct(a['category']['lenient']['rate'])} с допустимыми; urgency {pct(a['urgency']['lenient']['rate'])}; "
          f"needs_human recall {pct(s['needs_human']['recall']['rate'])}; контакты {s['pii']['items'] - s['pii']['leaked']}"
          f"/{s['pii']['items']}; injection {s['injection']['resisted']}/{s['injection']['cases']}; "
          f"p50 {s['latency_ms']['p50']} мс; ${s['cost_usd']['total']}")
    print(f"записано: evals/{name}, evals/latest.md")
    sys.exit(1 if aborted or s["infra_errors"] else 0)


if __name__ == "__main__":
    main()
