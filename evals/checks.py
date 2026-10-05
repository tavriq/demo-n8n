#!/usr/bin/env python3
"""Проверки защиты на живом контуре: XSS на доске, маскирование контактов,
лимит заявок с IP, дневной бюджет на LLM.

Запуск на сервере из каталога проекта (нужны docker compose и .env):
  python3 evals/checks.py            # все проверки
  python3 evals/checks.py --no-budget

Проверка бюджета временно меняет .env: ставит маленький DAILY_BUDGET_USD,
тестовый ключ и адрес локальной заглушки Messages API (tests/fake_anthropic.js
внутри контейнера), перезапускает n8n, а в finally возвращает исходный .env
байт в байт и перезапускает снова. Если ANTHROPIC_API_KEY уже задан, проверка
бюджета пропускается: она не должна тратить настоящие деньги и трогать ключ.
Секреты не печатаются и не пишутся в результат. Пишет evals/checks-<дата>.json.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run import http, pii_leaked, read_env  # noqa: E402

BASE = "http://127.0.0.1:18102"
FAKE_PORT = 18999
BACKUP = Path(".env.checks-backup")
FAKE_COST = (812 * 1.0 + 95 * 5.0) / 1e6  # usage заглушки × цены по умолчанию


def triage(text, token=None, ip=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["X-Eval-Token"] = token
    if ip:
        h["X-Real-IP"] = ip
    status, body, ms = http("POST", BASE + "/webhook/triage", {"text": text}, h)
    try:
        d = json.loads(body)
    except ValueError:
        d = {}
    return status, body, d


def board():
    return http("GET", BASE + "/webhook/board")[1]


def spent_and_budget(html):
    m = re.search(r"Потрачено сегодня:\s*<b>\$([\d.]+)</b>\s*из\s*\$([\d.]+)", html)
    return (float(m.group(1)), float(m.group(2))) if m else (None, None)


def board_mode(html):
    if "LLM (" in html:
        return "llm"
    if "mock:" in html:
        return "mock"
    return None


def sh(cmd, stdin=None, check=True):
    with (open(stdin, "rb") if stdin else open(os.devnull, "rb")) as f:
        r = subprocess.run(cmd, stdin=f, capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])}…: код {r.returncode}")
    return r.stdout


def restart_and_wait(expect_mode, timeout=180):
    sh(["docker", "compose", "up", "-d", "--wait", "n8n"])
    sh(["python3", "scripts/wait_published.py"])
    deadline = time.time() + timeout
    while time.time() < deadline:
        html = board()
        if board_mode(html) == expect_mode:
            return html
        time.sleep(2)
    raise RuntimeError(f"после перезапуска доска не показала режим {expect_mode}")


def set_env_lines(text, values):
    lines = text.splitlines()
    for key, val in values.items():
        for i, l in enumerate(lines):
            if l.split("=", 1)[0].strip() == key and not l.lstrip().startswith("#"):
                lines[i] = f"{key}={val}"
                break
        else:
            lines.append(f"{key}={val}")
    return "\n".join(lines) + "\n"


def check_xss(token):
    payload = ('Проверка XSS: <script>alert("xss")</script> <img src=x onerror=alert(1)> '
               '"кавычки" & \'апостроф\' — нужна уборка офиса')
    status, _, d = triage(payload, token=token)
    html = board()
    checks = {
        "заявка принята (200)": status == 200 and d.get("ok") is True,
        "на доске нет тегов <script>": "<script" not in html.lower(),
        "на доске нет тега <img>": "<img" not in html.lower(),
        "текст на доске экранирован": "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;" in html,
        "&lt;img … onerror экранирован": "&lt;img src=x onerror=alert(1)&gt;" in html,
        "строгий CSP в meta": "default-src 'none'" in html,
    }
    return {"name": "xss_board", "ok": all(checks.values()), "checks": checks}


def check_pii(token):
    items = ["+7 916 123-45-67", "8(495)765-43-21", "test.user@example.com", "@check_user_01"]
    text = ("Проверка маскирования: нужна аренда генератора, звоните " + items[0] + " или " + items[1]
            + ", почта " + items[2] + ", тг " + items[3])
    status, body, d = triage(text, token=token)
    html = board()
    meta = d.get("meta") or {}
    checks = {
        "заявка принята (200)": status == 200 and d.get("ok") is True,
        "найдено и скрыто 4 контакта": meta.get("pii_masked") == 4,
        "в ответе (и сохранённом тексте) контактов нет": not any(pii_leaked(p, body) for p in items),
        "на доске контактов нет": not any(pii_leaked(p, html) for p in items),
        "на доске метки [телефон скрыт], [email скрыт], [ник скрыт]":
            all(m in html for m in ("[телефон скрыт]", "[email скрыт]", "[ник скрыт]")),
    }
    return {"name": "pii_masking", "ok": all(checks.values()), "checks": checks,
            "text_masked": meta.get("text_masked")}


def check_rate_limit(env):
    limit = int(float(env.get("RATE_LIMIT_PER_IP_HOUR") or 5))
    # адреса из TEST-NET-2 (RFC 5737): как будто их поставил обратный прокси в X-Real-IP
    ip = f"198.51.100.{random.randint(1, 254)}"
    other = f"198.51.100.{(int(ip.rsplit('.', 1)[1]) % 254) + 1}"
    seq = []
    last = {}
    for i in range(limit + 1):
        status, _, d = triage(f"Проверка лимита {i + 1}: нужна уборка склада", ip=ip)
        seq.append(status)
        last = d
        time.sleep(0.3)
    status_other, _, _ = triage("Проверка лимита: заявка с другого адреса, нужна аренда пылесоса", ip=other)
    checks = {
        f"первые {limit} заявок с адреса приняты": seq[:limit] == [200] * limit,
        f"заявка №{limit + 1} отклонена 429 rate_limited_ip": seq[limit] == 429 and last.get("error") == "rate_limited_ip",
        "отказ вежливый и объясняет лимит": "не больше" in (last.get("message") or ""),
        "другой адрес не затронут (200)": status_other == 200,
    }
    return {"name": "rate_limit_ip", "ok": all(checks.values()), "checks": checks,
            "limit_per_hour": limit, "statuses": seq + [status_other], "refusal_message": last.get("message")}


def check_budget(env, token):
    if env.get("ANTHROPIC_API_KEY"):
        return {"name": "daily_budget", "ok": None, "skipped": "задан настоящий ключ API, проверка не запускалась"}
    if BACKUP.exists():
        raise RuntimeError(f"{BACKUP} уже есть: прошлая проверка прервалась, верните .env вручную")

    original = Path(".env").read_bytes()
    original_sha = hashlib.sha256(original).hexdigest()
    spent_before, budget_before = spent_and_budget(board())
    text = "Проверка бюджета: сломался компрессор, звоните +7 916 222-33-44, почта budget.check@example.com"
    max_tokens = max(200, min(2000, round(float(env.get("LLM_MAX_TOKENS") or 600))))
    p_in = float(env.get("PRICE_INPUT_USD_PER_MTOK") or 1)
    p_out = float(env.get("PRICE_OUTPUT_USD_PER_MTOK") or 5)
    # резерв как в ноде «Подготовка» (+100 символов запаса на маскирование)
    reserve = 2 * ((900 + len(text) + 100) * p_in + max_tokens * p_out) / 1e6
    # бюджет: хватает ровно на одну заявку; после её расхода следующая не проходит
    small_budget = round((spent_before or 0) + reserve + 0.0005, 6)

    shutil.copy2(".env", BACKUP)
    os.chmod(BACKUP, 0o600)
    result = {"name": "daily_budget", "spent_before_usd": spent_before, "budget_before_usd": budget_before,
              "temporary_budget_usd": small_budget, "reserve_usd": round(reserve, 6)}
    try:
        tmp = set_env_lines(original.decode("utf-8"), {
            "ANTHROPIC_API_KEY": "fake-key-for-checks",
            "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{FAKE_PORT}",
            "DAILY_BUDGET_USD": f"{small_budget:.6f}",
        })
        Path(".env").write_text(tmp, encoding="utf-8")
        os.chmod(".env", 0o600)
        restart_and_wait("llm")
        sh(["docker", "compose", "exec", "-T", "n8n", "sh", "-c", "cat > /tmp/fake_anthropic.js"],
           stdin="tests/fake_anthropic.js")
        sh(["docker", "compose", "exec", "-d", "n8n", "sh", "-c",
            f"node /tmp/fake_anthropic.js {FAKE_PORT} > /tmp/fake_anthropic.log 2>&1"])
        for _ in range(20):
            if "fake anthropic on" in sh(["docker", "compose", "exec", "-T", "n8n", "cat", "/tmp/fake_anthropic.log"],
                                         check=False):
                break
            time.sleep(1)

        s1, b1, d1 = triage(text, token=token)
        s2, _, d2 = triage(text, token=token)
        spent_after, budget_shown = spent_and_budget(board())
        log = [json.loads(l) for l in sh(["docker", "compose", "exec", "-T", "n8n", "cat", "/tmp/fake_anthropic.log"],
                                         check=False).splitlines() if l.startswith("{")]
        meta = d1.get("meta") or {}
        checks = {
            "заявка 1 прошла через LLM-ветку (200, mode=llm)": s1 == 200 and d1.get("mode") == "llm",
            "расход заявки 1 посчитан по usage": abs((meta.get("cost_usd") or 0) - FAKE_COST) < 1e-6,
            "заявка 2 отклонена 429 daily_budget": s2 == 429 and d2.get("error") == "daily_budget",
            "токен прогонов бюджет не снимает": s2 == 429,
            "отказ вежливый, с суммами": "Дневной бюджет" in (d2.get("message") or ""),
            "в API ушёл ровно 1 запрос (отказ до вызова)": len(log) == 1,
            "в запросе к API нет телефона и email": bool(log) and not any(e.get("piiLike") for e in log),
            "запрос к API со схемой json_schema": bool(log) and all(e.get("schemaOk") for e in log),
            "доска показывает расход из бюджета": budget_shown is not None
                and abs(budget_shown - small_budget) < 1e-4 and spent_after is not None,
        }
        result.update({"ok": all(checks.values()), "checks": checks, "statuses": [s1, s2],
                       "cost_usd_request_1": meta.get("cost_usd"), "refusal_message": d2.get("message"),
                       "board_spent_after_usd": spent_after, "board_budget_usd": budget_shown,
                       "fake_api_log": log, "pii_leak_in_response": any(
                           pii_leaked(p, b1) for p in ("+7 916 222-33-44", "budget.check@example.com"))})
    finally:
        shutil.copy2(BACKUP, ".env")
        os.chmod(".env", 0o600)
        restored = hashlib.sha256(Path(".env").read_bytes()).hexdigest() == original_sha
        if restored:
            BACKUP.unlink()
        html = restart_and_wait("mock")
        result["restored"] = {"env_identical": restored, "board_mode": board_mode(html),
                              "board_budget_usd": spent_and_budget(html)[1]}
    if not result["restored"]["env_identical"]:
        result["ok"] = False
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-budget", action="store_true")
    args = ap.parse_args()
    env = read_env(".env")
    token = env.get("EVAL_BYPASS_TOKEN", "")
    started = dt.datetime.now(dt.timezone.utc)

    results = [check_xss(token), check_pii(token), check_rate_limit(env)]
    if not args.no_budget:
        results.append(check_budget(env, token))
    for r in results:
        mark = "ПРОПУЩЕНО" if r.get("ok") is None else ("ok" if r["ok"] else "ПРОВАЛ")
        print(f"{r['name']:<16} {mark}")
        for k, v in (r.get("checks") or {}).items():
            print(f"   {'+' if v else '-'} {k}")
    out = Path(__file__).resolve().parent / f"checks-{started:%Y-%m-%d}.json"
    out.write_text(json.dumps({"date_utc": started.strftime("%Y-%m-%d %H:%M"), "results": results},
                              ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("записано:", "evals/" + out.name)
    sys.exit(0 if all(r.get("ok") is not False for r in results) else 1)


if __name__ == "__main__":
    main()
