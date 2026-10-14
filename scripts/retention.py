#!/usr/bin/env python3
"""Демо n8n (n8n.tavriq.ru): заявки посетителей (source form, api) старше 30 суток удаляются из журнала разбора.
Строки набора проверки (source eval) остаются: это не данные посетителей, на них держится доска.
Запуск — /etc/cron.d/demo-n8n-retention раз в сутки; обещание — tavriq.ru/privacy/ «30 суток» (14.10.2026)."""
import datetime
import os
import sqlite3

DB = "/var/lib/docker/volumes/demo-n8n_n8n_data/_data/database.sqlite"
DAYS = 30
cut = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=DAYS)).strftime("%Y-%m-%dT%H:%M:%S")
db = sqlite3.connect(DB, timeout=60)
tables = dict(db.execute("select name, id from data_table"))
for name in ("triage_log_v2", "triage_log"):
    if name in tables:
        cur = db.execute(f"delete from data_table_user_{tables[name]} where coalesce(source, \"\") != \"eval\" and created_at < ?", (cut,))
        print(datetime.datetime.now().isoformat(timespec="seconds"), name, "удалено", cur.rowcount, "старше", cut)
db.commit()
db.close()
# Файлы WAL создаёт и пишет n8n в контейнере (uid 1000): если их создал этот скрипт под root — вернуть владельца
st = os.stat(DB)
for suf in ("-wal", "-shm", "-journal"):
    if os.path.exists(DB + suf):
        os.chown(DB + suf, st.st_uid, st.st_gid)
