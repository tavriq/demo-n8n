#!/usr/bin/env python3
"""Проверки защиты на живом контуре. Запуск на сервере из каталога проекта
(нужны docker compose и .env):

  python3 evals/checks.py                # три фазы и проверка секретов
  python3 evals/checks.py --no-temp-env  # только фаза 1 на текущих настройках, .env не трогается

Фазы 1 и 2 проверяют контур, а не модель, поэтому идут на заглушке по ключевым словам
(временно TRIAGE_FORCE_MOCK=true): результат не зависит от ответа модели и не тратит токены.
Поведение модели (контакты в ответе, prompt injection) меряет evals/run.py.
Фаза 1 (TRUST_PROXY_HEADER как в .env, по умолчанию direct): XSS на доске, маскирование
контактов, файл 2 МБ в multipart получает 413, подделанный X-Real-IP не обходит лимит.
Фаза 2, временно TRUST_PROXY_HEADER=x-real-ip (как за nginx, который перезаписывает
заголовок): лимит заявок с адреса для API и для формы; форма: боты получают 401,
страница результата экранирована.
Фаза 3, временно тестовый ключ и адрес локальной заглушки OpenAI-совместимого API
(tests/fake_openai.js внутри контейнера): ветка LLM (HTTP 500, повтор после битого JSON,
заглушка после двух неудач, контакт в ответе модели), дневной лимит токенов, тестовый ключ
не попадает в sqlite и логи контейнера. Настоящий ключ из ../llm.env не используется:
.env подключён в compose после него и временно перекрывает ключ и адрес тестовыми.
Первой, до перезапусков (логи текущего контейнера, который обслуживал живые заявки):
настоящего ключа и адреса шлюза нет в sqlite n8n, в логах контейнера и в файлах проекта
(кроме .env).

.env возвращается байт в байт, n8n перезапускается. Секреты не печатаются
и не пишутся в результат. Пишет evals/checks-<дата>.json.
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run import http, pii_leaked, read_env  # noqa: E402

BASE = "http://127.0.0.1:18102"
FORM = BASE + "/form/triage-demo"
FAKE_PORT = 18999
BACKUP = Path(".env.checks-backup")
SHARED_LLM_ENV = Path("../llm.env")  # общий файл ключа LLM, см. docker-compose.yml
FAKE_IN, FAKE_OUT = 812, 95  # usage, который отдаёт tests/fake_openai.js на каждый ответ 200
FAKE_CALL = FAKE_IN + FAKE_OUT
UA_BROWSER = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
UA_CURL = "curl/8.5.0"


def triage(text, token=None, ip=None):
    h = {"Content-Type": "application/json"}
    if token:
        h["X-Eval-Token"] = token
    if ip:
        h["X-Real-IP"] = ip
    status, body, _ = http("POST", BASE + "/webhook/triage", {"text": text}, h)
    try:
        d = json.loads(body)
    except ValueError:
        d = {}
    return status, body, d


def raw(url, data=None, headers=None, method=None):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def board():
    return raw(BASE + "/webhook/board")[1]


def form_submit(text, ip=None, ua=UA_BROWSER):
    """POST формы как браузер. Возвращает (HTTP-код POST, HTML страницы результата или None)."""
    boundary = "----checks" + secrets.token_hex(8)
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"field-0\"\r\n\r\n{text}\r\n"
            f"--{boundary}--\r\n").encode()
    h = {"Content-Type": f"multipart/form-data; boundary={boundary}", "User-Agent": ua}
    if ip:
        h["X-Real-IP"] = ip
    status, resp = raw(FORM, data=body, headers=h, method="POST")
    if status != 200:
        return status, None
    url = json.loads(resp).get("formWaitingUrl") or ""
    # ссылка собрана из WEBHOOK_URL (адрес туннеля), на сервере это тот же n8n
    url = re.sub(r"^https?://[^/]+", BASE, url)
    path, _, query = url.partition("?")
    for _ in range(60):
        if raw(f"{path}/n8n-execution-status?{query}", headers={"User-Agent": ua})[1].strip() == "form-waiting":
            break
        time.sleep(0.5)
    return status, raw(url, headers={"User-Agent": ua})[1]


def tokens_and_budget(html):
    m = re.search(r"Токенов сегодня:\s*<b>([\d\u00a0 ]+)</b>\s*из\s*([\d\u00a0 ]+)", html)
    if not m:
        return None, None
    num = lambda x: int(re.sub(r"\D", "", x))  # noqa: E731
    return num(m.group(1)), num(m.group(2))


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


def memory():
    """Память контейнера n8n (только нашего, по id из compose)."""
    cid = sh(["docker", "compose", "ps", "-q", "n8n"]).strip()
    return sh(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", cid]).strip() if cid else None


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


@contextlib.contextmanager
def env_session(back_mode, report):
    """Даёт apply(values, expect_mode): записать в .env исходные строки с заменой values
    и перезапустить n8n. В finally .env возвращается байт в байт, n8n перезапускается."""
    if BACKUP.exists():
        raise RuntimeError(f"{BACKUP} уже есть: прошлая проверка прервалась, верните .env вручную")
    original = Path(".env").read_bytes()
    original_sha = hashlib.sha256(original).hexdigest()
    shutil.copy2(".env", BACKUP)
    os.chmod(BACKUP, 0o600)
    changed = set()

    def apply(values, expect_mode):
        changed.update(values)
        Path(".env").write_text(set_env_lines(original.decode("utf-8"), values), encoding="utf-8")
        os.chmod(".env", 0o600)
        restart_and_wait(expect_mode)

    try:
        yield apply
    finally:
        shutil.copy2(BACKUP, ".env")
        os.chmod(".env", 0o600)
        restored = hashlib.sha256(Path(".env").read_bytes()).hexdigest() == original_sha
        if restored:
            BACKUP.unlink()
        html = restart_and_wait(back_mode)
        report.append({"env_keys_changed": sorted(changed), "env_identical": restored,
                       "board_mode": board_mode(html)})


# ---------- фаза 1: заглушка, TRUST_PROXY_HEADER из .env ----------

def check_xss(token):
    payload = ('Нужен монтаж кондиционера в офисе в Казани в пятницу. Комментарий: <script>alert("xss")</script> '
               '<img src=x onerror=alert(1)> "кавычки" & \'апостроф\'')
    status, _, d = triage(payload, token=token)
    html = board()
    checks = {
        "заявка принята (200)": status == 200 and d.get("ok") is True,
        "на доске нет тегов <script>": "<script" not in html.lower(),
        "на доске нет тега <img>": "<img" not in html.lower(),
        "текст на доске экранирован": "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;" in html,
        "&lt;img … onerror экранирован": "&lt;img src=x onerror=alert(1)&gt;" in html,
        "CSP в meta: default-src 'none'": "default-src 'none'" in html,
    }
    return {"name": "xss_board", "ok": all(checks.values()), "checks": checks}


def check_pii(token):
    items = ["+7 916 123-45-67", "(495)765-43-21", "test.user@example.com", "иван@почта.рф",
             "@check_user_01", "t.me/check_user_02"]
    text = (f"Нужна аренда генератора на выходные. Звоните {items[0]} или {items[1]}, почта {items[2]} "
            f"или {items[3]}, тг {items[4]}, {items[5]}")
    status, body, d = triage(text, token=token)
    html = board()
    meta = d.get("meta") or {}
    checks = {
        "заявка принята (200)": status == 200 and d.get("ok") is True,
        f"найдено и скрыто {len(items)} контактов": meta.get("pii_masked") == len(items),
        "в ответе (и сохранённом тексте) контактов нет": not any(pii_leaked(p, body) for p in items),
        "на доске контактов нет": not any(pii_leaked(p, html) for p in items),
        "на доске метки телефона, email, ника и ссылки":
            all(m in html for m in ("[телефон скрыт]", "[email скрыт]", "[ник скрыт]", "[ссылка скрыта]")),
    }
    return {"name": "pii_masking", "ok": all(checks.values()), "checks": checks,
            "text_masked": meta.get("text_masked")}


def check_spoofed_ip(env):
    """При TRUST_PROXY_HEADER=direct заголовок X-Real-IP игнорируется: смена его значения
    не даёт новых заявок сверх лимита."""
    limit = int(float(env.get("RATE_LIMIT_PER_IP_HOUR") or 5))
    seq = []
    last = {}
    for i in range(limit + 1):
        status, _, d = triage(f"Проверка подделки адреса {i + 1}: нужен монтаж стеллажей", ip=f"192.0.2.{i + 1}")
        seq.append(status)
        last = d
        if status == 429:
            break
        time.sleep(0.3)
    checks = {
        "TRUST_PROXY_HEADER=direct (по умолчанию)": (env.get("TRUST_PROXY_HEADER") or "direct") == "direct",
        f"429 rate_limited_ip не позже заявки №{limit + 1}, хотя у каждой свой X-Real-IP":
            seq[-1] == 429 and last.get("error") == "rate_limited_ip" and len(seq) <= limit + 1,
    }
    return {"name": "spoofed_x_real_ip", "ok": all(checks.values()), "checks": checks, "statuses": seq,
            "note": "заявок до отказа меньше лимита, если ключ direct уже частично выбран за последний час"}


def check_multipart_limit():
    """multipart/form-data разбирается отдельно от JSON: файл больше
    N8N_FORMDATA_FILE_SIZE_MAX (1 МБ) должен получить 413 до запуска воркфлоу."""
    boundary = "----checks" + secrets.token_hex(8)
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"big.bin\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + os.urandom(2 * 1024 * 1024) + \
        f"\r\n--{boundary}--\r\n".encode()
    status, resp = raw(BASE + "/webhook/triage", data=body, method="POST",
                       headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    checks = {"файл 2 МБ в multipart на /webhook/triage: 413": status == 413}
    return {"name": "multipart_limit", "ok": all(checks.values()), "checks": checks, "status": status,
            "response": resp[:200]}


# ---------- фаза 2: TRUST_PROXY_HEADER=x-real-ip ----------

def check_rate_limit_ip(env):
    limit = int(float(env.get("RATE_LIMIT_PER_IP_HOUR") or 5))
    # адреса из TEST-NET-2 (RFC 5737): как будто их поставил обратный прокси в X-Real-IP
    ip = f"198.51.100.{random.randint(1, 254)}"
    other = f"198.51.100.{(int(ip.rsplit('.', 1)[1]) % 254) + 1}"
    seq, last = [], {}
    for i in range(limit + 1):
        status, _, d = triage(f"Проверка лимита {i + 1}: нужен монтаж стеллажей", ip=ip)
        seq.append(status)
        last = d
        time.sleep(0.3)
    status_other, _, _ = triage("Проверка лимита: заявка с другого адреса, нужна аренда пылесоса", ip=other)
    checks = {
        f"API: первые {limit} заявок с адреса приняты": seq[:limit] == [200] * limit,
        f"API: заявка №{limit + 1} отклонена 429 rate_limited_ip": seq[limit] == 429 and last.get("error") == "rate_limited_ip",
        "отказ вежливый и объясняет лимит": "не больше" in (last.get("message") or ""),
        "API: другой адрес не затронут (200)": status_other == 200,
    }
    return {"name": "rate_limit_ip_api", "ok": all(checks.values()), "checks": checks,
            "limit_per_hour": limit, "statuses": seq + [status_other], "refusal_message": last.get("message")}


def check_form(env):
    limit = int(float(env.get("RATE_LIMIT_PER_IP_HOUR") or 5))
    ip = f"203.0.113.{random.randint(1, 254)}"
    other = f"203.0.113.{(int(ip.rsplit('.', 1)[1]) % 254) + 1}"
    get_curl = raw(FORM, headers={"User-Agent": UA_CURL})[0]
    post_curl, _ = form_submit("Проверка формы от бота: нужен монтаж", ip=ip, ua=UA_CURL)
    get_browser, page_form = raw(FORM, headers={"User-Agent": UA_BROWSER})
    text = '<b>жирный</b> & "кавычки" — проверка формы: нужен монтаж стеллажей в Казани, звоните 8 916 555-44-33'
    pages = []
    for i in range(limit + 1):
        st, page = form_submit(text if i == 0 else f"Проверка лимита формы {i + 1}: нужен монтаж стеллажей", ip=ip)
        pages.append((st, page or ""))
    st_other, page_other = form_submit("Проверка формы с другого адреса: нужна аренда пылесоса", ip=other)
    first, last = pages[0][1], pages[-1][1]
    checks = {
        "GET формы с User-Agent curl: 401": get_curl == 401,
        "POST формы с User-Agent curl: 401, заявка не создаётся": post_curl == 401,
        "GET формы из браузера: 200 и предупреждение про персональные данные":
            get_browser == 200 and "Не вводите персональные данные" in page_form,
        "страница результата: «Заявка разобрана»": "Заявка разобрана" in first,
        "страница результата: HTML из заявки показан текстом": "&lt;b&gt;жирный&lt;/b&gt;" in first and "<b>жирный" not in first,
        "страница результата: нет двойного экранирования": "&amp;lt;" not in first,
        "страница результата: телефон скрыт": not pii_leaked("8 916 555-44-33", first),
        f"форма: заявки 1–{limit} с адреса приняты": all(st == 200 and "Заявка разобрана" in p for st, p in pages[:limit]),
        f"форма: заявка №{limit + 1} с того же адреса — отказ про лимит": "Заявка не принята" in last and "не больше" in last,
        "форма: другой адрес принят": st_other == 200 and "Заявка разобрана" in (page_other or ""),
    }
    m = re.search(r"Категория:[^<]*", first)
    return {"name": "form", "ok": all(checks.values()), "checks": checks,
            "result_page_excerpt": m.group(0)[:400] if m else None}


# ---------- фаза 3: заглушка OpenAI-совместимого API ----------

def check_llm_branch(env, token, tokens_before, apply):
    fake_key = "fake-key-" + secrets.token_hex(8)
    texts = {
        "http500": "Проверка LLM-ветки FAKE_HTTP_500: нужен монтаж стеллажей",
        "pii_output": "Проверка LLM-ветки FAKE_PII_OUTPUT: сломался компрессор, звоните +7 916 222-33-44, "
                      "почта budget.check@example.com",
        "invalid_once": "Проверка LLM-ветки FAKE_INVALID_ONCE: нужна аренда пылесоса",
        "invalid_always": "Проверка LLM-ветки FAKE_INVALID_ALWAYS: нужен монтаж кондиционера",
        "budget": "Проверка бюджета: нужен монтаж домофона",
    }
    max_tokens = max(200, min(2000, round(float(env.get("LLM_MAX_TOKENS") or 600))))
    # резерв как в ноде «Подготовка» (+100 символов запаса на маскирование)
    reserve = max(2 * (900 + len(t) + 100 + max_tokens) for t in texts.values())
    # лимит: хватает на сценарии до «invalid_always» включительно (5 ответов заглушки
    # по FAKE_CALL токенов), после них остатка меньше резерва, и заявка «budget» получает 429
    budget = (tokens_before or 0) + 4 * FAKE_CALL + reserve
    started = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    result = {"name": "llm_branch_and_budget", "tokens_before": tokens_before,
              "temporary_token_budget": budget, "reserve_tokens": reserve}
    apply({"LLM_API_KEY": fake_key, "LLM_BASE_URL": f"http://127.0.0.1:{FAKE_PORT}/v1",
           "LLM_MODEL": "fake-model", "LLM_REASONING_EFFORT": "", "TRIAGE_FORCE_MOCK": "false",
           "DAILY_TOKEN_BUDGET": str(budget)}, "llm")
    sh(["docker", "compose", "exec", "-T", "n8n", "sh", "-c", "cat > /tmp/fake_openai.js"],
       stdin="tests/fake_openai.js")
    sh(["docker", "compose", "exec", "-d", "n8n", "sh", "-c",
        f"node /tmp/fake_openai.js {FAKE_PORT} > /tmp/fake_openai.log 2>&1"])
    for _ in range(20):
        if "fake openai on" in sh(["docker", "compose", "exec", "-T", "n8n", "cat", "/tmp/fake_openai.log"],
                                  check=False):
            break
        time.sleep(1)
    out = {}
    for key, text in texts.items():
        status, body, d = triage(text, token=token)
        out[key] = (status, body, d)
    tokens_after, budget_shown = tokens_and_budget(board())
    log = [json.loads(l) for l in sh(["docker", "compose", "exec", "-T", "n8n", "cat", "/tmp/fake_openai.log"],
                                     check=False).splitlines() if l.startswith("{")]
    # тестовый ключ не должен оказаться в базе n8n и в логах контейнера
    in_db = secret_in_sqlite(fake_key)
    in_logs = fake_key in sh(["docker", "compose", "logs", "--no-color", "--since", started, "n8n"], check=False)
    fake_sha = hashlib.sha256(fake_key.encode()).hexdigest()[:12]

    def res(k):
        return (out[k][2].get("result") or {}), (out[k][2].get("meta") or {})

    r500, m500 = res("http500")
    rpii, mpii = res("pii_output")
    rone, mone = res("invalid_once")
    rall, mall = res("invalid_always")
    s_b, _, d_b = out["budget"]
    pii_text = json.dumps(rpii, ensure_ascii=False)
    checks = {
        "HTTP 500 дважды → 200, mode=llm_fallback, needs_human, category=other, 0 токенов":
            out["http500"][0] == 200 and out["http500"][2].get("mode") == "llm_fallback"
            and r500.get("needs_human") is True and r500.get("category") == "other"
            and m500.get("tokens_in") == 0 and m500.get("tokens_out") == 0,
        "контакт в ответе модели скрыт (summary, next_step)":
            "[телефон скрыт]" in pii_text and not any(pii_leaked(p, pii_text) for p in
                                                      ("+7 916 123 45 67", "8 916 123-45-67", "ivan.petrov@mail.ru")),
        "контакт в ответе модели → needs_human=true": rpii.get("needs_human") is True,
        "контакты входа и выхода посчитаны (pii_masked > 2)": (mpii.get("pii_masked") or 0) > 2,
        "токены посчитаны по usage (prompt_tokens, completion_tokens)":
            mpii.get("tokens_in") == FAKE_IN and mpii.get("tokens_out") == FAKE_OUT,
        "битый JSON один раз → повтор, mode=llm, attempts=2, токены обеих попыток":
            out["invalid_once"][2].get("mode") == "llm" and mone.get("attempts") == 2
            and mone.get("tokens_in") == 2 * FAKE_IN and mone.get("tokens_out") == 2 * FAKE_OUT,
        "битый JSON дважды → mode=llm_fallback, needs_human, category=other":
            out["invalid_always"][2].get("mode") == "llm_fallback" and rall.get("needs_human") is True
            and rall.get("category") == "other",
        "лимит токенов: следующая заявка 429 daily_budget (токен прогонов лимит не снимает)":
            s_b == 429 and d_b.get("error") == "daily_budget",
        "отказ вежливый, с числами": "Дневной лимит токенов" in (d_b.get("message") or ""),
        "в API ушло 7 запросов (2+1+2+2, отказ по бюджету — до вызова)": len(log) == 7,
        "3 повторных запроса (после 500, битого JSON, снова битого) содержат список ошибок":
            sum(1 for e in log if e.get("retry")) == 3,
        "в запросах к API нет телефона и email": bool(log) and not any(e.get("piiLike") for e in log),
        "запросы в /chat/completions, схема json_schema strict, ключ в Authorization: Bearer":
            bool(log) and all(str(e.get("path", "")).endswith("/chat/completions") and e.get("schemaOk")
                              and e.get("headerOk") for e in log),
        "в заглушку пришёл тестовый ключ, а не настоящий": bool(log) and all(e.get("keySha") == fake_sha for e in log),
        "доска показывает временный лимит токенов": budget_shown == budget,
        "тестового ключа нет в sqlite n8n": not in_db,
        "тестового ключа нет в логах контейнера": not in_logs,
    }
    result.update({
        "ok": all(checks.values()),
        "checks": checks,
        "statuses": {k: v[0] for k, v in out.items()},
        "modes": {k: v[2].get("mode") for k, v in out.items()},
        "attempts": {k: (v[2].get("meta") or {}).get("attempts") for k, v in out.items()},
        "tokens": {k: [(v[2].get("meta") or {}).get("tokens_in"), (v[2].get("meta") or {}).get("tokens_out")]
                   for k, v in out.items()},
        "pii_output_result": {"summary": rpii.get("summary"), "next_step": rpii.get("next_step"),
                              "pii_masked": mpii.get("pii_masked")},
        "refusal_message": d_b.get("message"),
        "board_tokens_after": tokens_after,
        "fake_api_log": log,
    })
    return result


# ---------- секреты: до перезапусков ----------

def read_secret_values():
    """Настоящие ключ и адрес шлюза: из .env, если заданы там, иначе из ../llm.env."""
    shared = read_env(SHARED_LLM_ENV) if SHARED_LLM_ENV.exists() else {}
    local = read_env(".env")
    out = {}
    for k in ("LLM_API_KEY", "LLM_BASE_URL"):
        v = (local.get(k) or shared.get(k) or "").strip().strip('"').strip("'")
        if v:
            out[k] = v
    return out


def secret_in_sqlite(value):
    mp = sh(["docker", "volume", "inspect", "demo-n8n_n8n_data", "-f", "{{.Mountpoint}}"]).strip()
    b = value.encode()
    return any(b in p.read_bytes() for p in Path(mp).glob("database.sqlite*") if p.is_file())


def check_secrets_at_rest():
    """Ключ и адрес шлюза есть только в env контейнера: в базе n8n, логах и файлах проекта
    их быть не должно. Печатаются только да/нет."""
    secrets_ = read_secret_values()
    if "LLM_API_KEY" not in secrets_:
        return {"name": "secrets_at_rest", "ok": None, "skipped": "ключ LLM не задан"}
    logs = sh(["docker", "compose", "logs", "--no-color", "n8n"], check=False)
    skip = {".env", BACKUP.name}
    files = [p for p in Path(".").rglob("*")
             if p.is_file() and p.name not in skip and ".git" not in p.parts]
    checks = {}
    for k, v in secrets_.items():
        b = v.encode()
        checks[f"{k}: нет в sqlite n8n"] = not secret_in_sqlite(v)
        checks[f"{k}: нет в логах контейнера"] = v not in logs
        checks[f"{k}: нет в файлах проекта (кроме .env)"] = not any(b in p.read_bytes() for p in files)
    return {"name": "secrets_at_rest", "ok": all(checks.values()), "checks": checks, "files_scanned": len(files)}


def guarded(fn, *args):
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001 — проверка падает, но остальные идут, .env восстановлен в finally
        return {"name": fn.__name__.replace("check_", ""), "ok": False, "error": f"{type(e).__name__}: {e}"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-temp-env", action="store_true", help="только фаза 1 на текущих настройках, .env не меняется")
    args = ap.parse_args()
    env = read_env(".env")
    token = env.get("EVAL_BYPASS_TOKEN", "")
    started = dt.datetime.now(dt.timezone.utc)
    mem_before = memory()
    mode_now = board_mode(board())

    def phase1():
        return [guarded(check_xss, token), guarded(check_pii, token), guarded(check_multipart_limit),
                guarded(check_spoofed_ip, env)]

    # до перезапусков: логи текущего контейнера при пересоздании пропадут
    results = [guarded(check_secrets_at_rest)]
    if args.no_temp_env:
        if mode_now == "llm":
            print("внимание: режим LLM, карточка XSS-заявки может быть скрыта модерацией доски", file=sys.stderr)
        results += phase1()
    else:
        report = []
        try:
            with env_session(mode_now, report) as apply:
                apply({"TRIAGE_FORCE_MOCK": "true"}, "mock")
                results += phase1()
                apply({"TRIAGE_FORCE_MOCK": "true", "TRUST_PROXY_HEADER": "x-real-ip"}, "mock")
                results.append(guarded(check_rate_limit_ip, env))
                results.append(guarded(check_form, env))
                results.append(guarded(check_llm_branch, env, token, tokens_and_budget(board())[0], apply))
        except Exception as e:  # noqa: BLE001
            results.append({"name": "temp_env", "ok": False, "error": f"{type(e).__name__}: {e}"})
        results.append({"name": "env_restored", "ok": bool(report) and all(r["env_identical"] for r in report)
                        and report[0]["board_mode"] == mode_now, "restored": report})
    mem_after = memory()

    for r in results:
        mark = "ПРОПУЩЕНО" if r.get("ok") is None else ("ok" if r["ok"] else "ПРОВАЛ")
        print(f"{r['name']:<24} {mark}" + (f"  {r['error']}" if r.get("error") else ""))
        for k, v in (r.get("checks") or {}).items():
            print(f"   {'+' if v else '-'} {k}")
    out = Path(__file__).resolve().parent / f"checks-{started:%Y-%m-%d}.json"
    out.write_text(json.dumps({"date_utc": started.strftime("%Y-%m-%d %H:%M"), "n8n_mode_at_start": mode_now,
                               "memory_n8n": {"before": mem_before, "after": mem_after},
                               "results": results}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("память n8n:", mem_before, "→", mem_after)
    print("записано:", "evals/" + out.name)
    sys.exit(0 if all(r.get("ok") is not False for r in results) else 1)


if __name__ == "__main__":
    main()
