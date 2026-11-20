---
name: statusline
description: Installs, updates, checks or removes the tokenomics statusline (live context fill, tokens, cost and a prompt-cache countdown at the bottom of Claude Code or Copilot CLI in a terminal), turns the band (the same line above the prompt box in the Claude desktop app) on or off, and sets their currency or theme. Use when asked to install, set up, turn on, fix, remove or change the statusline, status line, status bar or band.
argument-hint: "[install|uninstall|status|preview|band on|band off] [claude|copilot|both]"
allowed-tools: Bash(sh *run.sh statusline.py*), Bash(python3 *statusline.py*), Bash(python *statusline.py*)
---

# statusline

tokenomics shows one live line (model, context fill, tokens, cost, cache countdown) in two places. Keep them apart when you talk to the user:

- **The statusline**: the CLI's own status line at the bottom of Claude Code or Copilot CLI **in a terminal**. It is a `statusLine` entry in the CLI's `settings.json`, so it is installed and removed per CLI.
- **The band**: the same line in the **Claude desktop app**, in the band above the prompt box (in VS Code, the plugin's line above the prompt box). It comes with the plugin, on by default, whether or not the statusline is installed, and is turned on or off here.

The script ships with this plugin at `${CLAUDE_PLUGIN_ROOT}/scripts/statusline.py`. Run it with Bash and report what it printed in one or two plain sentences. Do not edit settings files by hand.

The user asked: `$ARGUMENTS` (empty means install the statusline for Claude Code).

## What to run

| The user wants... | Run |
|---|---|
| Install the statusline (default) | `sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" statusline.py --install claude` |
| Install it for Copilot CLI, or both | `... --install copilot` or `... --install both` |
| Check what's on | `... --status` (the statusline per CLI, and the band) |
| Remove the statusline | `... --uninstall claude` (or `copilot` / `both`) |
| Hide or show the band in the desktop app | `... --band-off` / `... --band-on` |
| Preview what it looks like | `... --demo` (add `--theme light` or `--theme dark`) |
| Change currency (both) | `... --set-currency GBP` (or `USD`, `EUR`) |
| Refresh exchange rates | `... --update-rate` |

The `run.sh` launcher finds a working Python on any OS (including Windows). If `CLAUDE_PLUGIN_ROOT` is empty, locate the script: `find ~/.claude/plugins ~/.copilot -name statusline.py -path "*tokenomics*" 2>/dev/null | head -1`.

If the user says "status bar" or "statusbar" (the old name), they mean the statusline in a terminal and the band in the desktop app; ask which only if it changes what you run.

## Before installing the statusline

Run `--status` first. If it reports **another status line** for that CLI, tell the user which command is set and ask before replacing it (`--install` overwrites it; a backup is saved as `settings.json.tokenomics.bak`). The band doesn't need this: it shows in the desktop app either way.

## After installing

Tell the user to restart Claude Code (or Copilot CLI) in the terminal to see the statusline. Mention that it updates itself whenever the plugin updates, that `/tokenomics:statusline uninstall` removes it, and that the desktop app has the band regardless (`/tokenomics:statusline band off` hides it).
