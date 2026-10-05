#!/usr/bin/env python3
"""Собирает workflows/*.json из src/: JS Code-нод лежит в отдельных файлах,
общие функции (src/lib) подклеиваются в начало каждой Code-ноды.

  python3 scripts/build_workflows.py          # записать workflows/*.json
  python3 scripts/build_workflows.py --check  # упасть, если JSON устарел
"""
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
OUT = ROOT / "workflows"

CORE_ID = "triageCoreFlow01"
ENTRY_ID = "triageEntryFlow1"
BOARD_ID = "triageBoardFlow1"
TABLE = "triage_log"

# колонки журнала: имя -> тип Data Table
COLUMNS = [
    ("ts", "number"), ("day", "string"), ("created_at", "string"), ("source", "string"),
    ("client_key", "string"), ("text_masked", "string"), ("pii_masked", "number"),
    ("category", "string"), ("urgency", "string"), ("city", "string"), ("budget_rub", "number"),
    ("summary", "string"), ("next_step", "string"), ("needs_human", "boolean"),
    ("confidence", "number"), ("mode", "string"), ("attempts", "number"),
    ("cost_usd", "number"), ("model", "string"), ("llm_error", "string"),
]

NS = uuid.UUID("6f1c2a52-0f7e-4d8a-9a51-3c1d2b7e9f00")


def uid(*parts):
    """Стабильный UUID: повторная сборка не меняет JSON."""
    return str(uuid.uuid5(NS, "/".join(parts)))


def js(node_file, libs):
    head = "\n".join((SRC / "lib" / f"{name}.js").read_text().rstrip() for name in libs)
    body = (SRC / "nodes" / node_file).read_text().rstrip()
    return f"{head}\n\n// ---- нода ----\n{body}\n" if head else body + "\n"


def node(wf, name, ntype, version, pos, params, **extra):
    n = {
        "id": uid(wf, name),
        "name": name,
        "type": ntype,
        "typeVersion": version,
        "position": list(pos),
        "parameters": params,
    }
    n.update(extra)
    return n


def code(wf, name, pos, node_file, libs=()):
    return node(wf, name, "n8n-nodes-base.code", 2, pos, {"jsCode": js(node_file, libs)})


def cond(wf, name, left, op_type, operation, right=None):
    c = {
        "id": uid(wf, name, "cond"),
        "leftValue": left,
        "rightValue": "" if right is None else right,
        "operator": {"type": op_type, "operation": operation},
    }
    if right is None:
        c["operator"]["singleValue"] = True
    return c


def if_node(wf, name, pos, left, op_type, operation, right=None):
    return node(wf, name, "n8n-nodes-base.if", 2.2, pos, {
        "conditions": {
            "options": {"caseSensitive": True, "leftValue": "", "typeValidation": "strict", "version": 2},
            "conditions": [cond(wf, name, left, op_type, operation, right)],
            "combinator": "and",
        },
        "options": {},
    })


def table_ref():
    return {"__rl": True, "mode": "name", "value": TABLE}


def ensure_table(wf, pos):
    return node(wf, "Таблица: создать, если нет", "n8n-nodes-base.dataTable", 1.1, pos, {
        "resource": "table",
        "operation": "create",
        "tableName": TABLE,
        "columns": {"column": [{"name": n, "type": t} for n, t in COLUMNS]},
        "options": {"createIfNotExists": True},
    }, executeOnce=True)


def connect(conns, src, dst, out=0):
    outs = conns.setdefault(src, {"main": []})["main"]
    while len(outs) <= out:
        outs.append([])
    outs[out].append({"node": dst, "type": "main", "index": 0})


SETTINGS = {
    "executionOrder": "v1",
    "timezone": "Europe/Moscow",
    # в истории исполнений n8n только ошибки: успешные заявки не дублируются
    # туда вместе с исходным (немаскированным) текстом
    "saveDataSuccessExecution": "none",
    "saveDataErrorExecution": "all",
    "saveManualExecutions": True,
    "saveExecutionProgress": False,
    "callerPolicy": "workflowsFromSameOwner",
}


def workflow(wid, name, nodes, conns, description):
    return {
        "id": wid,
        "name": name,
        "description": description,
        "active": False,
        "nodes": nodes,
        "connections": conns,
        "settings": dict(SETTINGS),
        "pinData": {},
        "meta": {"templateCredsSetupCompleted": True},
        "tags": [],
    }


def llm_http(wf, name, pos):
    return node(wf, name, "n8n-nodes-base.httpRequest", 4.2, pos, {
        "method": "POST",
        "url": "={{ ($env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\\/+$/, '') + '/v1/messages' }}",
        "sendHeaders": True,
        "headerParameters": {"parameters": [
            {"name": "x-api-key", "value": "={{ $env.ANTHROPIC_API_KEY }}"},
            {"name": "anthropic-version", "value": "2023-06-01"},
        ]},
        "sendBody": True,
        "specifyBody": "json",
        "jsonBody": "={{ JSON.stringify($json.llm_body) }}",
        "options": {
            "timeout": 30000,
            "response": {"response": {"fullResponse": True, "neverError": True}},
        },
    }, onError="continueRegularOutput")


def build_core():
    wf = "core"
    nodes = [
        node(wf, "Вызов из точки входа", "n8n-nodes-base.executeWorkflowTrigger", 1.1, (0, 300),
             {"inputSource": "passthrough"}),
        code(wf, "Подготовка", (220, 300), "prepare.js", ["pii", "triage"]),
        ensure_table(wf, (440, 300)),
        node(wf, "Журнал за 24 часа", "n8n-nodes-base.dataTable", 1.1, (660, 300), {
            "resource": "row",
            "operation": "get",
            "dataTableId": table_ref(),
            "matchType": "allConditions",
            "filters": {"conditions": [{
                "keyName": "ts", "condition": "gte",
                "keyValue": "={{ $('Подготовка').first().json.now_ms - 86400000 }}",
            }]},
            "returnAll": True,
        }, alwaysOutputData=True, executeOnce=True),
        code(wf, "Cost guard", (880, 300), "guard.js"),
        if_node(wf, "Разрешено?", (1100, 300), "={{ $json.allowed }}", "boolean", "true"),
        code(wf, "Отказ", (1320, 520), "refuse.js", ["html"]),
        if_node(wf, "Есть ключ API?", (1320, 200), "={{ $json.mode }}", "string", "equals", "llm"),
        code(wf, "Mock-классификатор", (1540, 360), "mock.js", ["mock"]),
        llm_http(wf, "Claude API #1", (1540, 100)),
        code(wf, "Проверка ответа #1", (1760, 100), "check1.js", ["triage"]),
        if_node(wf, "Ответ валиден?", (1980, 100), "={{ $json.valid }}", "boolean", "true"),
        llm_http(wf, "Claude API #2 (повтор)", (2200, 0)),
        code(wf, "Проверка ответа #2", (2420, 0), "check2.js", ["triage"]),
        code(wf, "Итог", (2640, 300), "final.js"),
        if_node(wf, "Нужен человек или срочно?", (2860, 140),
                "={{ $json.needs_human === true || $json.urgency === 'high' }}", "boolean", "true"),
        node(wf, "Telegram менеджеру", "n8n-nodes-base.telegram", 1.2, (3080, 140), {
            "chatId": "={{ $env.TELEGRAM_CHAT_ID }}",
            "text": "={{ 'Заявка: ' + $json.category + ', срочность ' + $json.urgency + '\\n' + $json.summary + '\\nДальше: ' + $json.next_step }}",
            "additionalFields": {"appendAttribution": False},
        }, disabled=True, notes="Выключено: включить после добавления credential Telegram Bot API и TELEGRAM_CHAT_ID в .env"),
        node(wf, "Журнал: записать", "n8n-nodes-base.dataTable", 1.1, (2860, 400), {
            "resource": "row",
            "operation": "insert",
            "dataTableId": table_ref(),
            "columns": {
                "mappingMode": "autoMapInputData",
                "value": {},
                "matchingColumns": [],
                "schema": [],
                "attemptToConvertTypes": False,
                "convertFieldsToString": False,
            },
            "options": {},
        }),
        code(wf, "Ответ: результат", (3080, 400), "respond.js", ["html"]),
    ]
    c = {}
    connect(c, "Вызов из точки входа", "Подготовка")
    connect(c, "Подготовка", "Таблица: создать, если нет")
    connect(c, "Таблица: создать, если нет", "Журнал за 24 часа")
    connect(c, "Журнал за 24 часа", "Cost guard")
    connect(c, "Cost guard", "Разрешено?")
    connect(c, "Разрешено?", "Есть ключ API?", 0)
    connect(c, "Разрешено?", "Отказ", 1)
    connect(c, "Есть ключ API?", "Claude API #1", 0)
    connect(c, "Есть ключ API?", "Mock-классификатор", 1)
    connect(c, "Claude API #1", "Проверка ответа #1")
    connect(c, "Проверка ответа #1", "Ответ валиден?")
    connect(c, "Ответ валиден?", "Итог", 0)
    connect(c, "Ответ валиден?", "Claude API #2 (повтор)", 1)
    connect(c, "Claude API #2 (повтор)", "Проверка ответа #2")
    connect(c, "Проверка ответа #2", "Итог")
    connect(c, "Mock-классификатор", "Итог")
    # ветка уведомления выше ветки ответа: в порядке v1 она исполняется первой,
    # а последней нодой остаётся «Ответ: результат» — его данные вернутся вызывающему
    connect(c, "Итог", "Нужен человек или срочно?")
    connect(c, "Нужен человек или срочно?", "Telegram менеджеру", 0)
    connect(c, "Итог", "Журнал: записать")
    connect(c, "Журнал: записать", "Ответ: результат")
    return workflow(CORE_ID, "Триаж: ядро (LLM, cost guard, журнал)", nodes, c,
                    "Маскирование, лимиты, Claude Haiku 4.5 или mock, валидация, запись в Data Table.")


def build_entry():
    wf = "entry"
    exec_params = {
        "workflowId": {"__rl": True, "mode": "id", "value": CORE_ID},
        "workflowInputs": {"mappingMode": "defineBelow", "value": {}, "matchingColumns": [], "schema": [],
                           "attemptToConvertTypes": False, "convertFieldsToString": True},
        "options": {"waitForSubWorkflow": True},
    }
    nodes = [
        node(wf, "Webhook POST /triage", "n8n-nodes-base.webhook", 2.1, (0, 0), {
            "httpMethod": "POST",
            "path": "triage",
            "responseMode": "responseNode",
            "options": {},
        }, webhookId=uid(wf, "webhook-triage")),
        node(wf, "Разбор (API)", "n8n-nodes-base.executeWorkflow", 1.2, (240, 0), exec_params),
        node(wf, "Ответ API", "n8n-nodes-base.respondToWebhook", 1.4, (480, 0), {
            "respondWith": "json",
            "responseBody": "={{ JSON.stringify($json.response) }}",
            "options": {
                "responseCode": "={{ $json.http_status }}",
                "responseHeaders": {"entries": [{"name": "Cache-Control", "value": "no-store"}]},
            },
        }),
        node(wf, "Форма заявки", "n8n-nodes-base.formTrigger", 2.5, (0, 260), {
            "formTitle": "Заявка в сервисную компанию (демо)",
            "formDescription": (
                "Опишите задачу: ремонт или аренда оборудования, уборка, вопрос. "
                "Заявку разберёт n8n + LLM и покажет результат.\n\n"
                "Не вводите персональные данные: имя, телефон, email, адрес. "
                "Всё, что вы напишете, видно на публичной доске. "
                "Если контакты всё же попадут в текст, они будут замаскированы."
            ),
            "formFields": {"values": [{
                "fieldName": "text",
                "fieldLabel": "Текст заявки (до 1000 символов)",
                "fieldType": "textarea",
                "placeholder": "Например: сломался генератор на складе в Казани, нужен мастер сегодня",
                "requiredField": True,
            }]},
            "responseMode": "lastNode",
            "options": {
                "path": "triage-demo",
                "buttonLabel": "Разобрать заявку",
                "appendAttribution": False,
                "ignoreBots": True,
                "showHeaders": True,
            },
        }, webhookId=uid(wf, "form-triage")),
        node(wf, "Разбор (форма)", "n8n-nodes-base.executeWorkflow", 1.2, (240, 260), exec_params),
        node(wf, "Ответ формы", "n8n-nodes-base.form", 2.3, (480, 260), {
            "operation": "completion",
            "respondWith": "text",
            "completionTitle": "={{ $json.form_title }}",
            "completionMessage": "={{ $json.form_message }}",
            # если страница результата так и не открылась, исполнение не висит
            # в «waiting» вечно (с исходным текстом внутри), а закрывается через 10 минут
            "limitWaitTime": True,
            "limitType": "afterTimeInterval",
            "resumeAmount": 10,
            "resumeUnit": "minutes",
            "options": {"appendAttribution": False},
        }, webhookId=uid(wf, "form-completion")),
    ]
    c = {}
    connect(c, "Webhook POST /triage", "Разбор (API)")
    connect(c, "Разбор (API)", "Ответ API")
    connect(c, "Форма заявки", "Разбор (форма)")
    connect(c, "Разбор (форма)", "Ответ формы")
    return workflow(ENTRY_ID, "Триаж: вход (вебхук и форма)", nodes, c,
                    "POST /webhook/triage {\"text\": ...} и форма /form/triage-demo; разбор в под-воркфлоу ядра.")


def build_board():
    wf = "board"
    nodes = [
        node(wf, "Webhook GET /board", "n8n-nodes-base.webhook", 2.1, (0, 0), {
            "path": "board",
            "responseMode": "responseNode",
            "options": {},
        }, webhookId=uid(wf, "webhook-board")),
        ensure_table(wf, (220, 0)),
        node(wf, "Последние 20", "n8n-nodes-base.dataTable", 1.1, (440, 0), {
            "resource": "row",
            "operation": "get",
            "dataTableId": table_ref(),
            "limit": 20,
            "orderBy": True,
            "orderByColumn": "ts",
            "orderByDirection": "DESC",
        }, alwaysOutputData=True, executeOnce=True),
        node(wf, "Расход за сегодня", "n8n-nodes-base.dataTable", 1.1, (660, 0), {
            "resource": "row",
            "operation": "get",
            "dataTableId": table_ref(),
            "matchType": "allConditions",
            "filters": {"conditions": [{
                "keyName": "day", "condition": "eq", "keyValue": "={{ $now.toFormat('yyyy-MM-dd') }}",
            }]},
            "returnAll": True,
        }, alwaysOutputData=True, executeOnce=True),
        code(wf, "HTML доски", (880, 0), "board.js", ["html"]),
        node(wf, "Ответ: HTML", "n8n-nodes-base.respondToWebhook", 1.4, (1100, 0), {
            "respondWith": "text",
            "responseBody": "={{ $json.html }}",
            "options": {"responseHeaders": {"entries": [
                {"name": "Content-Type", "value": "text/html; charset=utf-8"},
                {"name": "Cache-Control", "value": "no-store"},
                {"name": "X-Content-Type-Options", "value": "nosniff"},
                {"name": "Referrer-Policy", "value": "no-referrer"},
                # свой CSP-заголовок n8n заменяет на sandbox-CSP; строгий CSP — в <meta> страницы
            ]}},
        }),
    ]
    c = {}
    connect(c, "Webhook GET /board", "Таблица: создать, если нет")
    connect(c, "Таблица: создать, если нет", "Последние 20")
    connect(c, "Последние 20", "Расход за сегодня")
    connect(c, "Расход за сегодня", "HTML доски")
    connect(c, "HTML доски", "Ответ: HTML")
    return workflow(BOARD_ID, "Триаж: публичная доска", nodes, c,
                    "GET /webhook/board: последние 20 заявок и расход за сегодня, HTML без внешних ресурсов.")


def main():
    check = "--check" in sys.argv
    built = {
        "triage-core.json": build_core(),
        "triage-entry.json": build_entry(),
        "board.json": build_board(),
    }
    stale = []
    for fname, wf in built.items():
        text = json.dumps(wf, ensure_ascii=False, indent=2) + "\n"
        path = OUT / fname
        if check:
            if not path.exists() or path.read_text() != text:
                stale.append(fname)
        else:
            OUT.mkdir(exist_ok=True)
            path.write_text(text)
    if check and stale:
        print("устарели: " + ", ".join(stale) + " — запустите scripts/build_workflows.py", file=sys.stderr)
        sys.exit(1)
    if not check:
        print("собрано: " + ", ".join(built))


if __name__ == "__main__":
    main()
