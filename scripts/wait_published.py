#!/usr/bin/env python3
"""Ждёт, пока запущенный n8n применит публикацию воркфлоу.

В n8n 2.x `n8n publish:workflow` только ставит activeVersionId и кладёт запись
в outbox; сервер после старта разбирает outbox асинхронно и лишь тогда двигает
workflow_published_version. Под-воркфлоу исполняется по published-версии,
поэтому первые секунды после рестарта может отвечать старый код.
Скрипт читает sqlite из volume только на чтение и ждёт совпадения версий.
"""
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ids = [json.loads(p.read_text())["id"] for p in sorted(Path("workflows").glob("*.json"))]
mp = subprocess.check_output(
    ["docker", "volume", "inspect", "demo-n8n_n8n_data", "-f", "{{.Mountpoint}}"], text=True).strip()
db = f"file:{mp}/database.sqlite?mode=ro"
deadline = time.time() + 120
lag = ids
while time.time() < deadline:
    try:
        con = sqlite3.connect(db, uri=True, timeout=5)
        rows = dict(con.execute(
            "select w.id, (w.activeVersionId = p.publishedVersionId) from workflow_entity w "
            "left join workflow_published_version p on p.workflowId = w.id").fetchall())
        con.close()
        lag = [i for i in ids if not rows.get(i)]
        if not lag:
            print("-- публикация применена: " + ", ".join(ids))
            sys.exit(0)
    except sqlite3.Error:
        pass
    time.sleep(2)
print("-- не дождался применения публикации: " + ", ".join(lag), file=sys.stderr)
sys.exit(1)
