"""Usage store: one SQLite schema for every platform (default ~/.tokenomics/spendlens.db).

Rows from Claude Code and Copilot sit side by side and are comparable on label, prompts
and session counts. Billing stays platform-specific: `billing_model` says what the
platform charges for, and token columns are NULL (not 0) where the platform reports none.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import List, Optional, Tuple

from ..util import now, today
from .classifier import Classification
from .evidence import TokenUsage

SESSION_COLUMNS = (
    ("input_tokens", "INTEGER"), ("output_tokens", "INTEGER"),
    ("cache_creation_tokens", "INTEGER"), ("cache_read_tokens", "INTEGER"),
    ("total_tokens", "INTEGER"), ("skills", "TEXT"),
    ("skill_opex", "INTEGER"), ("skill_capex", "INTEGER"), ("skill_detail", "TEXT"),
    ("label_source", "TEXT"), ("llm_label", "TEXT"), ("llm_confidence", "REAL"),
    ("llm_reason", "TEXT"), ("llm_model", "TEXT"), ("llm_input_hash", "TEXT"),
    # added with the shared engine (v1.1)
    ("billing_model", "TEXT"),        # anthropic_tokens | copilot_premium_requests | unknown
    ("usage_status", "TEXT"),         # reported | unavailable
    ("evidence", "TEXT"),             # transcript | hook-events
    # added with budget / spend-report (v1.2)
    ("cost_usd", "REAL"),             # NULL unless the platform bills tokens and reports usage
    ("model", "TEXT"),                # last model seen
)


def connect(db_path: str) -> sqlite3.Connection:
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(db_path, timeout=5)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS sessions(
      session_id TEXT PRIMARY KEY, source TEXT, cwd TEXT, label TEXT,
      opex_score INTEGER, capex_score INTEGER, prompt_count INTEGER DEFAULT 0,
      first_seen TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS prompt_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
      opex_score INTEGER, capex_score INTEGER, label TEXT, excerpt TEXT);
    CREATE INDEX IF NOT EXISTS idx_pe_session ON prompt_events(session_id);
    CREATE TABLE IF NOT EXISTS tool_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
      tool TEXT, kind TEXT, skill TEXT, opex_score INTEGER, capex_score INTEGER);
    CREATE INDEX IF NOT EXISTS idx_te_session ON tool_events(session_id);
    CREATE TABLE IF NOT EXISTS cost_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, day TEXT, usd REAL);
    CREATE INDEX IF NOT EXISTS idx_ce_day ON cost_events(day);
    """)
    have = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
    for col, typ in SESSION_COLUMNS:
        if col not in have:
            db.execute(f"ALTER TABLE sessions ADD COLUMN {col} {typ}")
    return db


def upsert(db, sid: str, source: str, cwd: Optional[str], o: int, c: int, prompts: int,
           replace: bool, label_for) -> None:
    """Accumulate (replace=False) or overwrite (replace=True) keyword scores. An LLM label,
    once set, is kept: later prompts never overwrite it."""
    row = db.execute("SELECT opex_score, capex_score, prompt_count FROM sessions WHERE session_id=?",
                     (sid,)).fetchone()
    if row and not replace:
        o, c, prompts = (row[0] or 0) + o, (row[1] or 0) + c, (row[2] or 0) + prompts
    elif row and replace:
        prompts = max(prompts, row[2] or 0)
    db.execute("""INSERT INTO sessions(session_id,source,cwd,label,opex_score,capex_score,prompt_count,first_seen,updated_at,label_source)
                  VALUES(?,?,?,?,?,?,?,?,?,'keywords')
                  ON CONFLICT(session_id) DO UPDATE SET
                    label=COALESCE(sessions.llm_label, excluded.label),
                    label_source=CASE WHEN sessions.llm_label IS NULL THEN 'keywords' ELSE sessions.label_source END,
                    opex_score=excluded.opex_score, capex_score=excluded.capex_score,
                    prompt_count=excluded.prompt_count, updated_at=excluded.updated_at""",
               (sid, source, cwd, label_for(o, c), o, c, prompts, now(), now()))


def add_prompt_event(db, sid: str, o: int, c: int, label: str, excerpt: Optional[str]) -> None:
    db.execute("INSERT INTO prompt_events(session_id,ts,opex_score,capex_score,label,excerpt) VALUES(?,?,?,?,?,?)",
               (sid, now(), o, c, label, excerpt))


def add_tool_event(db, sid: str, tool: str, kind: str, skill: str, o: int, c: int) -> None:
    db.execute("INSERT INTO tool_events(session_id,ts,tool,kind,skill,opex_score,capex_score) VALUES(?,?,?,?,?,?,?)",
               (sid, now(), tool, kind, skill or None, o, c))


def prompt_totals(db, sid: str) -> Tuple[int, int, int]:
    r = db.execute("SELECT COALESCE(SUM(opex_score),0), COALESCE(SUM(capex_score),0), COUNT(*) "
                   "FROM prompt_events WHERE session_id=?", (sid,)).fetchone()
    return int(r[0]), int(r[1]), int(r[2])


def prompt_excerpts(db, sid: str, limit: int = 5) -> List[str]:
    return [r[0] for r in db.execute(
        "SELECT excerpt FROM prompt_events WHERE session_id=? AND excerpt IS NOT NULL ORDER BY id LIMIT ?",
        (sid, limit))]


def tool_rows(db, sid: str) -> List[Tuple[str, str, Optional[str], int, int]]:
    return list(db.execute("SELECT tool, kind, skill, opex_score, capex_score FROM tool_events "
                           "WHERE session_id=? ORDER BY id", (sid,)))


def write_details(db, sid: str, cls: Classification, usage: Optional[TokenUsage],
                  billing_model: str, evidence: str) -> None:
    if usage is None:
        tok = (None, None, None, None, None)
        status = "unavailable"
    else:
        tok = (usage.input_tokens, usage.output_tokens, usage.cache_creation_tokens,
               usage.cache_read_tokens, usage.total)
        status = "reported"
    db.execute("""UPDATE sessions SET input_tokens=?, output_tokens=?, cache_creation_tokens=?,
                  cache_read_tokens=?, total_tokens=?, skills=?, skill_opex=?, skill_capex=?,
                  skill_detail=?, billing_model=?, usage_status=?, evidence=? WHERE session_id=?""",
               (*tok, json.dumps(cls.skills), cls.skill_opex, cls.skill_capex,
                json.dumps(cls.skill_detail), billing_model, status, evidence, sid))


def set_cost(db, sid: str, usd: Optional[float], model: Optional[str]) -> None:
    """Store the session's cost so far and log the increase since the last call as a dated
    cost event, so spend can be summed per day even for sessions that span several days."""
    if usd is None:
        return
    row = db.execute("SELECT cost_usd FROM sessions WHERE session_id=?", (sid,)).fetchone()
    delta = usd - ((row[0] or 0.0) if row else 0.0)
    if delta > 1e-9:
        db.execute("INSERT INTO cost_events(session_id,ts,day,usd) VALUES(?,?,?,?)",
                   (sid, now(), today(), delta))
    db.execute("UPDATE sessions SET cost_usd=?, model=COALESCE(?, model) WHERE session_id=?", (usd, model, sid))


def day_cost_usd(db, day: Optional[str] = None) -> float:
    r = db.execute("SELECT COALESCE(SUM(usd),0) FROM cost_events WHERE day=?", (day or today(),)).fetchone()
    return float(r[0])


def session_cost(db, sid: str) -> Optional[float]:
    r = db.execute("SELECT cost_usd FROM sessions WHERE session_id=?", (sid,)).fetchone()
    return None if not r or r[0] is None else float(r[0])


def set_billing(db, sid: str, billing_model: str) -> None:
    db.execute("UPDATE sessions SET billing_model=COALESCE(billing_model, ?) WHERE session_id=?",
               (billing_model, sid))


def llm_state(db, sid: str):
    return db.execute("SELECT llm_input_hash, llm_label FROM sessions WHERE session_id=?", (sid,)).fetchone()


def write_llm(db, sid: str, res: dict, h: str) -> None:
    db.execute("""UPDATE sessions SET label=?, label_source='llm', llm_label=?, llm_confidence=?,
                  llm_reason=?, llm_model=?, llm_input_hash=? WHERE session_id=?""",
               (res["label"], res["label"], res["confidence"], res["reason"], res["model"], h, sid))


def refresh_label(db, sid: str, label_for) -> None:
    row = db.execute("SELECT opex_score, capex_score FROM sessions WHERE session_id=?", (sid,)).fetchone()
    if row:
        db.execute("UPDATE sessions SET label=COALESCE(llm_label, ?), updated_at=? WHERE session_id=?",
                   (label_for(row[0] or 0, row[1] or 0), now(), sid))
