"""Small append-only event tables for the guard hooks (diet, ...). Never raises."""
from __future__ import annotations

import sqlite3
from pathlib import Path

from ..util import log_err, now

TABLES = {
    "diet_events": "session_id TEXT, source TEXT, tool TEXT, rule TEXT, est_tokens INTEGER, action TEXT",
}


def log(db_path: str, table: str, **fields) -> None:
    try:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(db_path, timeout=5)
        try:
            db.execute(f"CREATE TABLE IF NOT EXISTS {table}(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, "
                       f"{TABLES[table]})")
            cols = ["ts"] + list(fields)
            db.execute(f"INSERT INTO {table}({','.join(cols)}) VALUES({','.join('?' * len(cols))})",
                       (now(), *fields.values()))
            db.commit()
        finally:
            db.close()
    except Exception as e:
        log_err(db_path, f"event log failed ({table}: {type(e).__name__}: {e})")
