---
name: allyoucaneat
description: Plan fit - sets the user's recorded Claude Code spend (priced at API rates) against pay-as-you-go and each subscription (Pro, Max 5x, Max 20x), says whether their plan pays for itself or whether another would cost less, and shows the heaviest 5-hour stretch and week that usage limits bite on. Use when asked "am I on the right plan", "should I get Max", "is Pro worth it", "subscription or API", "would a subscription be cheaper", "am I overpaying", or "allyoucaneat".
---

# allyoucaneat: are you on the right plan?

spendlens prices every session at API rates, whichever way the user pays, so the ledger already holds the pay-as-you-go price of their real work. You compare it with the plans, from the script's numbers only.

## 1. Measure

Ask which plan they are on if you don't know (pay-as-you-go `api`, `pro`, `max5`, `max20`), then:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" allyoucaneat.ts --plan <plan> --json
```

- `--months 6` for a longer view. Read-only.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name allyoucaneat.ts -path "*tokenomics*" 2>/dev/null | head -1`.

## 2. Reply format

1. **Headline**: `typical_usd` a month and its `basis`; `verdict` in plain words.
2. **Options**: each plan's monthly cost against pay-as-you-go (`options`).
3. **Advice** from `advice`, with `peak_5h_usd` and `peak_week_usd` as the reason limits may matter.

Always say that prices and limits change and are on claude.com/pricing, and that a subscription below their spend is a candidate, not a promise. If `empty` or `too_early`, say how long to wait. Never change the user's plan or billing.
