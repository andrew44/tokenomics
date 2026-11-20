---
name: bangforbuck
description: Measures whether AI coding spend is delivering value - the cost per completed feature, bug fixed, passing test suite, commit, PR and successful agent task, which models give the cheapest successful result, and how much went on sessions with nothing to show. Use when asked "is the AI worth the money", "value for money", "cost per feature/bug/outcome", "which model is best value", "bang for buck", or to record an outcome by hand.
---

# bangforbuck: is the AI delivering value for the money?

Tokens saved is the wrong measure. You report what it costs to get useful work done. Every number must come from the script output; never estimate or invent figures.

## 1. Gather the data

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" bangforbuck.ts report --json --days 30
```

- Period: use what the user asked (`--days 7`, `--days 90`, `--days 0` for all time). Currency on request: `--currency USD|EUR|GBP`.
- One session ("what did this session buy?"): `bangforbuck.ts session --json` (newest in this folder) or `--session <id>`.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name bangforbuck.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- If `empty` is true, the ledger has no sessions yet: it fills in at the end of every turn. Offer to backfill from old transcripts: `bangforbuck.ts ingest ~/.claude/projects` (ask first; it reads every transcript).
- Record work the heuristics can't see when the user says so ("that session shipped the export feature"): `bangforbuck.ts mark feature "csv export" --session <id>`. Kinds: feature, bug_fix, green_suite, commit, pr, agent_task, or a short word of their own.

## 2. How outcomes are detected (explain only if asked)

From what the agent did, not what it said: a test command that went from failing to passing is a bug fixed; a passing test run is a passing suite; a successful `git commit` / `gh pr create` counts; a build-type request ("add", "implement") that ended with edits committed or tests green is a completed feature; a subagent that returned without error is a successful agent task.

## 3. Reply format

1. **Verdict** in one line: `cost_per_success` (cost per session that got something done) and its `change_pct` vs the previous period. Say plainly whether value is improving or slipping.
2. **Cost per outcome**: a small table from `by_kind` (outcome, count, cost each, change).
3. **Best value model**: from `by_model`, compare `cost_per_session` with `cost_per_success`. If `best_value_model` differs from `cheapest_model`, make that the headline insight: the cheapest model isn't the best value when it fails more often.
4. **Nothing to show**: `nothing_to_show` spend and share; name the top of `biggest_no_result`. Note that research and Q&A sessions legitimately produce no commit.
5. **One or two actions**, each tied to a number: move routine work to the best-value model; run `sherlock` on the biggest no-result session; agree a price up front with `haggle` for tasks like the priciest results.

Keep it under about 20 lines.
