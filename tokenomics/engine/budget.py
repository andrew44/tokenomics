"""Spending limits: a daily and a per-session budget. Platform-independent.

Limits are amounts in the display currency (GBP by default; USD or EUR via TOKENOMICS_CURRENCY,
see engine/currency.py). Spend is stored in USD and converted at the configured rate.

Spend comes from the usage store (cost_usd per session, cost_events per day), which spendlens
updates at every turn end, so the figure is at most one turn behind. Only token-billed
platforms have a cost; Copilot (premium requests) never counts towards a budget.

At `warn` percent of a limit the user gets one notice per session per day. At 100% the next
prompt is paused once (mode "block") with three ways on: send the same prompt again, prefix it
with "over-budget:", or raise the limit. After an override the session is not paused again for
that limit that day.
"""
from __future__ import annotations

import hashlib
import os
import re
from dataclasses import dataclass
from typing import List, Optional, Tuple

from ..util import now, today
from . import currency, store

BYPASS_RE = re.compile(r"^\s*over-budget:\s*", re.I)


@dataclass
class Limits:
    daily: Optional[float] = None          # in the display currency
    session: Optional[float] = None
    warn_pct: float = 80.0
    mode: str = "block"            # block | warn | off

    @property
    def active(self) -> bool:
        return self.mode != "off" and bool(self.daily or self.session)


def _num(name: str) -> Optional[float]:
    try:
        v = float(os.environ.get(name, "").strip().lstrip("£€$").replace(",", ""))
        return v if v > 0 else None
    except ValueError:
        return None


def load_limits() -> Limits:
    mode = os.environ.get("TOKENOMICS_BUDGET_MODE", "block").strip().lower()
    return Limits(daily=_num("TOKENOMICS_BUDGET_DAILY"), session=_num("TOKENOMICS_BUDGET_SESSION"),
                  warn_pct=_num("TOKENOMICS_BUDGET_WARN") or 80.0,
                  mode=mode if mode in ("block", "warn", "off") else "block")


@dataclass
class Decision:
    action: str                    # warned | blocked
    message: str


def _ensure(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS budget_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, day TEXT, kind TEXT,
      action TEXT, spent REAL, limit_amount REAL, currency TEXT, digest TEXT)""")
    have = {r[1] for r in db.execute("PRAGMA table_info(budget_events)")}
    for col, typ in (("spent", "REAL"), ("limit_amount", "REAL"), ("currency", "TEXT")):
        if col not in have:                       # tables from before currencies were configurable
            db.execute(f"ALTER TABLE budget_events ADD COLUMN {col} {typ}")


def _log(db, sid, kind, action, spent, limit, code, digest=None) -> None:
    db.execute("INSERT INTO budget_events(session_id,ts,day,kind,action,spent,limit_amount,currency,digest) "
               "VALUES(?,?,?,?,?,?,?,?,?)", (sid, now(), today(), kind, action, spent, limit, code, digest))


def _seen(db, sid, kind, actions: Tuple[str, ...]) -> List[tuple]:
    q = ",".join("?" * len(actions))
    return list(db.execute(f"SELECT action, digest FROM budget_events WHERE session_id=? AND day=? AND kind=? "
                           f"AND action IN ({q}) ORDER BY id DESC", (sid, today(), kind, *actions)))


def check(db, sid: str, prompt: str, limits: Limits) -> Optional[Decision]:
    """Decide what to do with this prompt. Writes budget_events; the caller commits."""
    if not limits.active:
        return None
    _ensure(db)
    code, symbol, rate = currency.current()

    def money(v: float) -> str:
        return currency.format_money(v, symbol)
    spent = {"session": (store.session_cost(db, sid) or 0.0) * rate,
             "daily": store.day_cost_usd(db) * rate}
    caps = {"session": limits.session, "daily": limits.daily}
    digest = hashlib.sha1(prompt.strip().encode()).hexdigest()
    bypass = bool(BYPASS_RE.match(prompt))
    for kind in ("daily", "session"):
        cap = caps[kind]
        if not cap:
            continue
        used = spent[kind]
        what = "today's" if kind == "daily" else "this session's"
        if used >= cap:
            history = _seen(db, kind=kind, sid=sid, actions=("blocked", "overridden", "bypassed", "over"))
            if any(a in ("overridden", "bypassed") for a, _ in history):
                continue                                  # already chose to carry on today
            if bypass:
                _log(db, sid, kind, "bypassed", used, cap, code)
                continue
            if history and history[0][0] == "blocked" and history[0][1] == digest:
                _log(db, sid, kind, "overridden", used, cap, code)
                continue
            msg = (f"tokenomics budget: {what} spend is {money(used)}, over the {money(cap)} limit. "
                   f"To carry on, send the same prompt again or start it with 'over-budget:'. "
                   f"Cheaper ways on: /compact, a smaller model (/model), or a fresh session.")
            if limits.mode == "warn":
                if history:
                    continue
                _log(db, sid, kind, "over", used, cap, code)
                return Decision("warned", msg.replace(" To carry on, send the same prompt again or start it "
                                                      "with 'over-budget:'.", ""))
            _log(db, sid, kind, "blocked", used, cap, code, digest)
            return Decision("blocked", msg)
        if used >= cap * limits.warn_pct / 100 and not _seen(db, sid, kind, ("warned",)):
            _log(db, sid, kind, "warned", used, cap, code)
            return Decision("warned", f"tokenomics budget: {what} spend is {money(used)}, "
                                      f"{used / cap * 100:.0f}% of the {money(cap)} limit.")
    return None
