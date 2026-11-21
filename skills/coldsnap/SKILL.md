---
name: coldsnap
description: Prompt-cache miss audit - finds every time a conversation's cache had to be written again mid-session and why (a break longer than the cache lives, a model switch, a changed CLAUDE.md / MCP server / setting, or compaction), costs each rebuild against a warm read, and says whether the 1-hour cache would pay off. Use when asked "why is my cache hit rate low", "cache misses", "cache rebuilds", "why did that turn cost so much", "does switching model cost", "should I use the 1 hour cache", or "coldsnap".
---

# coldsnap: why did the cache go cold?

A warm cache makes re-sending the conversation cost a tenth of the input price; every rebuild re-writes all of it at 1.25x (or 2x). You explain where the rebuilds came from, from the script's numbers only.

## 1. Measure

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" coldsnap.ts --json              # newest session in this folder
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" coldsnap.ts --days 7 --json     # every session this week
```

- `--session <id>` or `--transcript <file>` for one session. Read-only.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name coldsnap.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `hit_ratio`, `rebuild_count`, `rebuild_usd` and how much is `avoidable_usd`.
2. **By cause** (`by_cause`), with the costliest `rebuilds` and their `detail`. Compaction is expected, never a mistake.
3. **Fixes** from `tips`, one per cause. Mention `ttl_1h` only when `net_usd` is positive.

Keep it short. Never change settings, models or instruction files for the user mid-session: that is itself a prefix change.
