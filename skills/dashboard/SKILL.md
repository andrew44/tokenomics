---
name: dashboard
description: Opens the tokenomics dashboard, a local web page showing where tokens and money went (OPEX vs CAPEX, by project, by day, recent sessions). Use when asked to open, show, start or stop the dashboard, or for charts of token usage or spend.
argument-hint: "[demo|stop]"
allowed-tools: Bash(python3 *dashboard.py*), Bash(python *dashboard.py*)
---

# dashboard

The script ships with this plugin at `${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.py`. It starts a small read-only web server on 127.0.0.1 in the background, opens the browser and returns straight away.

The user asked: `$ARGUMENTS` (empty means open the dashboard with their real data).

| The user wants... | Run |
|---|---|
| Open it (default) | `python3 "${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.py" --background` |
| A preview with sample data | `... --background --demo` |
| Stop it | `... --stop` |

On Windows use `python` in place of `python3`. If `CLAUDE_PLUGIN_ROOT` is empty, locate the script: `find ~/.claude/plugins -name dashboard.py -path "*tokenomics*" 2>/dev/null | head -1`.

Reply in one sentence with the URL it printed. If it says there's no data yet, suggest `demo` for a preview: spendlens fills it in as they work.
