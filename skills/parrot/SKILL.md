---
name: parrot
description: Repeated-instruction audit - finds what the user keeps telling the AI across sessions (standing rules like "always use pnpm", corrections like "no, use the v2 client", whole prompts pasted again and again), what the corrected work cost, and turns each into a CLAUDE.md line or a slash command; explains the parrot hook's notices. Use when asked "what do I keep repeating", "what should go in CLAUDE.md", "why do I keep correcting it", "make my instructions stick", "slash command ideas", "parrot", or after a parrot notice.
---

# parrot: say it once, not every session

A rule typed in a prompt lasts one session; the same line in CLAUDE.md lasts for all of them. You find the repeats and offer to write them down, from the script's output only.

## 1. Find the repeats

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" parrot.ts report --here --json        # this project, last 30 days
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" parrot.ts report --days 90 --json     # every project
```

- `--min 2` to catch rarer repeats. Read-only; it reads the user's own local transcripts.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name parrot.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `repeat_count` across `sessions`; `corrections` (`correction_rate`) and `corrected_usd`.
2. **Repeats** (`repeats`): the phrase, how many sessions, and its `suggestion`. Rules and corrections become one short CLAUDE.md line each, worded as a rule (drop the "no," and "please"); whole prompts become `.claude/commands/<name>.md`.
3. **Offer** to add the lines or create the commands, and do it only if the user agrees: show the exact lines first, merge with what the file already says, and never duplicate a line (`in_instructions: true` means it is already there and needs rewording, not repeating).

Settings: `TOKENOMICS_PARROT=warn|off`, `TOKENOMICS_PARROT_MIN` (default 3 sessions).
