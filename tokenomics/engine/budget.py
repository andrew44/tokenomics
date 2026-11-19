"""Spending limits: a daily and a per-session budget, in pounds. Platform-independent.

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
from . import pricing, store

BYPASS_RE = re.compile(r"^\s*over-budget:\s*", re.I)


@dataclass
class Limits:
    daily_gbp: Optional[float] = None
    session_gbp: Optional[float] = None
    warn_pct: float = 80.0
    mode: str = "block"            # block | warn | off

    @property
    def active(self) -> bool:
        return self.mode != "off" and bool(self.daily_gbp or self.session_gbp)


def _num(name: str) -> Optional[float]:
    try:
        v = float(os.environ.get(name, "").strip().lstrip("£"))
        return v if v > 0 else None
    except ValueError:
        return None


def load_limits() -> Limits:
    mode = os.environ.get("TOKENOMICS_BUDGET_MODE", "block").strip().lower()
    return Limits(daily_gbp=_num("TOKENOMICS_BUDGET_DAILY"), session_gbp=_num("TOKENOMICS_BUDGET_SESSION"),
                  warn_pct=_num("TOKENOMICS_BUDGET_WARN") or 80.0,
                  mode=mode if mode in ("block", "warn", "off") else "block")


@dataclass
class Decision:
    action: str                    # warned | blocked
    message: str


def _ensure(db) -> None:
    db.execute("""CREATE TABLE IF NOT EXISTS budget_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, day TEXT, kind TEXT,
      action TEXT, spent_gbp REAL, limit_gbp REAL, digest TEXT)""")


def _log(db, sid, kind, action, spent, limit, digest=None) -> None:
    db.execute("INSERT INTO budget_events(session_id,ts,day,kind,action,spent_gbp,limit_gbp,digest) "
               "VALUES(?,?,?,?,?,?,?,?)", (sid, now(), today(), kind, action, spent, limit, digest))


def _seen(db, sid, kind, actions: Tuple[str, ...]) -> List[tuple]:
    q = ",".join("?" * len(actions))
    return list(db.execute(f"SELECT action, digest FROM budget_events WHERE session_id=? AND day=? AND kind=? "
                           f"AND action IN ({q}) ORDER BY id DESC", (sid, today(), kind, *actions)))


def _money(gbp: float) -> str:
    return f"£{gbp:,.2f}"


def check(db, sid: str, prompt: str, limits: Limits) -> Optional[Decision]:
    """Decide what to do with this prompt. Writes budget_events; the caller commits."""
    if not limits.active:
        return None
    _ensure(db)
    rate = pricing.usd_gbp()
    spent = {"session": (store.session_cost(db, sid) or 0.0) * rate,
             "daily": store.day_cost_usd(db) * rate}
    caps = {"session": limits.session_gbp, "daily": limits.daily_gbp}
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
                _log(db, sid, kind, "bypassed", used, cap)
                continue
            if history and history[0][0] == "blocked" and history[0][1] == digest:
                _log(db, sid, kind, "overridden", used, cap)
                continue
            msg = (f"tokenomics budget: {what} spend is {_money(used)}, over the {_money(cap)} limit. "
                   f"To carry on, send the same prompt again or start it with 'over-budget:'. "
                   f"Cheaper ways on: /compact, a smaller model (/model), or a fresh session.")
            if limits.mode == "warn":
                if history:
                    continue
                _log(db, sid, kind, "over", used, cap)
                return Decision("warned", msg.replace(" To carry on, send the same prompt again or start it "
                                                      "with 'over-budget:'.", ""))
            _log(db, sid, kind, "blocked", used, cap, digest)
            return Decision("blocked", msg)
        if used >= cap * limits.warn_pct / 100 and not _seen(db, sid, kind, ("warned",)):
            _log(db, sid, kind, "warned", used, cap)
            return Decision("warned", f"tokenomics budget: {what} spend is {_money(used)}, "
                                      f"{used / cap * 100:.0f}% of the {_money(cap)} limit.")
    return None
