---
name: deadwood
description: Dead work - measures AI spend that produced nothing - failed implementations, work discarded or rejected, abandoned tasks, repeated debugging and generated files never used - as a monthly report with the biggest losses by project, model and task category, from observable signals (tests, commits, reverts, refusals), never token counts. Use when asked "how much did we waste", "wasted AI spend", "what produced nothing", "failed or abandoned work", "monthly waste report", or "deadwood".
---

# deadwood: what did we pay for that produced nothing?

You measure wasted AI spend, not AI spend. Every number comes from the script, and every status rests on something that happened (a check, a commit, a revert, a refusal), never on token counts.

## 1. Gather the data

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" deadwood.ts --json
```

- Default: this calendar month. `--month 2026-10` for another, or `--days 30`. Add `--merged` to count how many committed sessions made it onto the main branch (accepted changes; it runs git).
- One session: `deadwood.ts session --json` (newest in this folder) or `--session <id>`.
- When the user knows better than the heuristics ("that one was thrown away", "we shipped that"): `deadwood.ts mark discarded --session <id>` or `mark accepted` (also `abandoned`, `failed`).
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name deadwood.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- `empty` true: the ledger has nothing yet; offer `bangforbuck.ts ingest ~/.claude/projects` (ask first).

## 2. Reply format

1. **Headline**: `dead_usd` of `spend_usd` (`dead_share`), and `change_pct` vs the period before.
2. **Dead work by kind** from `by_kind`: failed implementations, discarded work, abandoned tasks, repeated debugging, unused files.
3. **The biggest losses** from `worst`: day, project, status and why.
4. **Where it concentrates**: the top of `by_project`, `by_model` and `by_category` by dead share.
5. **Unverified work**: `unverified` sessions are not counted as waste; suggest marking them so next month's report is sharper.
6. **One or two actions**, tied to the numbers: run `sherlock` on the worst session; `groundhog` for repeated debugging; `blinkers` if discarded work was out of scope; `haggle` to cap tasks like the abandoned ones.

Research and Q&A sessions (`no_change`) are legitimate and never waste.
