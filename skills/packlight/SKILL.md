---
name: packlight
description: Fixed overhead audit - measures the tokens every request carries before you type (system prompt, MCP server tool definitions, skill descriptions, instruction files) from your own sessions, what re-reading it costs a month, and which MCP servers and skills you never use, with the saving from removing them. Use when asked "why does every session start so big", "which MCP servers do I actually use", "too many skills or plugins", "fixed cost per request", "baseline context", "unused tools", or "packlight".
---

# packlight: what does every request carry, and do you use it?

The fixed load (system prompt, every MCP server's tools, a line per skill, instruction files) rides along with every step of every session. You measure it from the user's own transcripts and point at what to take out. Every number comes from the script.

## 1. Measure

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" packlight.ts --json
```

- Default: the last 30 days of Claude Code sessions. `--days 7` for a shorter window; `--dir <project>` to check another project's `.mcp.json`. Read-only.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name packlight.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `baseline.median` tokens before the first word; `overhead_usd` (`overhead_share` of `spend_usd`) and `overhead_per_month_usd`.
2. **MCP servers** never called in the period (`unused.mcp`), with where each is configured. Their size can't be read without connecting, so say the drop will show in `baseline.by_week` after disabling them.
3. **Skills** never used (`unused.skills`) and `savings.per_month_usd` from removing them (exact: description tokens), with its `basis`.
4. **Trend**: if `baseline.by_week` has several weeks, say whether the baseline is growing.
5. **Offer the cleanup**, and do only what the user approves: `claude mcp remove <name>` (or disable per project in `/mcp`), `/plugin` to disable a plugin, deleting a skill folder. Suggest `springclean` for CLAUDE.md and friends.

Never call a server "unused" if `sessions` is 0: there is no evidence either way. Changing MCP servers or skills mid-session changes the prompt prefix, so the next request rebuilds the cache once: suggest doing it between sessions.
