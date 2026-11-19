#!/usr/bin/env python3
"""tokenomics / budget: daily and per-session spending limits, in pounds.

Prompt hook (Claude Code: UserPromptSubmit). Shows a notice at 80% of a limit and pauses the
next prompt once a limit is reached; send the same prompt again (or start it with
"over-budget:") to carry on. Spend is what spendlens recorded, priced like the status bar.
Copilot bills premium requests, not tokens, so it has no spend to budget against.

Usage (hook command):  budget.py [source]      source = claude-code (default) | copilot
       budget.py status                         print today's spend and the limits

Env (no limit set = budget does nothing):
  TOKENOMICS_BUDGET_DAILY    e.g. 20     pounds per calendar day, all sessions together
  TOKENOMICS_BUDGET_SESSION  e.g. 5      pounds per session
  TOKENOMICS_BUDGET_WARN     80          percent of a limit at which to show a notice
  TOKENOMICS_BUDGET_MODE     block (default) | warn (notices only) | off
Stdlib only. Always exits 0 on hook runs; a crash never blocks a prompt (errors go to <db>.err).
"""
import json
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def status():
    from tokenomics.config import load_settings
    from tokenomics.engine import budget, pricing, store
    lim = budget.load_limits()
    db = store.connect(load_settings().db_path)
    try:
        today = store.day_cost_usd(db) * pricing.usd_gbp()
    finally:
        db.close()
    fmt = lambda v: f"£{v:,.2f}" if v else "not set"   # noqa: E731
    print(f"Spent today: £{today:,.2f}\nDaily limit: {fmt(lim.daily_gbp)}\n"
          f"Session limit: {fmt(lim.session_gbp)}\nMode: {lim.mode}")


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else "claude-code"
    if arg == "status":
        return status()
    try:
        from tokenomics.config import load_settings
        from tokenomics.engine import budget, store
        from tokenomics.platform.registry import get_adapter

        limits = budget.load_limits()
        if not limits.active:
            return
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            return
        adapter = get_adapter(arg)
        prompt = str(payload.get("prompt") or payload.get("userPrompt") or "")
        db = store.connect(load_settings().db_path)
        try:
            d = budget.check(db, adapter.session_id(payload), prompt, limits)
            db.commit()
        finally:
            db.close()
        if d:
            out = adapter.block_prompt(d.message) if d.action == "blocked" else adapter.notify(d.message)
            if out:
                print(json.dumps(out))
    except Exception:
        db_path = os.environ.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db"))
        try:
            with open(db_path + ".err", "a") as f:
                f.write("budget\n" + traceback.format_exc() + "\n")
        except Exception:
            pass


if __name__ == "__main__":
    main()
    sys.exit(0)
