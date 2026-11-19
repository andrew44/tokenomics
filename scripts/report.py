#!/usr/bin/env python3
"""tokenomics / report: a spend report over the last N days from the spendlens database.

  report.py                 # last 7 days, Markdown
  report.py --days 30       # any window (0 = all time)
  report.py --json          # machine-readable (used by the spend-report skill)
  report.py --currency USD  # GBP (default), USD or EUR; default from TOKENOMICS_CURRENCY / statusbar.json
  report.py --db PATH       # another database (default $TOKENOMICS_DB or ~/.tokenomics/spendlens.db)

Covers: spend in your currency (GBP, USD or EUR; token-billed platforms only) and how it splits OPEX / CAPEX, by
project and by model; cache efficiency; the costliest sessions; and what the other helpers
did: pennywise suggestions, handoffs written, diet blocks, budget pauses.
Read-only (the database is opened with mode=ro). Stdlib only, Python 3.8+.
"""
import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

LABELS = ("opex", "capex", "mixed", "unknown")


def _tables(db):
    return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _cols(db, table):
    return {r[1] for r in db.execute(f"PRAGMA table_info({table})")}


def build(db_path, days=7, money=None):
    """money = (code, symbol, units per USD); default: the configured display currency."""
    if money is None:
        from tokenomics.engine import currency
        money = currency.current()
    code, symbol, rate = money
    out = {"db_path": str(db_path), "days": days, "currency": code, "symbol": symbol,
           "rate_per_usd": rate, "empty": True}
    if not Path(db_path).is_file():
        out["reason"] = "no-database"
        return out
    since = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d") if days else "0000-00-00"
    out["since"] = since if days else None
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        tables = _tables(db)
        if "sessions" not in tables:
            out["reason"] = "no-table"
            return out
        cols = _cols(db, "sessions")
        want = ("session_id", "source", "cwd", "label", "prompt_count", "updated_at", "input_tokens",
                "output_tokens", "cache_creation_tokens", "cache_read_tokens", "cost_usd", "model")
        sel = ", ".join(c if c in cols else f"NULL AS {c}" for c in want)
        rows = [dict(zip(want, r)) for r in db.execute(
            f"SELECT {sel} FROM sessions WHERE substr(COALESCE(updated_at,''),1,10) >= ?", (since,))]
        # spend per session inside the window (cost_events are dated increments)
        spend = {}
        if "cost_events" in tables:
            for sid, usd in db.execute("SELECT session_id, SUM(usd) FROM cost_events WHERE day >= ? "
                                       "GROUP BY session_id", (since,)):
                spend[sid] = usd or 0.0
            daily = [{"day": d, "spend": round(u * rate, 2)} for d, u in db.execute(
                "SELECT day, SUM(usd) FROM cost_events WHERE day >= ? GROUP BY day ORDER BY day", (since,))]
        else:
            daily = []

        def ev(table, sql, default):
            return [tuple(r) for r in db.execute(sql, (since,))] if table in tables else default

        pennywise = dict(ev("pennywise_events", "SELECT action, COUNT(*) FROM pennywise_events "
                            "WHERE substr(ts,1,10) >= ? GROUP BY action", []))
        handoffs = ev("handoff_events", "SELECT COUNT(*), COALESCE(SUM(context_tokens),0), "
                      "COALESCE(SUM(handoff_tokens),0) FROM handoff_events WHERE substr(ts,1,10) >= ?",
                      [(0, 0, 0)])[0]
        diet = ev("diet_events", "SELECT rule, COUNT(*), COALESCE(SUM(est_tokens),0) FROM diet_events "
                  "WHERE substr(ts,1,10) >= ? AND action='denied' GROUP BY rule ORDER BY 2 DESC", [])
        budget = dict(ev("budget_events", "SELECT action, COUNT(*) FROM budget_events WHERE day >= ? "
                         "GROUP BY action", []))
    finally:
        db.close()

    if not rows and not spend:
        out["reason"] = "no-rows"
        return out
    out["empty"] = False
    by_label = {k: {"sessions": 0, "spend": 0.0} for k in LABELS}
    by_project, by_model, by_source = {}, {}, {}
    tok = {"input": 0, "output": 0, "cache_write": 0, "cache_read": 0}
    for r in rows:
        lab = r["label"] if r["label"] in LABELS else "unknown"
        cost = spend.get(r["session_id"], 0.0) * rate
        by_label[lab]["sessions"] += 1
        by_label[lab]["spend"] += cost
        proj = os.path.basename((r["cwd"] or "unknown").rstrip("/\\")) or r["cwd"] or "unknown"
        p = by_project.setdefault(proj, {"sessions": 0, "spend": 0.0, "opex": 0, "capex": 0})
        p["sessions"] += 1
        p["spend"] += cost
        if lab in ("opex", "capex"):
            p[lab] += 1
        if r["model"]:
            by_model[r["model"]] = by_model.get(r["model"], 0.0) + cost
        s = by_source.setdefault(r["source"] or "unknown", {"sessions": 0, "prompts": 0})
        s["sessions"] += 1
        s["prompts"] += r["prompt_count"] or 0
        tok["input"] += r["input_tokens"] or 0
        tok["output"] += r["output_tokens"] or 0
        tok["cache_write"] += r["cache_creation_tokens"] or 0
        tok["cache_read"] += r["cache_read_tokens"] or 0
    denom = tok["input"] + tok["cache_write"] + tok["cache_read"]
    total = sum(spend.values()) * rate
    top = sorted((r for r in rows if spend.get(r["session_id"])), key=lambda r: -spend[r["session_id"]])[:5]
    rnd = lambda d: {k: round(v, 2) if isinstance(v, float) else v for k, v in d.items()}  # noqa: E731
    out.update({
        "spend": round(total, 2),
        "daily": daily,
        "by_label": {k: rnd(v) for k, v in by_label.items()},
        "by_project": sorted(({"project": k, **rnd(v)} for k, v in by_project.items()),
                             key=lambda x: (-x["spend"], -x["sessions"]))[:8],
        "by_model": sorted(({"model": k, "spend": round(v, 2)} for k, v in by_model.items()),
                           key=lambda x: -x["spend"]),
        "by_source": by_source,
        "tokens": tok,
        "cache_hit_ratio": round(tok["cache_read"] / denom, 3) if denom else None,
        "top_sessions": [{"session_id": r["session_id"], "project": os.path.basename((r["cwd"] or "").rstrip("/\\")),
                          "label": r["label"], "model": r["model"], "prompts": r["prompt_count"] or 0,
                          "spend": round(spend[r["session_id"]] * rate, 2)} for r in top],
        "helpers": {
            "pennywise": pennywise,
            "handoff": {"written": handoffs[0], "context_tokens": handoffs[1], "handoff_tokens": handoffs[2],
                        "tokens_avoided_if_used": max(0, handoffs[1] - handoffs[2])},
            "diet": [{"rule": r, "denied": n, "est_tokens": t} for r, n, t in diet],
            "budget": budget,
        },
    })
    return out


def markdown(r):
    if r.get("empty"):
        why = {"no-database": f"No database at {r['db_path']} yet: spendlens has not recorded a session.",
               "no-table": "The database has no sessions table yet.",
               "no-rows": "No sessions in this window."}.get(r.get("reason"), "No data.")
        return f"# tokenomics report\n\n{why}\n"
    window = f"last {r['days']} days (since {r['since']})" if r["days"] else "all time"
    L = [f"# tokenomics report: {window}", ""]
    lab = r["by_label"]
    spend = r["spend"]

    def m(v):
        return f"{r['symbol']}{v:,.2f}"

    def share(k):
        return f"{lab[k]['spend'] / spend * 100:.0f}%" if spend else "n/a"
    L += [f"**Spend: {m(spend)}** {r['currency']} (token-billed sessions; Copilot premium requests are not priced)", "",
          "| Work type | Sessions | Spend | Share |", "|---|---:|---:|---:|"]
    for k in LABELS:
        L.append(f"| {k.upper() if k in ('opex', 'capex') else k} | {lab[k]['sessions']} | "
                 f"{m(lab[k]['spend'])} | {share(k)} |")
    L.append("")
    if r["cache_hit_ratio"] is not None:
        L += [f"Cache hit ratio: **{r['cache_hit_ratio'] * 100:.0f}%** of input read from cache "
              f"({r['tokens']['cache_read']:,} of {r['tokens']['cache_read'] + r['tokens']['input'] + r['tokens']['cache_write']:,} tokens).", ""]
    if r["by_project"]:
        L += ["## By project", "", "| Project | Sessions | OPEX | CAPEX | Spend |", "|---|---:|---:|---:|---:|"]
        L += [f"| {p['project']} | {p['sessions']} | {p['opex']} | {p['capex']} | {m(p['spend'])} |"
              for p in r["by_project"]]
        L.append("")
    if r["by_model"]:
        L += ["## By model", ""] + [f"- {x['model']}: {m(x['spend'])}" for x in r["by_model"]] + [""]
    if r["top_sessions"]:
        L += ["## Costliest sessions", "", "| Session | Project | Type | Model | Prompts | Spend |",
              "|---|---|---|---|---:|---:|"]
        L += [f"| `{s['session_id'][:8]}` | {s['project']} | {s['label']} | {s['model'] or '?'} | "
              f"{s['prompts']} | {m(s['spend'])} |" for s in r["top_sessions"]]
        L.append("")
    h = r["helpers"]
    L += ["## What the helpers did", ""]
    pw = h["pennywise"]
    L.append(f"- pennywise: {pw.get('blocked', 0) + pw.get('warned', 0)} cheaper-model suggestions, "
             f"{pw.get('overridden', 0)} overridden.")
    ho = h["handoff"]
    L.append(f"- handoff: {ho['written']} handoffs written; resuming from them instead of the full context "
             f"avoids up to {ho['tokens_avoided_if_used']:,} tokens of cache writes.")
    if h["diet"]:
        known = sum(d["est_tokens"] for d in h["diet"])
        rules = ", ".join(f"{d['rule']} x{d['denied']}" for d in h["diet"])
        L.append(f"- diet: {sum(d['denied'] for d in h['diet'])} oversized tool calls stopped ({rules})"
                 + (f"; at least {known:,} tokens kept out of the context." if known else "."))
    else:
        L.append("- diet: nothing blocked.")
    b = h["budget"]
    if b:
        L.append(f"- budget: {b.get('warned', 0)} warnings, {b.get('blocked', 0)} pauses, "
                 f"{b.get('overridden', 0) + b.get('bypassed', 0)} carried on over the limit.")
    srcs = ", ".join(f"{k}: {v['sessions']} sessions / {v['prompts']} prompts" for k, v in r["by_source"].items())
    L += ["", f"Platforms: {srcs}.", ""]
    return "\n".join(L)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=os.environ.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db")))
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--currency", help="GBP, USD or EUR (default: TOKENOMICS_CURRENCY, then statusbar.json, then GBP)")
    a = ap.parse_args()
    from tokenomics.engine import currency
    if a.currency:
        code = currency.currency_code(a.currency)
        if not code:
            ap.error(f"unknown currency {a.currency!r}: use GBP, USD or EUR")
        os.environ["TOKENOMICS_CURRENCY"] = code
    r = build(a.db, max(0, a.days))
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    print(json.dumps(r, indent=2) if a.json else markdown(r))


if __name__ == "__main__":
    main()
