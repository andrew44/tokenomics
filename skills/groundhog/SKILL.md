---
name: groundhog
description: Checks whether the agent has been going round in circles - repeated identical tool calls, the same command failing again and again, edits made and undone, tokens climbing with no progress - with what each loop cost, and explains the groundhog loop-breaker hook and its settings. Use when asked "is it stuck", "is it going round in circles", "why does it keep doing that", "loop", or "groundhog".
---

# groundhog: is the AI going round in circles?

## 1. Check the session

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" groundhog.ts check --json
```

- Newest session in this folder by default; `--session <id>` or `--transcript <file.jsonl>` for another.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name groundhog.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Verdict**: how many loops, and roughly what they cost (`usd`, an estimate of spend from the loop's first step on).
2. **Each loop**: the rule in plain words (same call again / command keeps failing / edit going back and forth / no progress), how many times, and the evidence in `reason`.
3. **A fresh strategy**: for a failing command, read the actual error and propose a different hypothesis; for flip-flopping edits, list what each version fixes and breaks; for no progress, summarise what has been learnt and suggest a new approach or a `/clear` with a short brief. Ask the user before changing course.

## 3. The hook (explain if asked)

The groundhog hook watches every tool call. The first time a loop is caught it refuses the call and tells the agent to change strategy. Settings: `TOKENOMICS_GROUNDHOG=block` (default: refuse twice, then let it through and tell the user), `interrupt` (refuse once, then end the turn), `warn` (never refuse), `off`. `TOKENOMICS_GROUNDHOG_REPEAT` (default 3) and `TOKENOMICS_GROUNDHOG_FAILS` (default 3) set the thresholds. A shell command ending in `# groundhog-ok` is never stopped.
