#!/usr/bin/env python3
"""tokenomics / dashboard: a local web UI over the spendlens SQLite database.

  python3 scripts/dashboard.py                 # serve http://127.0.0.1:8765
  python3 scripts/dashboard.py --port 9000 --db /path/to/spendlens.db
  python3 scripts/dashboard.py --demo          # seeded fake data, to preview the UI
  python3 scripts/dashboard.py --background    # start it in the background and return
  python3 scripts/dashboard.py --stop          # stop a background dashboard

Read-only: the DB is opened with mode=ro and never written to (except --demo, which uses a
temp file). Binds to 127.0.0.1 only. Stdlib only.
"""
import argparse
import json
import os
import random
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
INDEX = HERE.parent / "dashboard" / "index.html"
LABELS = ("opex", "capex", "mixed", "unknown")


def _zero():
    return {"sessions": 0, "prompts": 0, "tokens": 0, "input": 0, "output": 0,
            "cache_read": 0, "cache_creation": 0}


def _add(acc, r):
    inp, out = r["input_tokens"] or 0, r["output_tokens"] or 0
    acc["sessions"] += 1
    acc["prompts"] += r["prompt_count"] or 0
    acc["tokens"] += inp + out
    acc["input"] += inp
    acc["output"] += out
    acc["cache_read"] += r["cache_read_tokens"] or 0
    acc["cache_creation"] += r["cache_creation_tokens"] or 0


def build(db_path, days):
    if not Path(db_path).is_file():
        return {"empty": True, "db_path": str(db_path), "reason": "no-database"}
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5)
    try:
        db.row_factory = sqlite3.Row
        cols = {r[1] for r in db.execute("PRAGMA table_info(sessions)")}
        if not cols:
            return {"empty": True, "db_path": str(db_path), "reason": "no-table"}
        want = ["session_id", "source", "cwd", "label", "prompt_count", "first_seen", "updated_at",
                "input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
                "skills", "skill_detail"]
        sel = ", ".join(c if c in cols else f"NULL AS {c}" for c in want)
        rows = db.execute(f"SELECT {sel} FROM sessions ORDER BY first_seen").fetchall()
    finally:
        db.close()                                   # the server is long-running: never leak handles

    cutoff = None
    if days:
        cutoff = (datetime.now() - timedelta(days=days - 1)).strftime("%Y-%m-%d")
    rows = [r for r in rows if not cutoff or (r["first_seen"] or "")[:10] >= cutoff]

    totals = {k: _zero() for k in LABELS}
    daily, projects, skills, sources = {}, {}, {}, {}
    for r in rows:
        lab = r["label"] if r["label"] in LABELS else "unknown"
        _add(totals[lab], r)
        day = (r["first_seen"] or "")[:10] or "unknown"
        _add(daily.setdefault(day, {k: _zero() for k in LABELS})[lab], r)
        proj = (r["cwd"] or "unknown").rstrip("/\\")
        _add(projects.setdefault(proj, {k: _zero() for k in LABELS})[lab], r)
        sources[r["source"] or "unknown"] = sources.get(r["source"] or "unknown", 0) + 1
        try:
            detail = json.loads(r["skill_detail"]) if r["skill_detail"] else []
        except ValueError:
            detail = []
        for s in detail:
            k = s.get("name")
            if k:
                e = skills.setdefault(k, {"name": k, "side": s.get("side"), "sessions": 0})
                e["sessions"] += 1

    # dense daily series so quiet days show as gaps, not as missing bars
    series = []
    dated = [d for d in daily if d != "unknown"]
    if cutoff or dated:
        start = datetime.strptime(cutoff or min(dated), "%Y-%m-%d")
        end = datetime.now()
        d = start
        while d.date() <= end.date():
            key = d.strftime("%Y-%m-%d")
            series.append({"date": key, **{k: v for k, v in
                           daily.get(key, {k: _zero() for k in LABELS}).items()}})
            d += timedelta(days=1)

    recent = []
    for r in sorted(rows, key=lambda r: r["updated_at"] or "", reverse=True)[:12]:
        recent.append({"session_id": r["session_id"], "source": r["source"], "cwd": r["cwd"],
                       "label": r["label"], "prompts": r["prompt_count"] or 0,
                       "tokens": (r["input_tokens"] or 0) + (r["output_tokens"] or 0),
                       "updated_at": r["updated_at"]})
    proj_list = [{"cwd": p, "by": v} for p, v in projects.items()]
    return {
        "empty": not rows, "reason": "no-rows" if not rows else None,
        "db_path": str(db_path), "days": days,
        "generated": datetime.now(timezone.utc).isoformat(),
        "totals": totals, "daily": series, "projects": proj_list,
        "skills": sorted(skills.values(), key=lambda s: -s["sessions"])[:10],
        "sources": sources, "recent": recent,
    }


def seed_demo(path):
    sys.path.insert(0, str(HERE.parent))
    from tokenomics.engine import store
    db = store.connect(path)
    rnd = random.Random(7)
    projects = ["/work/payments-api", "/work/platform-infra", "/work/web-app",
                "/work/observability", "/work/data-pipeline"]
    bias = {"/work/payments-api": 0.25, "/work/platform-infra": 0.7, "/work/web-app": 0.1,
            "/work/observability": 0.92, "/work/data-pipeline": 0.35}
    skills = [("grafana-triage", "opex"), ("incident-review", "opex"), ("loki-queries", "opex"),
              ("frontend-design", "capex"), ("unit-tests", "capex"), ("skill-creator", "capex")]
    now = datetime.now()
    for i in range(190):
        age = int(abs(rnd.gauss(0, 24)))
        if age > 59:
            age = rnd.randint(0, 59)
        ts = now - timedelta(days=age, hours=rnd.randint(0, 9), minutes=rnd.randint(0, 59))
        if ts.weekday() >= 5 and rnd.random() < 0.7:
            continue
        proj = rnd.choice(projects)
        r = rnd.random()
        side = "opex" if r < bias[proj] else "capex"
        if rnd.random() < 0.12:
            side = "mixed"
        if rnd.random() < 0.05:
            side = "unknown"
        inp = int(rnd.lognormvariate(10.4, 0.8))
        out = int(inp * rnd.uniform(0.15, 0.6))
        if side == "capex":
            out = int(out * 1.8)
        cr = int(inp * rnd.uniform(6, 40))
        cc = int(inp * rnd.uniform(0.6, 2.5))
        sk = [s for s in skills if (s[1] == side) and rnd.random() < 0.35][:2]
        detail = [{"name": n, "side": sd, "basis": "name", "description": ""} for n, sd in sk]
        when = ts.strftime("%Y-%m-%dT%H:%M:%S+0000")
        db.execute("""INSERT INTO sessions(session_id,source,cwd,label,opex_score,capex_score,prompt_count,
                      first_seen,updated_at,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
                      total_tokens,skills,skill_opex,skill_capex,skill_detail)
                      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                   (f"demo-{i:04d}", rnd.choice(["claude-code"] * 4 + ["copilot"]), proj, side,
                    rnd.randint(0, 30), rnd.randint(0, 30), rnd.randint(2, 40), when, when,
                    inp, out, cc, cr, inp + out + cc + cr, json.dumps([n for n, _ in sk]),
                    sum(1 for _, sd in sk if sd == "opex"), sum(1 for _, sd in sk if sd == "capex"),
                    json.dumps(detail)))
    db.commit()
    db.close()


class Handler(BaseHTTPRequestHandler):
    db_path = None

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/", "/index.html"):
            try:
                self._send(200, INDEX.read_bytes(), "text/html; charset=utf-8")
            except OSError:
                self._send(500, "dashboard/index.html is missing", "text/plain")
        elif u.path == "/api/data":
            try:
                days = int(parse_qs(u.query).get("days", ["30"])[0])
                days = max(0, min(days, 3650))
                payload = build(self.db_path, days)
                self._send(200, json.dumps(payload), "application/json")
            except Exception as e:  # never crash the server on a bad DB
                self._send(500, json.dumps({"error": str(e)}), "application/json")
        else:
            self._send(404, "not found", "text/plain")


PID_FILE = Path(os.environ.get("TOKENOMICS_HOME", str(Path.home() / ".tokenomics"))) / "dashboard.pid"


def _port_busy(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _open(url, no_open):
    if not no_open:
        try:
            webbrowser.open(url)
        except Exception:
            pass


def background(a, argv):
    """Start the server as a detached process, wait until it answers, open the browser, return."""
    url = f"http://127.0.0.1:{a.port}/"
    if _port_busy(a.port):
        print(f"tokenomics dashboard is already running on {url}")
        _open(url, a.no_open)
        return 0
    args = [x for x in argv if x != "--background"] + ["--no-open"]
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    log = open(PID_FILE.with_name("dashboard.log"), "ab")
    kw = {"stdin": subprocess.DEVNULL, "stdout": log, "stderr": log, "close_fds": True}
    if os.name == "nt":
        kw["creationflags"] = 0x00000008 | 0x00000200     # DETACHED_PROCESS | NEW_PROCESS_GROUP
    else:
        kw["start_new_session"] = True
    proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), *args], **kw)
    PID_FILE.write_text(str(proc.pid), encoding="utf-8")
    for _ in range(50):
        if _port_busy(a.port):
            break
        if proc.poll() is not None:
            print(f"The dashboard failed to start; see {log.name}", file=sys.stderr)
            return 1
        time.sleep(0.1)
    print(f"tokenomics dashboard running on {url}{'  (demo data)' if a.demo else ''}\n"
          f"  stop it with: tokenomics dashboard --stop")
    _open(url, a.no_open)
    return 0


def stop():
    try:
        pid = int(PID_FILE.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        print("No background dashboard is running.")
        return 0
    try:
        os.kill(pid, 15)
        print(f"Stopped the dashboard (pid {pid}).")
    except OSError:
        print("No background dashboard is running.")
    try:
        PID_FILE.unlink()
    except OSError:
        pass
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=os.environ.get("TOKENOMICS_DB",
                    str(Path.home() / ".tokenomics" / "spendlens.db")))
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--demo", action="store_true", help="use seeded fake data in a temp DB")
    ap.add_argument("--no-open", action="store_true", help="do not open a browser tab")
    ap.add_argument("--background", action="store_true", help="run in the background and return")
    ap.add_argument("--stop", action="store_true", help="stop a background dashboard")
    a = ap.parse_args(argv)
    if a.stop:
        return stop()
    if a.background:
        return background(a, argv)
    db_path = a.db
    if a.demo:
        db_path = str(Path(tempfile.mkdtemp(prefix="tokenomics-demo-")) / "spendlens.db")
        seed_demo(db_path)
    Handler.db_path = db_path
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://127.0.0.1:{a.port}/"
    print(f"tokenomics dashboard on {url}\n  db: {db_path}{'  (demo data)' if a.demo else ''}\n  Ctrl+C to stop")
    _open(url, a.no_open)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
