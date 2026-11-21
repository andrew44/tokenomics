---
name: waffle
description: Output spend audit - splits what the agent wrote into replies, tool input (edits, files, commands) and thinking, and costs the avoidable part - long replies, end-of-task recaps, whole-file rewrites instead of edits, heavy thinking on routine work - with the instruction or setting that fixes each. Use when asked "are the replies too long", "why is output so expensive", "output tokens", "verbose AI", "stop the summaries", "thinking cost", or "waffle".
---

# waffle: are you paying for words you don't read?

Output tokens cost five times input tokens and are never cached. You find the part of the output bill that bought nothing, from the script's numbers only.

## 1. Measure

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" waffle.ts --json              # newest session in this folder
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" waffle.ts --days 7 --json     # every session this week
```

- `--session <id>` or `--transcript <file>` for one session. Read-only.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name waffle.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `output_usd` and `output_share` of `spend_usd`; the split (`split_share`: replies, tool input, thinking).
2. **Avoidable** (`by_kind`, `avoidable_usd`): long replies, recaps, whole-file rewrites, with the top `findings`.
3. **Fixes** from `tips`, as exact text the user can paste (a CLAUDE.md line, an output style, Edit over Write, a lower effort).
4. **Offer** to add the brevity line to CLAUDE.md, and add it only if the user agrees (at the end of the session: it changes the prompt prefix).

Keep your own reply short. Tool input that is real work (new code, needed edits) is not waste; only `findings` are.
