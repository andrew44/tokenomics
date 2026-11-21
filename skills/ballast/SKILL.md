---
name: ballast
description: Context carry cost - replays a session to find where the user switched to a new task while the conversation still carried a large context from the last one, and what re-reading that old context cost at every later step; explains the ballast hook's notices. Use when asked "should I /clear or /compact", "is my context too big", "does starting a new chat save money", "what did carrying context cost", "ballast", or after a ballast notice.
---

# ballast: what did carrying old context into new work cost?

Every step re-sends the whole conversation. Starting a different task in the same chat drags the last task's context along, and it is re-read at every step. The ballast hook warns as it happens; this skill replays a session afterwards.

## 1. Replay

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" ballast.ts check --json
```

- Newest session in this folder by default; `--session <id>` or `--transcript <file>` for another.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name ballast.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `peak_context`, and how many of `requests` ran above `min_tokens` (`heavy_read_usd`).
2. **Task switches** (`task_switches`): for each, the prompt preview, tokens carried, steps and cost; `carried_usd` in total. A switch is judged from the prompt's words, so ask the user whether any of them really needed the earlier context.
3. **What to do next time**: `/clear` when the new task doesn't need the old one (the doggybag hook keeps a resume note), or `/compact <what to keep>` when part of it matters. Nothing to switch? Say so plainly.

Settings: `TOKENOMICS_BALLAST=warn|block|off`, `TOKENOMICS_BALLAST_MIN_TOKENS` (default 60000). Never run `/clear` or `/compact` for the user.
