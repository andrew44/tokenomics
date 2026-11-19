#!/usr/bin/env python3
"""tokenomics / spendlens: classify an AI coding session as OPEX (run) or CAPEX (build) and log it to SQLite.

OPEX  = running/observing the estate: insights, logs, metrics, Grafana, incidents.
CAPEX = building: generating/changing code.

Usage (hook command):
  spendlens.py prompt   [source]   # on every user prompt
  spendlens.py finalize [source]   # on Stop / SessionEnd (re-scores from transcript)

Reads the hook JSON on stdin. Prints NOTHING to stdout (UserPromptSubmit stdout is
injected into the model context) and always exits 0 so it can never block a session.
Stdlib only.

Env:
  TOKENOMICS_DB            SQLite path (default ~/.tokenomics/spendlens.db)
  TOKENOMICS_STORE_PROMPT  "1" to store a 200-char prompt excerpt (default: off)
"""
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import traceback
from pathlib import Path

DB_PATH = os.environ.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db"))
STORE_PROMPT = os.environ.get("TOKENOMICS_STORE_PROMPT") == "1"

# (regex, weight) -- tune these to your estate.
OPEX_PATTERNS = [
    (r"\bgrafana\b", 3), (r"\bloki\b", 3), (r"\bprometheus\b|\bpromql\b|\blogql\b", 3),
    (r"\bkibana\b|\bsplunk\b|\bdatadog\b|\bapp ?insights\b|\bkql\b|\bcloudwatch\b", 3),
    (r"\bdashboards?\b", 2), (r"\bmetrics?\b", 2), (r"\blogs?\b", 2), (r"\btraces?\b|\bspans?\b", 2),
    (r"\binsights?\b", 2), (r"\balerts?\b|\bincidents?\b|\bon-?call\b|\bpostmortem\b", 2),
    (r"\blatency\b|\bp9[59]\b|\berror rate\b|\bthroughput\b|\bslo\b|\bsli\b|\buptime\b", 2),
    (r"\bwhy (is|was|did|are)\b|\binvestigat\w+|\bdiagnos\w+|\btroubleshoot\w*", 1),
    (r"\bkubectl (logs|top|describe|get)\b", 2),
]
CAPEX_PATTERNS = [
    (r"\b(implement|build|create|write|generate|scaffold|add|develop)\b.{0,40}"
     r"\b(function|class|module|endpoint|api|component|service|script|feature|test|"
     r"migration|schema|cli|app|page|hook|library)\b", 4),
    (r"\brefactor\w*|\brewrite\b|\bport (this|to)\b|\bmigrate (this|the) code\b", 3),
    (r"\bfix (the |this )?(bug|failing test|compile|build error|type error)\b", 3),
    (r"\bunit tests?\b|\bintegration tests?\b|\bwrite tests\b", 3),
    (r"\bcode\b|\bcodebase\b|\bpull request\b|\bpr\b|\bcommit\b", 1),
    (r"```", 1),
    (r"\b(python|typescript|javascript|golang|rust|java|c#|terraform|dockerfile|yaml|sql)\b", 1),
]
CODE_EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit",
                   "edit_file", "create_file", "replace_string_in_file",
                   "insert_edit_into_file", "apply_patch"}
OPEX_TOOL_HINT = re.compile(r"grafana|loki|prometheus|datadog|kibana|splunk|cloudwatch|sentry", re.I)


# Skill names (matched on the skill's own name; "plugin:skill" -> both parts are searched).
# Each distinct skill used in a session adds SKILL_WEIGHT to the matching side.
SKILL_WEIGHT = 6
SKILL_OPEX = re.compile(
    r"grafana|loki|prometheus|datadog|kibana|splunk|sentry|observab\w*|monitor\w*|telemetry|"
    r"\blogs?\b|\blogging\b|metrics?|insights?|incidents?|alerts?|traces?|tracing|dashboards?|"
    r"\bsre\b|on-?call|postmortem|usage|cost|finops|triage|diagnos\w*|troubleshoot\w*", re.I)
SKILL_CAPEX = re.compile(
    r"\bcode\b|coding|refactor\w*|\btests?\b|testing|frontend|backend|\bapi\b|scaffold\w*|"
    r"implement\w*|\bbuild\b|\bcommit\b|\bpr\b|pull-?request|\blint\w*|\bdebug\w*|migrat\w*|"
    r"feature|component|plugin-authoring|skill-creator|\bdesign\b|\bdocker\w*|terraform|"
    r"\bsdk\b|\bcli\b|generate|\bdev\b", re.I)
# Optional override: JSON file {"skill-name": "opex" | "capex"} via TOKENOMICS_SKILL_MAP.
SKILL_MAP = {}
try:
    _m = os.environ.get("TOKENOMICS_SKILL_MAP")
    if _m and Path(_m).is_file():
        SKILL_MAP = {k.lower(): str(v).lower() for k, v in json.load(open(_m)).items()}
except Exception:
    SKILL_MAP = {}


def skill_side(name):
    """Return 'opex', 'capex' or None for a skill name."""
    n = (name or "").strip().lstrip("/").lower()
    if not n:
        return None
    for key in (n, n.split(":")[-1]):
        if key in SKILL_MAP and SKILL_MAP[key] in ("opex", "capex"):
            return SKILL_MAP[key]
    o, c = bool(SKILL_OPEX.search(n)), bool(SKILL_CAPEX.search(n))
    if o and not c:
        return "opex"
    if c and not o:
        return "capex"
    return None


# ---- skill descriptions -------------------------------------------------------------
# Extra description-only hints (on top of OPEX_PATTERNS / CAPEX_PATTERNS).
DESC_OPEX = re.compile(r"\banaly[sz]\w*|\binvestigat\w+|\bquer(y|ies)\b|\bmonitor\w*|\bdiagnos\w+|"
                       r"\bobservab\w+|\btelemetry\b|\bkql\b|\bpromql\b|\bsla\b|\bslo\b", re.I)
DESC_CAPEX = re.compile(r"\bnunit\b|\bxunit\b|\bmstest\b|\bjunit\b|\bpytest\b|\bjest\b|\bmocha\b|"
                        r"\bunit tests?\b|\bcreate|\bgenerat\w+|\bimplement\w*|\bscaffold\w*|\brefactor\w*|"
                        r"\bwrite (code|tests?)\b|\.net\b|\bc#|\bapi\b|\bcomponents?\b|\bsource code\b", re.I)
_DESC_CACHE = {}


def _frontmatter_description(path):
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")[:6000]
    except OSError:
        return None
    m = re.match(r"^---\s*\n(.*?)\n---", text, re.S)
    if not m:
        return None
    lines = m.group(1).split("\n")
    for i, ln in enumerate(lines):
        mm = re.match(r"^description:\s*(.*)$", ln)
        if not mm:
            continue
        val = mm.group(1).strip()
        if val in (">", "|", ">-", "|-", ">+", "|+", ""):
            block = []
            for nxt in lines[i + 1:]:
                if nxt.startswith((" ", "\t")):
                    block.append(nxt.strip())
                else:
                    break
            val = " ".join(block)
        return val.strip("\"'") or None
    return None


def find_skill_description(name, cwd):
    """Look the skill up on disk (project, user, plugins). Returns description or None."""
    n = name.strip().lstrip("/")
    plugin, _, leaf = n.rpartition(":")
    key = (n, cwd)
    if key in _DESC_CACHE:
        return _DESC_CACHE[key]
    home = Path.home()
    roots = []
    if cwd:
        roots += [Path(cwd) / ".claude", Path(cwd) / ".github"]
    roots += [home / ".claude", home / ".copilot"]
    cands = []
    for r in roots:
        cands += [r / "skills" / leaf / "SKILL.md", r / "commands" / f"{leaf}.md"]
    desc = None
    for p in cands:
        if p.is_file():
            desc = _frontmatter_description(p)
            if desc:
                break
    if not desc:
        for base in (home / ".claude" / "plugins", home / ".copilot"):
            if not base.is_dir():
                continue
            hits = list(base.rglob(f"skills/{leaf}/SKILL.md"))[:20] + list(base.rglob(f"commands/{leaf}.md"))[:20]
            hits.sort(key=lambda p: plugin not in str(p) if plugin else 0)   # prefer matching plugin
            for p in hits:
                desc = _frontmatter_description(p)
                if desc:
                    break
            if desc:
                break
    _DESC_CACHE[key] = desc
    return desc


def classify_skill(name, desc):
    """-> (side or None, basis). Priority: user map > name+description evidence."""
    n = name.strip().lstrip("/").lower()
    for key in (n, n.split(":")[-1]):
        if SKILL_MAP.get(key) in ("opex", "capex"):
            return SKILL_MAP[key], "map"
    o = c = 0
    ns = skill_side(name)
    if ns == "opex":
        o += 3
    elif ns == "capex":
        c += 3
    basis = "name" if ns else ""
    if desc:
        do, dc = score(desc)
        do += 2 * len(DESC_OPEX.findall(desc))
        dc += 1 * len(DESC_CAPEX.findall(desc))
        o, c = o + min(do, 8), c + min(dc, 8)
        basis = "name+description" if ns else "description"
    lab = label_for(o, c)
    return (lab if lab in ("opex", "capex") else None), basis


def score(text):
    t = (text or "").lower()
    o = sum(w for p, w in OPEX_PATTERNS if re.search(p, t))
    c = sum(w for p, w in CAPEX_PATTERNS if re.search(p, t))
    return o, c


def label_for(o, c):
    if o + c == 0:
        return "unknown"
    hi, lo = max(o, c), min(o, c)
    if lo and lo / hi >= 0.75:
        return "mixed"
    return "opex" if o > c else "capex"


def connect():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=5)
    db.executescript("""
    CREATE TABLE IF NOT EXISTS sessions(
      session_id TEXT PRIMARY KEY, source TEXT, cwd TEXT, label TEXT,
      opex_score INTEGER, capex_score INTEGER, prompt_count INTEGER DEFAULT 0,
      first_seen TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS prompt_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
      opex_score INTEGER, capex_score INTEGER, label TEXT, excerpt TEXT);
    CREATE INDEX IF NOT EXISTS idx_pe_session ON prompt_events(session_id);
    """)
    # Lightweight migration: add columns introduced after v1.
    have = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
    for col, typ in (("input_tokens", "INTEGER"), ("output_tokens", "INTEGER"),
                     ("cache_creation_tokens", "INTEGER"), ("cache_read_tokens", "INTEGER"),
                     ("total_tokens", "INTEGER"), ("skills", "TEXT"),
                     ("skill_opex", "INTEGER"), ("skill_capex", "INTEGER"),
                     ("skill_detail", "TEXT")):
        if col not in have:
            db.execute(f"ALTER TABLE sessions ADD COLUMN {col} {typ}")
    return db


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def session_id(d):
    sid = d.get("session_id") or d.get("sessionId") or (d.get("session") or {}).get("id")
    if sid:
        return str(sid)
    # Fallback (e.g. Copilot CLI sends no id): stable per cwd per day.
    return "anon-" + hashlib.sha1(f"{d.get('cwd','')}{time.strftime('%Y%m%d')}".encode()).hexdigest()[:16]


def upsert(db, sid, source, cwd, o, c, prompts, replace):
    row = db.execute("SELECT opex_score, capex_score, prompt_count FROM sessions WHERE session_id=?",
                     (sid,)).fetchone()
    if row and not replace:
        o, c, prompts = row[0] + o, row[1] + c, row[2] + prompts
    elif row and replace:
        prompts = max(prompts, row[2])
    db.execute("""INSERT INTO sessions(session_id,source,cwd,label,opex_score,capex_score,prompt_count,first_seen,updated_at)
                  VALUES(?,?,?,?,?,?,?,?,?)
                  ON CONFLICT(session_id) DO UPDATE SET label=excluded.label,
                    opex_score=excluded.opex_score, capex_score=excluded.capex_score,
                    prompt_count=excluded.prompt_count, updated_at=excluded.updated_at""",
               (sid, source, cwd, label_for(o, c), o, c, prompts, now(), now()))


def on_prompt(d, source):
    prompt = d.get("prompt") or d.get("userPrompt") or ""
    o, c = score(prompt)
    sid = session_id(d)
    db = connect()
    db.execute("INSERT INTO prompt_events(session_id,ts,opex_score,capex_score,label,excerpt) VALUES(?,?,?,?,?,?)",
               (sid, now(), o, c, label_for(o, c), prompt[:200] if STORE_PROMPT else None))
    upsert(db, sid, source, d.get("cwd"), o, c, 1, replace=False)
    db.commit()


def user_text(msg):
    content = (msg or {}).get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return " ".join(p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text")
    return ""


CMD_RE = re.compile(r"<command-name>\s*/?([^<\s]+)\s*</command-name>")
LISTING_RE = re.compile(r"^- ([A-Za-z0-9_.:\-]+): (.{12,})$", re.M)


def _strings(obj, depth=0):
    if depth > 6:
        return
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _strings(v, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            yield from _strings(v, depth + 1)


def on_finalize(d, source):
    sid = session_id(d)
    path = d.get("transcript_path") or d.get("transcriptPath")
    o = c = prompts = 0
    parsed = False
    listed = {}          # skill name (lower) -> description, from skill listings in the transcript
    skills = []          # distinct, in order of first use
    usage = {}           # message id -> last usage dict (streamed entries repeat the id)
    if path and Path(path).is_file():
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                parsed = True
                if "skill" in line.lower():       # skill listings: "- name: description" lines
                    for s in _strings(ev):
                        for m in LISTING_RE.finditer(s):
                            listed.setdefault(m.group(1).lower(), m.group(2).strip())
                kind, msg = ev.get("type"), ev.get("message") or {}
                if kind == "user" and not ev.get("isMeta"):
                    txt = user_text(msg)
                    if txt:
                        m = CMD_RE.search(txt)           # slash-command skill, e.g. /grafana-triage
                        if m and m.group(1) not in skills:
                            skills.append(m.group(1))
                        po, pc = score(txt)
                        o, c, prompts = o + po, c + pc, prompts + 1
                elif kind == "assistant":
                    u = msg.get("usage")
                    if isinstance(u, dict):
                        usage[msg.get("id") or ev.get("uuid") or len(usage)] = u
                if kind == "assistant" and isinstance(msg.get("content"), list):
                    for part in msg["content"]:
                        if not (isinstance(part, dict) and part.get("type") == "tool_use"):
                            continue
                        name, inp = part.get("name", ""), part.get("input") or {}
                        if name == "Skill":
                            sk = str(inp.get("skill") or inp.get("name") or "")
                            if sk and sk not in skills:
                                skills.append(sk)
                            continue
                        if name in CODE_EDIT_TOOLS:
                            c += 3
                        elif OPEX_TOOL_HINT.search(name):
                            o += 3
                        elif name == "Bash":
                            bo, _ = score(str(inp.get("command", "")))
                            o += bo
    db = connect()
    if parsed:
        so = sc = 0
        detail = []
        for sk in skills:
            leaf = sk.lstrip("/").split(":")[-1].lower()
            desc = (find_skill_description(sk, d.get("cwd"))
                    or listed.get(sk.lstrip("/").lower()) or listed.get(leaf))
            side, basis = classify_skill(sk, desc)
            if side == "opex":
                so += 1
            elif side == "capex":
                sc += 1
            detail.append({"name": sk, "side": side, "basis": basis or "none",
                           "description": (desc or "")[:200]})
        o, c = o + so * SKILL_WEIGHT, c + sc * SKILL_WEIGHT
        tok = {k: sum(int(u.get(k) or 0) for u in usage.values())
               for k in ("input_tokens", "output_tokens",
                         "cache_creation_input_tokens", "cache_read_input_tokens")}
        upsert(db, sid, source, d.get("cwd"), o, c, prompts, replace=True)
        db.execute("""UPDATE sessions SET input_tokens=?, output_tokens=?, cache_creation_tokens=?,
                      cache_read_tokens=?, total_tokens=?, skills=?, skill_opex=?, skill_capex=?,
                      skill_detail=? WHERE session_id=?""",
                   (tok["input_tokens"], tok["output_tokens"], tok["cache_creation_input_tokens"],
                    tok["cache_read_input_tokens"], sum(tok.values()),
                    json.dumps(skills), so, sc, json.dumps(detail), sid))
    else:  # no transcript: just refresh the label from what we accumulated
        row = db.execute("SELECT opex_score, capex_score FROM sessions WHERE session_id=?", (sid,)).fetchone()
        if row:
            db.execute("UPDATE sessions SET label=?, updated_at=? WHERE session_id=?",
                       (label_for(*row), now(), sid))
    db.commit()


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "prompt"
    source = sys.argv[2] if len(sys.argv) > 2 else "claude-code"
    try:
        raw = sys.stdin.read()
        d = json.loads(raw) if raw.strip() else {}
        (on_finalize if mode == "finalize" else on_prompt)(d, source)
    except Exception:
        try:
            with open(DB_PATH + ".err", "a") as f:
                f.write(f"{now()}\n{traceback.format_exc()}\n")
        except Exception:
            pass
    sys.exit(0)


if __name__ == "__main__":
    main()
