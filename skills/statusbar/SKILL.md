---
name: statusbar
description: Installs, updates, checks or removes the tokenomics status bar (live context fill, tokens, cost and a prompt-cache countdown at the bottom of Claude Code or Copilot CLI), and sets its currency or theme. Use when asked to install, set up, turn on, fix, remove or change the status bar or status line.
argument-hint: "[install|uninstall|status|preview] [claude|copilot|both]"
allowed-tools: Bash(sh *run.sh statusbar.py*), Bash(python3 *statusbar.py*), Bash(python *statusbar.py*)
---

# statusbar

The script ships with this plugin at `${CLAUDE_PLUGIN_ROOT}/scripts/statusbar.py`. Run it with Bash and report what it printed in one or two plain sentences. Do not edit settings files by hand.

The user asked: `$ARGUMENTS` (empty means install for Claude Code).

## What to run

| The user wants... | Run |
|---|---|
| Install (default) | `sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" statusbar.py --install claude` |
| Install for Copilot CLI, or both | `... --install copilot` or `... --install both` |
| Check whether it's on | `... --status` |
| Remove it | `... --uninstall claude` (or `copilot` / `both`) |
| Preview what it looks like | `... --demo` (add `--theme light` or `--theme dark`) |
| Change currency | `... --set-currency GBP` (or `USD`, `EUR`) |
| Refresh exchange rates | `... --update-rate` |

The `run.sh` launcher finds a working Python on any OS (including Windows). If `CLAUDE_PLUGIN_ROOT` is empty, locate the script: `find ~/.claude/plugins ~/.copilot -name statusbar.py -path "*tokenomics*" 2>/dev/null | head -1`.

## Before installing

Run `--status` first. If it reports **another status line** for that CLI, tell the user which command is set and ask before replacing it (`--install` overwrites it; a backup is saved as `settings.json.tokenomics.bak`).

## After installing

Tell the user to restart Claude Code (or Copilot CLI) to see the bar. In the Claude desktop app it shows in the band above the prompt box; in VS Code, as the plugin's line above the prompt box. Mention that it updates itself whenever the plugin updates, and that `/tokenomics:statusbar uninstall` removes it.
