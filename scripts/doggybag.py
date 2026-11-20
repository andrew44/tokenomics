#!/usr/bin/env python3
"""tokenomics / doggybag: pack up the session's leftovers before the prompt cache goes cold.

When the cache goes cold, resuming the full session re-writes the whole context to the cache at a
premium (1.25x input price). A doggybag is a small, deterministic digest (recent prompts, last
reply, files touched, tasks, git state) so you can carry on from it for a fraction of the tokens.
No model is called to write it.

Doggybags live with the project: <cwd>/.doggybag/<session>.md, plus latest.md (the newest one).
The folder carries its own .gitignore ("*"), so it is never committed, whatever the repo's rules.

Hook commands (all read the hook JSON on stdin, exit 0):
  doggybag.py arm    [source]  Stop (Claude Code) / userPromptSubmitted (Copilot): start a background
                               watcher that packs the doggybag LEAD seconds before the cache expires.
  doggybag.py prompt [source]  UserPromptSubmit: if this session's cache already went cold, make sure
                               a doggybag is packed and say how to carry on cheaply.
  doggybag.py end    [source]  SessionEnd: stop the watcher and pack a doggybag if none is current.
  doggybag.py start  [source]  SessionStart (startup, /clear): load the folder's latest doggybag.
  doggybag.py write  [source]  Pack one now (manual use; prints its path).
Internal: doggybag.py watch <jobfile> <token>

Env (the older TOKENOMICS_HANDOFF_* names still work):
  TOKENOMICS_DOGGYBAG          on (default) | off
  TOKENOMICS_DOGGYBAG_LEAD     seconds before expiry to pack (default 60)
  TOKENOMICS_DOGGYBAG_DIR      folder name inside the project (default .doggybag); an absolute path
                               puts every project's doggybags there instead
  TOKENOMICS_DOGGYBAG_INJECT   1 (default) = a new session or /clear loads the latest doggybag as
                               context; 0 = only say it exists
  TOKENOMICS_DOGGYBAG_COLD     warn (default) | block (pause the first cold prompt once) | off
  TOKENOMICS_DOGGYBAG_COLD_MIN_TOKENS  only speak up on a cold prompt above this context (default 20000)
  TOKENOMICS_DOGGYBAG_MAX_AGE_H  hours a doggybag is offered for (default 24)
  TOKENOMICS_DOGGYBAG_KEEP     doggybags kept per folder (default 10)
  TOKENOMICS_CACHE_TTL         cache lifetime in seconds (default: detected, 300 or 3600)
  TOKENOMICS_DB                SQLite path shared with spendlens (default ~/.tokenomics/spendlens.db)

Stdlib only. Errors go to <db>.err, never on screen.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
DB_PATH = os.environ.get("TOKENOMICS_DB", str(HOME / ".tokenomics" / "spendlens.db"))
FALLBACK_DIR = HOME / ".tokenomics" / "doggybags"     # when the project folder is unknown or read-only
LATEST = "latest.md"


def _env(name, default=None):
    """TOKENOMICS_DOGGYBAG_<name>, falling back to the old TOKENOMICS_HANDOFF_<name>."""
    for key in ("TOKENOMICS_DOGGYBAG" + name, "TOKENOMICS_HANDOFF" + name):
        v = os.environ.get(key)
        if v not in (None, ""):
            return v
    return default


DIR_SETTING = _env("_DIR", ".doggybag")
ENABLED = str(_env("", "on")).strip().lower() != "off"


def _int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


LEAD = _int(_env("_LEAD"), 60)
KEEP = _int(_env("_KEEP"), 10)
MAX_AGE_H = _int(_env("_MAX_AGE_H"), 24)
TTL_OVERRIDE = _int(os.environ.get("TOKENOMICS_CACHE_TTL"), 0)
INJECT = str(_env("_INJECT", "1")).strip().lower() not in ("0", "off", "no", "false")
COLD_MODE = str(_env("_COLD", "warn")).strip().lower()
COLD_MIN_TOKENS = _int(_env("_COLD_MIN_TOKENS"), 20000)
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
            f.write(now_iso() + " doggybag " + tag + "\n" + traceback.format_exc() + "\n")
    except Exception:
        pass


def session_id(d):
    sid = d.get("session_id") or d.get("sessionId") or (d.get("session") or {}).get("id")
    if sid:
        return str(sid)
    return "anon-" + hashlib.sha1(f"{d.get('cwd', '')}{time.strftime('%Y%m%d')}".encode()).hexdigest()[:16]


def safe(sid):
    return re.sub(r"[^A-Za-z0-9_.-]", "_", sid)[:80]


def bag_dir(cwd, create=False):
    """Where this folder's doggybags live: <cwd>/.doggybag (self-ignoring), or the fallback."""
    setting = Path(os.path.expanduser(DIR_SETTING))
    if setting.is_absolute():
        d = setting
    elif cwd and Path(cwd).is_dir():
        d = Path(cwd) / setting
    else:
        d = FALLBACK_DIR
    if create:
        try:
            d.mkdir(parents=True, exist_ok=True)
            ign = d / ".gitignore"
            if not ign.exists():
                ign.write_text("# tokenomics doggybags: local session notes, never committed\n*\n",
                               encoding="utf-8")
        except OSError:
            if d == FALLBACK_DIR:
                raise
            return bag_dir(None, create=True) if not setting.is_absolute() else d
    return d


def show(path, cwd):
    """A short way to name `path` to the user: relative to the project when it is inside it."""
    try:
        return str(Path(path).relative_to(cwd)) if cwd else str(path)
    except ValueError:
        return str(path)


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
    """(usd, amount in the display currency, symbol) to re-write `ctx` tokens to the cache."""
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import statusbar
        cfg = statusbar.load_cfg()
        usd = statusbar.usage_cost_usd({"cache_creation_input_tokens": ctx}, model, cfg)
        _, symbol, rate = statusbar.currency(cfg)
        return usd, usd * rate, symbol
    except Exception:
        return None, None, None


def trim(s, n):
    s = s.strip()
    return s if len(s) <= n else s[:n].rstrip() + " ..."


def build(d, path, sid, reason, last_ts, ttl):
    r = digest(path)
    cwd = d.get("cwd") or ""
    usd, amount, symbol = cold_cost(r["ctx"], r["model"])
    lines = [f"# Doggybag: session {sid}",
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
    if amount is not None:
        cost = f", about {symbol}{amount:,.2f} at the cache-write rate (estimate)"
    lines += [f"Rebuilding this session's full context on resume = about {r['ctx']:,} tokens{cost}. "
              f"This file is about {text_est:,} tokens.", ""]
    lines += body
    lines += ["## How to carry on",
              "- Cheap: `/clear` (or start a new session) in this folder; tokenomics loads this doggybag for you. "
              f"Or say: Continue from @{show(bag_dir(cwd) / LATEST, cwd)}",
              f"- Full: `claude --resume {sid}` (re-reads the whole context; the cache is cold or about to be)", ""]
    return "\n".join(lines), r, text_est


def pack(d, source, reason):
    """Write the doggybag for this session; returns its metadata (or None without a transcript)."""
    path = resolve_transcript(d, source)
    if not path:
        return None
    sid = session_id(d)
    cwd = d.get("cwd") or ""
    last_ts, ttl = cache_clock(path)
    text, r, est = build(d, path, sid, reason, last_ts, ttl)
    out_dir = bag_dir(cwd, create=True)
    out = out_dir / (safe(sid) + ".md")
    tmp = out.with_suffix(".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, out)
    try:
        shutil.copyfile(out, out_dir / LATEST)
    except OSError:
        pass
    meta = {"session_id": sid, "cwd": cwd, "source": source, "reason": reason, "written": time.time(),
            "cache_ts": last_ts, "ttl": ttl, "ctx_tokens": r["ctx"], "handoff_tokens": est, "model": r["model"], "path": str(out)}
    (out_dir / (safe(sid) + ".json")).write_text(json.dumps(meta), encoding="utf-8")
    log_db(meta)
    prune(out_dir)
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


def prune(out_dir):
    try:
        files = sorted((p for p in out_dir.glob("*.md") if p.name != LATEST),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[KEEP:]:
            for q in (p, p.with_suffix(".json"), p.with_suffix(".job")):
                try:
                    q.unlink()
                except OSError:
                    pass
    except Exception:
        pass


# ------------------------------------------------------------------ watcher ----------------

def current_meta(sid, cwd):
    try:
        return json.loads((bag_dir(cwd) / (safe(sid) + ".json")).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def arm(d, source):
    path = resolve_transcript(d, source)
    if not path:
        return
    sid = session_id(d)
    token = uuid.uuid4().hex
    job = bag_dir(d.get("cwd") or "", create=True) / (safe(sid) + ".job")
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
            pack(d, source, "cache-expired" if late else "cache-expiring")
            return
        if time.time() - started > 3600 + 900:  # never linger
            return
        time.sleep(max(1.0, min(due - time.time(), 20.0)) + 0.5)


def end(d, source):
    sid = session_id(d)
    job = bag_dir(d.get("cwd") or "") / (safe(sid) + ".job")
    try:
        job.unlink()                            # invalidates the watcher's token
    except OSError:
        pass
    path = resolve_transcript(d, source)
    if not path:
        return
    last, _ = cache_clock(path)
    meta = current_meta(sid, d.get("cwd") or "")
    if meta and last and meta.get("cache_ts") == last:
        return                                  # already packed for the latest activity
    pack(d, source, "session-end")


# ------------------------------------------------------------------ session start ----------

def _n(v):
    return f"{v:,}" if isinstance(v, (int, float)) else "?"


def newest_other(cwd, me):
    best = None
    for p in bag_dir(cwd).glob("*.json"):
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
    return best if best and Path(best.get("path") or "").is_file() else None


def start(d):
    """SessionStart: a new session or /clear in a folder with a recent doggybag picks it up."""
    cwd = d.get("cwd") or ""
    if not cwd or (d.get("source") or "startup") not in ("startup", "clear"):
        return None
    best = newest_other(cwd, session_id(d))
    if not best:
        return None
    where = show(best["path"], cwd)
    sizes = f"about {_n(best.get('handoff_tokens'))} tokens vs {_n(best.get('ctx_tokens'))} to resume it in full"
    if INJECT:
        note = f"doggybag: carried on from {where} ({sizes})."
        ctx = ("[tokenomics doggybag] The previous session in this folder left this note of where it got to. "
               "Use it to carry on; don't repeat finished work, and re-read files before editing them.\n\n"
               + Path(best["path"]).read_text(encoding="utf-8"))
        return {"systemMessage": note,
                "hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}
    return {"systemMessage": f"doggybag: a recent session in this folder left {where} ({sizes}). "
                             f"Say 'Continue from @{where}' to pick it up cheaply."}


# ------------------------------------------------------------------ cold prompt ------------

def _cold_state(cwd):
    return bag_dir(cwd) / ".cold-state.json"


def prompt(d, source):
    """UserPromptSubmit: the user came back after the cache expired. Make sure the doggybag is packed
    (the watcher may have died with a sleeping laptop) and say how to carry on cheaply."""
    if COLD_MODE == "off":
        return None
    text = (d.get("prompt") or "").strip()
    if not text or text.startswith("/"):
        return None
    path = resolve_transcript(d, source)
    if not path:
        return None
    last, ttl = cache_clock(path)
    if last is None or time.time() < last + ttl:
        return None                              # cache still warm: nothing to say
    sid, cwd = session_id(d), d.get("cwd") or ""
    meta = current_meta(sid, cwd)
    if not (meta and meta.get("cache_ts") == last and Path(meta.get("path") or "").is_file()):
        meta = pack(d, source, "cache-expired")
    if not meta or (meta.get("ctx_tokens") or 0) < COLD_MIN_TOKENS:
        return None
    usd, amount, symbol = cold_cost(meta["ctx_tokens"], meta.get("model"))
    cost = f" (about {symbol}{amount:,.2f})" if amount is not None else ""
    where = show(bag_dir(cwd) / LATEST, cwd)
    mins = int((time.time() - last) // 60)
    msg = (f"doggybag: the prompt cache went cold {mins} min ago, so this prompt re-writes about "
           f"{_n(meta['ctx_tokens'])} tokens{cost}. Cheaper: /clear and your doggybag "
           f"({_n(meta.get('handoff_tokens'))} tokens, {where}) loads automatically.")
    if COLD_MODE == "block":
        digest_ = hashlib.sha1(f"{sid}:{last}".encode()).hexdigest()
        st = _cold_state(cwd)
        try:
            seen = json.loads(st.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            seen = []
        if digest_ not in seen:
            try:
                st.write_text(json.dumps((seen + [digest_])[-50:]), encoding="utf-8")
            except OSError:
                pass
            return {"decision": "block", "reason": msg + " Send your prompt again to carry on here anyway."}
    return {"systemMessage": msg}


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "arm"
    try:
        if mode == "watch":
            watch(sys.argv[2], sys.argv[3])
            return
        if not ENABLED:
            return
        source = sys.argv[2] if len(sys.argv) > 2 else "claude-code"
        raw = "" if (mode == "write" and sys.stdin.isatty()) else sys.stdin.read()
        d = json.loads(raw) if raw.strip() else {}
        if mode == "write" and not d:
            t = guess_transcript(os.getcwd())
            d = {"cwd": os.getcwd(), "transcript_path": str(t or ""), "session_id": t.stem if t else None}
        out = None
        if mode == "arm":
            arm(d, source)
        elif mode == "end":
            end(d, source)
        elif mode == "write":
            m = pack(d, source, "manual")
            print(m["path"] if m else "doggybag: no transcript found for this folder")
        elif mode == "start":
            out = start(d)
        elif mode == "prompt":
            out = prompt(d, source)
        if out:
            print(json.dumps(out))
    except Exception:
        log_err(mode)
    sys.exit(0)


def guess_transcript(cwd):
    """Newest Claude Code transcript for `cwd` (for a manual `write` run from a terminal)."""
    base = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(HOME / ".claude"))) / "projects"
    folder = base / re.sub(r"[^A-Za-z0-9]", "-", str(Path(cwd).resolve()))
    return newest_jsonl(folder) if folder.is_dir() else None


if __name__ == "__main__":
    main()
