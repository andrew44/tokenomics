#!/usr/bin/env python3
"""Checks a real one-line install end to end. Run by .github/workflows/installer.yml on macOS,
Windows and Linux right after `install.sh` / `install.ps1`; not part of the unit tests.

  python installer_check.py [--expect-private-python] [--expect-plugin-log FILE]

It checks what the installer left behind, then runs every Claude Code hook *the way Claude Code
does*: the command string from hooks/hooks.json through bash (Git Bash on Windows) with
CLAUDE_PLUGIN_ROOT set. On Windows it also runs the Copilot PowerShell hook strings. Finally it
exercises the `tokenomics` command and uninstalls. Exits non-zero on the first failure.
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

WINDOWS = os.name == "nt"
HOME = Path.home()
TK = Path(os.environ.get("TOKENOMICS_HOME", str(HOME / ".tokenomics")))
APP = TK / "app"
CLAUDE_SETTINGS = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(HOME / ".claude"))) / "settings.json"
step = 0


def ok(cond, what, detail=""):
    global step
    step += 1
    print(f"{'PASS' if cond else 'FAIL'} {step:2}. {what}" + (f"\n        {detail}" if detail and not cond else ""),
          flush=True)
    if not cond:
        sys.exit(1)


def bash():
    if WINDOWS:   # what Claude Code uses on Windows; plain `bash` on PATH can be WSL's
        for p in (r"C:\Program Files\Git\bin\bash.exe", r"C:\Program Files\Git\usr\bin\bash.exe"):
            if Path(p).is_file():
                return p
    return shutil.which("bash")


def tokenomics(*args):
    launcher = shutil.which("tokenomics")
    if launcher is None:
        ok(False, "'tokenomics' command is on PATH", os.environ.get("PATH", ""))
    return subprocess.run([launcher, *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", stdin=subprocess.DEVNULL, timeout=120)


def main(args):
    # 1. What the installer left behind
    ok((APP / "scripts" / "cli.py").is_file(), "tokenomics downloaded to ~/.tokenomics/app")
    cached = (TK / "python").read_text(encoding="utf-8").strip() if (TK / "python").is_file() else ""
    ok(bool(cached) and Path(cached).is_file(), "installer recorded a working Python", cached)
    if "--expect-private-python" in args:
        ok("runtime" in cached.replace("\\", "/"), "the private Python was used", cached)
    v = subprocess.run([cached, "-c", "import sys; print(sys.version_info >= (3, 8))"],
                       capture_output=True, text=True)
    ok(v.stdout.strip() == "True", "recorded Python is 3.8+", v.stdout + v.stderr)

    settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    cmd = (settings.get("statusLine") or {}).get("command", "")
    ok("statusline.py" in cmd, "statusline is set in Claude Code settings", json.dumps(settings))
    if "--expect-plugin-log" in args:
        log = Path(args[args.index("--expect-plugin-log") + 1]).read_text(encoding="utf-8", errors="replace")
        ok("plugin install tokenomics@tokenomics" in log, "the installer added the Claude Code plugin", log)

    # 2. The statusline renders through the exact command written to settings.json
    sb = subprocess.run(cmd, shell=True, input=json.dumps({"model": {"display_name": "Opus"},
                        "context_window": {"used_percentage": 40}}), capture_output=True, text=True,
                        encoding="utf-8", errors="replace", timeout=60)
    ok(sb.returncode == 0 and "Opus" in sb.stdout, "statusline renders", sb.stdout + sb.stderr)

    # 3. Every Claude Code hook, run as Claude Code runs it
    hooks = json.loads((APP / "hooks" / "hooks.json").read_text(encoding="utf-8"))["hooks"]
    env = dict(os.environ, CLAUDE_PLUGIN_ROOT=str(APP))   # native path, as Claude Code passes it
    sid = f"ci-{int(time.time())}"
    payload = {"session_id": sid, "cwd": str(HOME), "transcript_path": str(HOME / "none.jsonl"),
               "prompt": "fix the failing deploy pipeline", "tool_name": "Read",
               "tool_input": {"file_path": str(HOME / "x.txt")}}
    sh = bash()
    ok(sh is not None, "bash (Git Bash on Windows) is available", "")
    for event, groups in hooks.items():
        for g in groups:
            for h in g["hooks"]:
                p = subprocess.run([sh, "-c", h["command"]], input=json.dumps(dict(payload, hook_event_name=event)),
                                   capture_output=True, text=True, encoding="utf-8", errors="replace",
                                   env=env, timeout=60)
                ok(p.returncode in (0, 2) and "not found" not in p.stderr,
                   f"hook {event}: {h['command'].split('run.sh')[-1].strip(' \"')}", p.stdout + p.stderr)
    db = TK / "spendlens.db"
    ok(db.is_file(), "spendlens recorded to ~/.tokenomics/spendlens.db")
    n = sqlite3.connect(str(db)).execute("SELECT COUNT(*) FROM sessions WHERE session_id=?", (sid,)).fetchone()[0]
    ok(n == 1, "the hook-run session is in the database", str(n))

    # 4. Copilot's PowerShell hook strings (Windows only)
    if WINDOWS:
        cp = json.loads((APP / "copilot-hooks.json").read_text(encoding="utf-8"))["hooks"]
        h = cp["userPromptSubmitted"][0]
        p = subprocess.run(["powershell", "-NoProfile", "-Command", h["powershell"]], cwd=str(APP),
                           input=json.dumps({"sessionId": sid + "-cp", "cwd": str(HOME), "prompt": "deploy"}),
                           capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
        ok(p.returncode == 0, "Copilot PowerShell hook runs", p.stdout + p.stderr)

    # 5. The `tokenomics` command
    r = tokenomics()
    ok(r.returncode == 0 and "Claude Code" in r.stdout, "`tokenomics` shows status", r.stdout + r.stderr)
    r = tokenomics("dashboard", "--demo", "--no-open", "--port", "8791")
    ok(r.returncode == 0 and "running on" in r.stdout, "`tokenomics dashboard` starts", r.stdout + r.stderr)
    import urllib.request
    with urllib.request.urlopen("http://127.0.0.1:8791/api/data?days=30", timeout=10) as resp:
        ok(resp.status == 200, "dashboard serves data")
    r = tokenomics("dashboard", "--stop")
    ok("Stopped" in r.stdout, "`tokenomics dashboard --stop`", r.stdout + r.stderr)
    r = tokenomics("report")
    ok(r.returncode == 0 and "tokenomics report" in r.stdout, "`tokenomics report`", r.stdout + r.stderr)

    # 6. Uninstall
    r = tokenomics("uninstall")
    ok(r.returncode == 0, "`tokenomics uninstall`", r.stdout + r.stderr)
    settings = json.loads(CLAUDE_SETTINGS.read_text(encoding="utf-8"))
    ok("statusLine" not in settings, "uninstall removed the statusline", json.dumps(settings))
    ok(not (APP / "scripts").exists(), "uninstall removed the app")
    ok(db.is_file(), "uninstall kept the recorded data")
    print("\nAll installer checks passed.")


if __name__ == "__main__":
    main(sys.argv[1:])
