#!/usr/bin/env python3
"""tokenomics / diet: stop tool calls that would flood the context with low-value text.

Pre-tool hook (Claude Code: PreToolUse on Read|Bash; Copilot: preToolUse). Denies, with a
reason the model acts on, things like reading package-lock.json whole, `kubectl logs` with no
--tail, `git log` with no -n, `cat` of a 2 MB file or `ls -R`. The model then retries with a
narrower call. Commands that already pipe, redirect or limit their output are left alone.

Usage (hook command):  diet.py [source]      source = claude-code (default) | copilot

Env:
  TOKENOMICS_DIET         block (default) | warn (notice only, never denies) | off
  TOKENOMICS_DIET_MAX_KB  files below this size are never blocked (default 64)
Bypass for one command: append `# diet-ok`. Rules: tokenomics/engine/diet.py.
Stdlib only. Always exits 0; a crash never blocks a tool call (errors go to <db>.err).
"""
import json
import os
import sys
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else "claude-code"
    mode = os.environ.get("TOKENOMICS_DIET", "block").strip().lower()
    try:
        if mode == "off":
            return
        from tokenomics.config import load_settings
        from tokenomics.engine import diet, events
        from tokenomics.platform.registry import get_adapter

        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            return
        adapter = get_adapter(source)
        call = adapter.tool_call(payload)
        if call is None:
            return
        verdict = diet.check(call, payload.get("cwd"))
        if verdict is None:
            return
        action = "warned" if mode == "warn" else "denied"
        out = adapter.notify(verdict.reason) if action == "warned" else adapter.deny_tool(verdict.reason)
        events.log(load_settings().db_path, "diet_events", session_id=adapter.session_id(payload),
                   source=adapter.name, tool=call.name, rule=verdict.rule,
                   est_tokens=verdict.est_tokens, action=action)
        if out:
            print(json.dumps(out))
    except Exception:
        from_env = os.environ.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db"))
        try:
            with open(from_env + ".err", "a") as f:
                f.write("diet\n" + traceback.format_exc() + "\n")
        except Exception:
            pass


if __name__ == "__main__":
    main()
    sys.exit(0)
