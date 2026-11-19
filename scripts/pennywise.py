#!/usr/bin/env python3
"""tokenomics / pennywise: "penny wise, pound foolish" - stop paying premium-model prices for trivial prompts.

UserPromptSubmit hook. Reads the prompt, rates how hard it looks, compares that with the model
the session is using, and if a cheaper tier would do the job it BLOCKS the prompt once and
suggests the cheaper model (e.g. "create a hello-world console app" on Fable -> use Haiku).

Bypass: send the identical prompt again, prefix it with "keep-model:", or set TOKENOMICS_PENNYWISE=off.

Env:
  TOKENOMICS_PENNYWISE   block (default) | warn (never blocks, shows a notice) | off
  TOKENOMICS_DB          SQLite path shared with spendlens (default ~/.tokenomics/spendlens.db)

Stdlib only. Always exits 0; a crash never blocks a prompt (errors go to <db>.err).
"""
import hashlib
import json
import os
import re
import sys
import time
import traceback
from pathlib import Path

DB_PATH = os.environ.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db"))
MODE = os.environ.get("TOKENOMICS_PENNYWISE", "block").strip().lower()
STATE_PATH = Path(DB_PATH).with_name("pennywise_state.json")

TIERS = {"haiku": 1, "sonnet": 2, "opus": 3, "fable": 4, "mythos": 4}
NAMES = {1: "Haiku", 2: "Sonnet", 3: "Opus", 4: "Fable"}
BYPASS_RE = re.compile(r"^\s*keep-model:\s*", re.I)

# Signals that a prompt is easy (cheap model is fine) ...
SIMPLE = [
    r"\bhello[ ,-]*world\b", r"\bfizz ?buzz\b", r"\bboilerplate\b|\bskeleton\b|\bstarter\b",
    r"\b(fix|correct) (a |the )?(typo|spelling|grammar)\b", r"\brename\b.{0,30}\b(variable|function|file|method)\b",
    r"\b(add|write|update) (a |some )?(comments?|docstrings?|jsdoc|readme)\b",
    r"\bcommit message\b", r"\bgitignore\b|\beditorconfig\b",
    r"\b(format|lint|prettify|indent|sort)\b.{0,30}\b(file|code|json|yaml|imports?)\b",
    r"\bconvert\b.{0,30}\b(json|yaml|csv|xml|toml)\b", r"\bregex\b.{0,30}\b(for|to match)\b",
    r"\bone[- ]liner\b|\bsimple\b|\bbasic\b|\bquick(ly)?\b|\btiny\b|\bsmall\b",
    r"\b(what|which) (does|is)\b.{0,40}\b(this|command|flag|syntax)\b", r"\bsummari[sz]e\b|\btl;?dr\b",
    r"\blist (the )?(files|commands)\b", r"\bcheck git status\b|\bgit (status|log|diff)\b",
]
# ... and that it is hard (keep the premium model).
HARD = [
    r"\barchitect\w*|\bsystem design\b|\bdesign (doc|review)\b", r"\bsecurity\b|\bvulnerab\w+|\bthreat model\b|\bexploit\b",
    r"\brace condition\b|\bconcurren\w+|\bdeadlock\b|\bdistributed\b", r"\bperformance\b|\boptimi[sz]e\b|\bprofil(e|ing)\b",
    r"\bmigrat\w+\b|\brefactor\w*\b|\brewrite\b", r"\bdebug\b|\broot cause\b|\bwhy (is|does|did)\b.{0,60}\b(fail|crash|hang|leak)\w*",
    r"\bacross (the |all )?(repo|codebase|services?|files)\b|\bmulti[- ]?(file|service|step)\b",
    r"\bcompare\b.{0,40}\b(approaches|options|trade-?offs?)\b|\btrade-?offs?\b", r"\bproof\b|\bprove\b|\balgorithm\b",
    r"\bplan\b.{0,20}\b(implementation|rollout|project)\b", r"\bfull(y)?\b.{0,20}\b(app|application|platform|system)\b",
    r"\bresearch\b|\banalys[ei]s\b|\binvestigat\w+",
]
SIMPLE_RE = [re.compile(p, re.I) for p in SIMPLE]
HARD_RE = [re.compile(p, re.I) for p in HARD]


def rate(prompt):
    """Return (tier, reason): the cheapest tier (1-3) that should cope, or (None, why) if unsure."""
    words = len(prompt.split())
    if "```" in prompt or words > 120:
        return None, "long or code-heavy prompt"
    hard = [r.pattern for r in HARD_RE if r.search(prompt)]
    if hard:
        return None, "looks like complex work"
    simple = sum(1 for r in SIMPLE_RE if r.search(prompt))
    if simple and words <= 40:
        return 1, "small, self-contained task"
    if words <= 25 and re.search(r"\b(create|write|add|make|build|generate)\b", prompt, re.I):
        return 2, "short, routine task"
    return None, "no clear signal"


def tier_of(model):
    m = (model or "").lower()
    for name, t in TIERS.items():
        if name in m:
            return t
    return None


def _last_model(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 400_000))
            lines = f.read().decode("utf-8", "replace").splitlines()
        for line in reversed(lines):
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            m = (ev.get("message") or {}).get("model")
            if ev.get("type") == "assistant" and m and not m.startswith("<"):
                return m
    except Exception:
        pass
    return None


def current_model(d):
    m = d.get("model")
    if isinstance(m, dict):
        m = m.get("id") or m.get("display_name")
    if tier_of(m):
        return m
    if d.get("transcript_path"):
        m = _last_model(d["transcript_path"])
        if tier_of(m):
            return m
    if tier_of(os.environ.get("ANTHROPIC_MODEL")):
        return os.environ["ANTHROPIC_MODEL"]
    for p in (Path(d.get("cwd") or ".") / ".claude" / "settings.local.json",
              Path(d.get("cwd") or ".") / ".claude" / "settings.json",
              Path.home() / ".claude" / "settings.json"):
        try:
            m = json.loads(p.read_text()).get("model")
            if tier_of(m):
                return m
        except Exception:
            continue
    return None


def _state():
    try:
        return json.loads(STATE_PATH.read_text())
    except Exception:
        return {}


def log(sid, model, suggested, reason, action):
    try:
        import sqlite3
        Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(DB_PATH, timeout=5)
        db.execute("""CREATE TABLE IF NOT EXISTS pennywise_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
          model TEXT, suggested TEXT, reason TEXT, action TEXT)""")
        db.execute("INSERT INTO pennywise_events(session_id,ts,model,suggested,reason,action) VALUES(?,?,?,?,?,?)",
                   (sid, time.strftime("%Y-%m-%dT%H:%M:%S%z"), model, suggested, reason, action))
        db.commit()
        db.close()
    except Exception:
        pass


def handle(d):
    if MODE == "off":
        return None
    prompt = (d.get("prompt") or d.get("userPrompt") or "").strip()
    if not prompt or prompt.startswith("/"):
        return None
    if BYPASS_RE.match(prompt):
        return None
    model = current_model(d)
    cur = tier_of(model)
    if cur is None:
        return None
    tier, reason = rate(prompt)
    if tier is None or tier >= cur:
        return None

    sid = str(d.get("session_id") or d.get("sessionId") or "unknown")
    digest = hashlib.sha1(prompt.encode()).hexdigest()
    state = _state()
    if state.get(sid) == digest:  # same prompt sent again = "I meant it"
        log(sid, model, NAMES[tier], reason, "overridden")
        return None

    cheaper = NAMES[tier]
    msg = (f"pennywise: this looks like a {reason} that {cheaper} can handle, but this session is on "
           f"{model} ({NAMES[cur]}), a pricier tier. Switch with /model {cheaper.lower()} and resend, "
           f"or send the same prompt again (or prefix it with 'keep-model:') to run it on {NAMES[cur]} anyway.")
    if MODE == "warn":
        log(sid, model, cheaper, reason, "warned")
        return {"systemMessage": msg}
    state.pop(sid, None)
    state[sid] = digest                       # re-insert so the newest entry survives the trim
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps(dict(list(state.items())[-200:])))
    except Exception:
        pass
    log(sid, model, cheaper, reason, "blocked")
    return {"decision": "block", "reason": msg}


def main():
    try:
        raw = sys.stdin.read()
        out = handle(json.loads(raw) if raw.strip() else {})
        if out:
            print(json.dumps(out))
    except Exception:
        try:
            with open(DB_PATH + ".err", "a") as f:
                f.write(time.strftime("%Y-%m-%dT%H:%M:%S%z") + " pennywise\n" + traceback.format_exc() + "\n")
        except Exception:
            pass
    sys.exit(0)


if __name__ == "__main__":
    main()
