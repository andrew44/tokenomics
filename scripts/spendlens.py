#!/usr/bin/env python3
"""tokenomics / spendlens: tag each AI coding session OPEX (run) or CAPEX (build), logged by session id.

Thin hook runner. The logic lives in the shared engine (tokenomics/engine); the platform
named by [source] picks its adapter (tokenomics/adapters). Same engine for every platform.

Usage (hook command):
  spendlens.py prompt   [source]   # every user prompt          (Claude: UserPromptSubmit, Copilot: userPromptSubmitted)
  spendlens.py tool     [source]   # every tool call            (Copilot: postToolUse; Claude reads its transcript instead)
  spendlens.py finalize [source]   # turn / session end         (Claude: Stop, SessionEnd; Copilot: sessionEnd)
  spendlens.py capabilities        # print what each platform adapter supports (JSON)

[source] is claude-code (default) or copilot. Reads the hook JSON on stdin, prints NOTHING
on hook runs (UserPromptSubmit stdout is injected into the model context), and always exits 0
so it can never block a session. Errors go to <db>.err. Stdlib only, Python 3.8+.

Settings (env): TOKENOMICS_DB, TOKENOMICS_STORE_PROMPT, TOKENOMICS_SKILL_MAP,
TOKENOMICS_LLM, TOKENOMICS_LLM_URL, TOKENOMICS_LLM_KEY, TOKENOMICS_LLM_MODEL, TOKENOMICS_LLM_TIMEOUT.
See README "Settings".
"""
import json
import os
import sys
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _fallback_log(text):
    db = os.environ.get("TOKENOMICS_DB", str(Path.home() / ".tokenomics" / "spendlens.db"))
    try:
        Path(db).parent.mkdir(parents=True, exist_ok=True)
        with open(db + ".err", "a") as f:
            f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n{text}\n")
    except Exception:
        pass


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "prompt"
    source = sys.argv[2] if len(sys.argv) > 2 else "claude-code"
    try:
        from tokenomics.config import load_settings
        from tokenomics.engine import session
        from tokenomics.platform.registry import get_adapter, report

        if mode == "capabilities":
            print(json.dumps(report(), indent=2))
            return
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        if not isinstance(payload, dict):
            payload = {}
        settings = load_settings()
        adapter = get_adapter(source)
        if mode == "finalize":
            session.finalize(adapter, payload, settings)
        elif mode == "tool":
            session.record_tool(adapter, payload, settings)
        else:
            session.record_prompt(adapter, payload, settings)
    except Exception:
        _fallback_log(traceback.format_exc())


if __name__ == "__main__":
    main()
    sys.exit(0)
