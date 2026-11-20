---
name: haggle
description: Quotes the likely cost of a task before an agent starts it (input, output and tool costs, from the user's own history), answers whether it is worth a given amount, and manages task contracts - an agreed target and maximum spend that the agent must ask to exceed. Use when asked "how much will this cost", "is this task worth spending £2 on", "quote this", "set a budget for this task", "approve more spend", or "haggle".
---

# haggle: is this task worth spending £2 on?

Give every substantial task a price before work starts. All figures come from the script.

## 1. Quote it

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" haggle.ts quote "<the task, in the user's words>" --price 2 --json
```

- `--price` is the amount the user named, in their currency (omit if none). Pass `--model <id>` if they'll run it on a specific model, and `--context <tokens>` when continuing a long session (the statusline shows the context size).
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name haggle.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Answer first**: the `verdict` when a price was given ("Yes / Probably / Tight / Unlikely"), else the quote: `mid`, likely range `low`–`high`.
2. **Breakdown**: input (re-reading the context each turn), tools (new material added to the context), output; ~`turns` turns on `model`. Mention whether it is from their own history (`samples`) or defaults, and any calibration.
3. **Ways to make it cheaper** if the price is tight: start a fresh session (smaller context), a cheaper model for routine parts, narrower scope.
4. **How to lock the price in**: start the task with `haggle £2: <task>`. The agent is then stopped at £2 and must ask; reply `haggle +£1` or `approve` to continue, `haggle off` to drop it.

## 3. Contracts

- Substantial prompts get an automatic quote (a notice, never a stop) unless `TOKENOMICS_HAGGLE=off`. `TOKENOMICS_HAGGLE=strict` enforces every quote's cap.
- History, quoted vs actual: `haggle.ts status`. Use it to say how accurate quotes have been.
