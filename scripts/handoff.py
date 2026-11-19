#!/usr/bin/env python3
"""tokenomics / handoff: write a compact handoff file just before the prompt cache expires.

When the cache goes cold, resuming the full session re-writes the whole context to the cache at a
premium (1.25x input price). A handoff file is a small, deterministic digest (recent prompts, last
reply, files touched, tasks, git state) so a NEW session can pick up from it for a fraction of the
tokens. No model is called to write it.

Hook commands (all read the hook JSON on stdin, print nothing, exit 0):
  handoff.py arm   [source]   Stop (Claude Code) / userPromptSubmitted (Copilot): start a background
                              watcher that writes the handoff LEAD seconds before the cache expires.
  handoff.py end   [source]   SessionEnd: stop the watcher and write a handoff if none is current.
  handoff.py write [source]   Write a handoff now (manual use).
  handoff.py start [source]   SessionStart: tell the user a recent handoff exists for this folder.
Internal: handoff.py watch <jobfile> <token>

Env:
  TOKENOMICS_HANDOFF         on (default) | off
  TOKENOMICS_HANDOFF_LEAD    seconds before expiry to write (default 60)
  TOKENOMICS_HANDOFF_DIR     where files go (default ~/.tokenomics/handoffs)
  TOKENOMICS_HANDOFF_INJECT  1 = on session start also inject the handoff as context (default: notice only)
  TOKENOMICS_HANDOFF_MAX_AGE_H  hours a handoff is offered for (default 24)
  TOKENOMICS_HANDOFF_KEEP    handoff files kept (default 30)
  TOKENOMICS_CACHE_TTL       cache lifetime in seconds (default: detected, 300 or 3600)
  TOKENOMICS_DB              SQLite path shared with spendlens (default ~/.tokenomics/spendlens.db)

Stdlib only. Errors go to <db>.err, never on screen.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
DB_PATH = os.environ.get("TOKENOMICS_DB", str(HOME / ".tokenomics" / "spendlens.db"))
OUT_DIR = Path(os.environ.get("TOKENOMICS_HANDOFF_DIR", str(HOME / ".tokenomics" / "handoffs")))
ENABLED = os.environ.get("TOKENOMICS_HANDOFF", "on").strip().lower() != "off"


def _int_env(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


LEAD = _int_env("TOKENOMICS_HANDOFF_LEAD", 60)
KEEP = _int_env("TOKENOMICS_HANDOFF_KEEP", 30)
MAX_AGE_H = _int_env("TOKENOMICS_HANDOFF_MAX_AGE_H", 24)
TTL_OVERRIDE = _int_env("TOKENOMICS_CACHE_TTL", 0)
INJECT = os.environ.get("TOKENOMICS_HANDOFF_INJECT") == "1"
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
TAIL_BYTES = 1_000_000


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def parse_ts(s):
    if not s:
        return None
    try:
        if isinstance(s, (int, float)):
            return s / 1000 if s > 1e11 else float(s)
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    except ValueError:
        return None


def log_err(tag):
    try:
        with open(DB_PATH + ".err", "a") as f:
            f.write(now_iso() + " handoff " + tag + "\n" + traceback.format_exc() + "\n")
    except Exception:
        pass


def session_id(d):
    sid = d.get("session_id") or d.get("sessionId") or (d.get("session") or {}).get("id")
    if sid:
        return str(sid)
    return "anon-" + hashlib.sha1(f"{d.get('cwd', '')}{time.strftime('%Y%m%d')}".encode()).hexdigest()[:16]


def safe(sid):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:80]


# ------------------------------------------------------------------ transcript location ----

def newest_jsonl(directory, sid=None):
    """Newest *.jsonl under `directory`; if `sid` is given, only files whose path names it count
    (falling back to any file when none does)."""
    if sid:
        own = newest_jsonl_matching(directory, sid)
        if own:
            return own
    best, best_m = None, 0
    try:
        for p in Path(directory).rglob("*.jsonl"):
            m = p.stat().st_mtime
            if m > best_m:
                best, best_m = p, m
    except OSError:
        pass
    return best


def newest_jsonl_matching(directory, sid):
    best, best_m = None, 0
    try:
        for p in Path(directory).rglob("*.jsonl"):
            if sid not in p.parts and p.stem != sid:
                continue
            m = p.stat().st_mtime
            if m > best_m:
                best, best_m = p, m
    except OSError:
        pass
    return best


def resolve_transcript(d, source):
    t = d.get("transcript_path") or d.get("transcriptPath")
    if not t and source == "copilot":      # best effort: Copilot hooks may not pass a path
        t = str(Path(os.environ.get("COPILOT_HOME", HOME / ".copilot")) / "session-state")
    if not t:
        return None
    p = Path(t)
    if p.is_dir():
        sid = d.get("session_id") or d.get("sessionId")
        p = newest_jsonl(p, str(sid) if sid else None)
    return p if p and p.is_file() else None


# ------------------------------------------------------------------ cache clock ------------

def cache_clock(path):
    """-> (last_cache_ts, ttl_seconds) from the tail of the transcript, or (None, ttl)."""
    last, ttl_1h = None, False
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            f.seek(max(0, size - TAIL_BYTES))
            lines = f.read().splitlines()
        for raw in reversed(lines):
            if b'"usage"' not in raw:
                continue
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            u = (ev.get("message") or {}).get("usage")
            if ev.get("type") != "assistant" or not isinstance(u, dict):
                continue
            if int(u.get("cache_read_input_tokens") or 0) + int(u.get("cache_creation_input_tokens") or 0):
                ts = parse_ts(ev.get("timestamp"))
                if ts:
                    last = ts
                    cc = u.get("cache_creation") or {}
                    ttl_1h = bool(int(cc.get("ephemeral_1h_input_tokens") or 0))
                    break
        if last is None:
            last = path.stat().st_mtime
    except OSError:
        pass
    return last, (TTL_OVERRIDE or (3600 if ttl_1h else 300))


# ------------------------------------------------------------------ digest -----------------

def clean_prompt(text):
    text = re.sub(r"<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>.*?</\1>", " ", text, flags=re.S)
    return " ".join(text.split())


def msg_text(msg):
    c = (msg or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return " ".join(p.get("text", "") for p in c if isinstance(p, dict) and p.get("type") == "text")
    return ""


def digest(path):
    """One streaming pass over the transcript -> the facts the handoff needs."""
    r = {"prompts": [], "reply": "", "files": [], "cmds": [], "todos": [], "tasks": {}, "task_n": 0,
         "model": None, "ctx": 0, "first_ts": None}
    seen_files = {}
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            kind, msg = ev.get("type"), ev.get("message") or {}
            r["first_ts"] = r["first_ts"] or parse_ts(ev.get("timestamp"))
            if kind == "user" and not ev.get("isMeta"):
                t = clean_prompt(msg_text(msg))
                if t:
                    r["prompts"].append(t)
            elif kind == "assistant":
                if msg.get("model") and not str(msg["model"]).startswith("<"):
                    r["model"] = msg["model"]
                u = msg.get("usage")
                if isinstance(u, dict) and not ev.get("isSidechain"):
                    r["ctx"] = (int(u.get("input_tokens") or 0) + int(u.get("cache_read_input_tokens") or 0)
                                + int(u.get("cache_creation_input_tokens") or 0))
                t = msg_text(msg).strip()
                if t:
                    r["reply"] = t
                for part in (msg.get("content") if isinstance(msg.get("content"), list) else []):
                    if not (isinstance(part, dict) and part.get("type") == "tool_use"):
                        continue
                    name, inp = part.get("name", ""), part.get("input") or {}
                    if name in EDIT_TOOLS:
                        fp = inp.get("file_path") or inp.get("notebook_path")
                        if fp:
                            seen_files[fp] = name
                    elif name == "Bash" and inp.get("command"):
                        r["cmds"].append(" ".join(str(inp["command"]).split())[:160])
                    elif name == "TodoWrite" and isinstance(inp.get("todos"), list):
                        r["todos"] = [(str(x.get("content", ""))[:120], x.get("status", "pending"))
                                      for x in inp["todos"] if isinstance(x, dict)]
                    elif name == "TaskCreate":
                        r["task_n"] += 1
                        r["tasks"][str(r["task_n"])] = [str(inp.get("subject", ""))[:120], "pending"]
                    elif name == "TaskUpdate" and str(inp.get("taskId")) in r["tasks"]:
                        if inp.get("status") == "deleted":
                            r["tasks"].pop(str(inp["taskId"]), None)
                        elif inp.get("status"):
                            r["tasks"][str(inp["taskId"])][1] = inp["status"]
    r["files"] = list(seen_files)[-15:]
    r["prompts"] = r["prompts"][-4:]
    r["cmds"] = r["cmds"][-6:]
    if not r["todos"]:
        r["todos"] = [tuple(v) for v in r["tasks"].values()]
    return r


def git(cwd, *args):
    try:
        out = subprocess.run(["git", "-C", cwd] + list(args), capture_output=True, text=True, timeout=3)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def cold_cost(ctx, model):
    """(usd, gbp) to re-write `ctx` tokens to the cache, via statusbar's price table if available."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import statusbar
        cfg = statusbar.load_cfg()
        usd = statusbar.usage_cost_usd({"cache_creation_input_tokens": ctx}, model, cfg)
        return usd, usd * float(cfg["usd_gbp"])
    except Exception:
        return None, None


def trim(s, n):
    s = s.strip()
    return s if len(s) <= n else s[:n].rstrip() + " ..."


def build(d, path, sid, reason, last_ts, ttl):
    r = digest(path)
    cwd = d.get("cwd") or ""
    usd, gbp = cold_cost(r["ctx"], r["model"])
    lines = [f"# Handoff: session {sid}",
             f"Written {time.strftime('%Y-%m-%d %H:%M')} ({reason}). Folder: {cwd or 'unknown'}. "
             f"Model: {r['model'] or 'unknown'}.", ""]
    body = []
    if cwd:
        branch, status, recent = (git(cwd, "branch", "--show-current") or git(cwd, "rev-parse", "--short", "HEAD"),
                                  git(cwd, "status", "--porcelain"),
                                  git(cwd, "log", "--oneline", "-5"))
        if branch:
            sl = status.splitlines()
            body += ["## Git", f"- branch `{branch}`, {len(sl)} uncommitted change(s)"]
            body += [f"  - `{x}`" for x in sl[:12]] + (["  - ..."] if len(sl) > 12 else [])
            body += [f"- recent: `{x}`" for x in recent.splitlines()]
            body.append("")
    if r["todos"]:
        body += ["## Tasks"] + [f"- [{'x' if s == 'completed' else ' '}] {c} ({s})" for c, s in r["todos"]] + [""]
    if r["prompts"]:
        body += ["## Recent requests (oldest first)"] + [f"- {trim(p, 400)}" for p in r["prompts"]] + [""]
    if r["reply"]:
        body += ["## Last reply", trim(r["reply"], 1500), ""]
    if r["files"]:
        body += ["## Files edited"] + [f"- `{x}`" for x in r["files"]] + [""]
    if r["cmds"]:
        body += ["## Recent commands"] + [f"- `{x}`" for x in r["cmds"]] + [""]
    text_est = max(1, sum(len(x) for x in body) // 4)
    cost = ""
    if gbp is not None:
        cost = f", about £{gbp:.2f} at the cache-write rate (estimate)"
    lines += [f"Rebuilding this session's full context on resume = about {r['ctx']:,} tokens{cost}. "
              f"This file is about {text_est:,} tokens.", ""]
    lines += body
    lines += ["## How to resume",
              f"- Cheap: start a NEW session in this folder and say: Continue from @{OUT_DIR / (safe(sid) + '.md')}",
              f"- Full: `claude --resume {sid}` (re-reads the whole context; the cache is cold or about to be)", ""]
    return "\n".join(lines), r, text_est


def write_handoff(d, source, reason):
    path = resolve_transcript(d, source)
    if not path:
        return None
    sid = session_id(d)
    last_ts, ttl = cache_clock(path)
    text, r, est = build(d, path, sid, reason, last_ts, ttl)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / (safe(sid) + ".md")
    tmp = out.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, out)
    meta = {"session_id": sid, "cwd": d.get("cwd") or "", "source": source, "reason": reason, "written": time.time(),
            "cache_ts": last_ts, "ttl": ttl, "ctx_tokens": r["ctx"], "handoff_tokens": est, "path": str(out)}
    (OUT_DIR / (safe(sid) + ".json")).write_text(json.dumps(meta), encoding="utf-8")
    log_db(meta)
    prune()
    return meta


def log_db(m):
    try:
        import sqlite3
        Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(DB_PATH, timeout=5)
        db.execute("""CREATE TABLE IF NOT EXISTS handoff_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, reason TEXT,
          ttl INTEGER, context_tokens INTEGER, handoff_tokens INTEGER, path TEXT)""")
        db.execute("INSERT INTO handoff_events(session_id,ts,reason,ttl,context_tokens,handoff_tokens,path) "
                   "VALUES(?,?,?,?,?,?,?)",
                   (m["session_id"], now_iso(), m["reason"], m["ttl"], m["ctx_tokens"], m["handoff_tokens"], m["path"]))
        db.commit()
        db.close()
    except Exception:
        pass


def prune():
    try:
        files = sorted(OUT_DIR.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[KEEP:]:
            for q in (p, p.with_suffix(".json"), p.with_suffix(".job")):
                try:
                    q.unlink()
                except OSError:
                    pass
    except Exception:
        pass


# ------------------------------------------------------------------ watcher ----------------

def current_meta(sid):
    try:
        return json.loads((OUT_DIR / (safe(sid) + ".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def arm(d, source):
    path = resolve_transcript(d, source)
    if not path:
        return
    sid = session_id(d)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    job = OUT_DIR / (safe(sid) + ".job")
    job.write_text(json.dumps({"token": token, "d": {"session_id": sid, "cwd": d.get("cwd"),
                                                       "transcript_path": str(path)},
                               "source": source, "started": time.time()}), encoding="utf-8")
    kw = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
          "close_fds": True}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200      # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "watch", str(job), token], **kw)


def watch(jobfile, token):
    started = time.time()
    while True:
        try:
            job = json.loads(Path(jobfile).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if job.get("token") != token:           # a newer watcher (or `end`) replaced this one
            return
        d, source = job["d"], job.get("source") or "claude-code"
        path = resolve_transcript(d, source)
        if not path:
            return
        last, ttl = cache_clock(path)
        if last is None:
            return
        due = last + ttl - LEAD
        if time.time() >= due:
            late = time.time() >= last + ttl
            write_handoff(d, source, "cache-expired" if late else "cache-expiring")
            return
        if time.time() - started > 3600 + 900:  # never linger
            return
        time.sleep(max(1.0, min(due - time.time(), 20.0)) + 0.5)


def end(d, source):
    sid = session_id(d)
    job = OUT_DIR / (safe(sid) + ".job")
    try:
        job.unlink()                            # invalidates the watcher's token
    except OSError:
        pass
    path = resolve_transcript(d, source)
    if not path:
        return
    last, _ = cache_clock(path)
    meta = current_meta(sid)
    if meta and last and meta.get("cache_ts") == last:
        return                                  # already have a handoff for the latest activity
    write_handoff(d, source, "session-end")


# ------------------------------------------------------------------ session start ----------

def start(d):
    cwd = d.get("cwd") or ""
    if not cwd or (d.get("source") or "startup") not in ("startup", "clear"):
        return None
    me, best = session_id(d), None
    for p in OUT_DIR.glob("*.json"):
        try:
            m = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if m.get("cwd") != cwd or m.get("session_id") == me:
            continue
        if time.time() - m.get("written", 0) > MAX_AGE_H * 3600:
            continue
        if not best or m.get("written", 0) > best.get("written", 0):
            best = m
    if not best or not Path(best.get("path") or "").is_file():
        return None
    def n(v):
        return f"{v:,}" if isinstance(v, (int, float)) else "?"
    note = (f"tokenomics handoff: a recent session in this folder left a handoff "
            f"(about {n(best.get('handoff_tokens'))} tokens vs {n(best.get('ctx_tokens'))} to resume it in full). "
            f"Say 'Continue from @{best['path']}' to pick it up cheaply.")
    out = {"systemMessage": note}
    if INJECT:
        out["hookSpecificOutput"] = {"hookEventName": "SessionStart",
                                     "additionalContext": Path(best["path"]).read_text(encoding="utf-8")}
    return out


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "arm"
    try:
        if mode == "watch":
            watch(sys.argv[2], sys.argv[3])
            return
        if not ENABLED:
            return
        source = sys.argv[2] if len(sys.argv) > 2 else "claude-code"
        raw = sys.stdin.read()
        d = json.loads(raw) if raw.strip() else {}
        if mode == "arm":
            arm(d, source)
        elif mode == "end":
            end(d, source)
        elif mode == "write":
            m = write_handoff(d, source, "manual")
            if m:
                print(m["path"])
        elif mode == "start":
            out = start(d)
            if out:
                print(json.dumps(out))
    except Exception:
        log_err(mode)
    sys.exit(0)


if __name__ == "__main__":
    main()
