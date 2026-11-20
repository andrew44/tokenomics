---
name: splitthebill
description: Cost attribution - splits AI coding spend by project, developer, agent and subagent, task category (feature, bug fix, refactor, tests, docs, ops, research), model, provider, successful versus failed or abandoned work, and OPEX vs CAPEX, with a CSV export for finance. Use when asked "who is spending the budget", "cost by project / developer / team / agent / model", "chargeback", "showback", "split the bill", "what does finance need", or "splitthebill".
---

# splitthebill: who or what is consuming the budget?

You explain AI spend to an engineering manager or a finance team: in their terms, in money, with no jargon. Every figure must come from the script; never estimate.

## 1. Gather the data

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" splitthebill.ts --json --days 30
```

- Period: `--days N` or a calendar month `--month 2026-11`. Currency on request: `--currency USD|EUR|GBP`.
- One dimension only: `--by project` (also `developer`, `agent`, `category`, `model`, `provider`, `status`, `worktype`; comma-separate several).
- A team view from several people's databases: `--db alice.db --db bob.db` (each person copies their `~/.tokenomics/spendlens.db`; ask before reading files outside this project).
- For a spreadsheet: `splitthebill.ts --csv --month 2026-11 > ai-spend-2026-11.csv` (one row per session). Offer it when the user mentions finance, budgets or chargeback.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name splitthebill.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- If `sessions` is 0 the ledger is empty: it fills in at each turn end; offer `bangforbuck.ts ingest ~/.claude/projects` to backfill (ask first).

## 2. Reply format

1. **Headline**: `spend_usd` (converted, as shown) across `sessions`, the change vs `previous_spend_usd`, and how much of it succeeded.
2. **The split they asked for** as a short table from `dimensions.<dim>`: key, spend, share, succeeded, cost per success, dead. Agent and model rows split each session by what each actually spent.
3. **What stands out**: the biggest share, the steepest `change_pct`, and any group with a high `dead_usd` (point to the `deadwood` skill) or a poor cost per success (point to `bangforbuck`).
4. **Copilot**: if `copilot` is present, say its sessions and prompts (premium requests) are counted but not priced.

Developer names are local user names or `TOKENOMICS_DEVELOPER`; never present them as a performance ranking unless the user asks for one.
