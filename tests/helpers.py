import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SPENDLENS = ROOT / "scripts" / "spendlens.py"
USAGE = {"input_tokens": 100, "output_tokens": 50,
         "cache_creation_input_tokens": 10, "cache_read_input_tokens": 1000}


def user(text, meta=False):
    return {"type": "user", "isMeta": meta, "message": {"role": "user", "content": text}}


def assistant(mid, tools=(), usage=USAGE):
    parts = [{"type": "tool_use", "name": n, "input": i} for n, i in tools]
    return {"type": "assistant", "message": {"id": mid, "content": parts, "usage": usage}}


def write_transcript(directory, name, records):
    p = Path(directory) / f"{name}.jsonl"
    with open(p, "w") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")
    return str(p)


class TempEnv:
    """Isolated HOME + DB for one test."""

    def __init__(self):
        self.dir = tempfile.TemporaryDirectory()
        self.home = Path(self.dir.name)
        self.db = str(self.home / "spendlens.db")

    def env(self, **extra):
        e = dict(os.environ)
        for k in list(e):
            if k.startswith("TOKENOMICS_"):
                del e[k]
        e.update({"HOME": str(self.home), "TOKENOMICS_DB": self.db})
        e.update(extra)
        return e

    def hook(self, mode, source, payload, **extra):
        data = payload if isinstance(payload, str) else json.dumps(payload)
        return subprocess.run([sys.executable, str(SPENDLENS), mode, source], input=data,
                              capture_output=True, text=True, env=self.env(**extra), timeout=30)

    def rows(self, sql, args=()):
        db = sqlite3.connect(self.db)
        db.row_factory = sqlite3.Row
        try:
            return [dict(r) for r in db.execute(sql, args)]
        finally:
            db.close()

    def session(self, sid):
        r = self.rows("SELECT * FROM sessions WHERE session_id=?", (sid,))
        return r[0] if r else None

    def cleanup(self):
        self.dir.cleanup()
