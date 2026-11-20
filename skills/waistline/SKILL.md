---
name: waistline
description: AI cost regression testing - checks whether the same kind of work is getting more expensive over time (cost per session and per result, context consumption, tool calls, new expensive tools, model changes), compares against a saved baseline, and sets up a CI check that fails on cost creep. Use when asked "am I getting worse value than last month", "has my AI spend crept up", "cost regression", "why is it more expensive now", or to add a cost check to CI.
---

# waistline: is the same work getting more expensive?

Treat AI cost like a performance regression. You compare like with like and point at the cause. Every number comes from the script.

## 1. Compare two periods

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" waistline.ts --json --days 30
```

- "Than last month" → `--days 30` (last 30 days vs the 30 before). "This week" → `--days 7` (default).
- `--threshold 10` makes it stricter (default 15%). Currency on request: `--currency USD`.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name waistline.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- If `enough_data` is false, say there are too few sessions on one side to call a trend, show the numbers anyway, and suggest backfilling with `bangforbuck.ts ingest ~/.claude/projects`.

## 2. Reply format

1. **Verdict**: regression or not, and the biggest money change (`checks` with `unit: "usd"`).
2. **Why**: read the other checks and `findings` as causes, biggest first:
   - `context per request` / `peak context` up → longer sessions or bigger instruction files: suggest `/compact`, `/clear` between tasks, and a `springclean` audit.
   - `tool calls per session` up, or a tool's output up → the agent is doing more to get the same result: suggest `sherlock` on a recent session.
   - **New tool** findings → a new MCP server or tool whose output is large.
   - **Model change** → more work on a pricier model; check with `bangforbuck` whether results per £ improved too.
3. **Fix**: one or two concrete actions tied to the cause.

## 3. CI (when asked)

Save a baseline from the ledger or from transcripts produced in CI, commit it, then compare on every run:

```bash
node scripts/waistline.ts --save-baseline .tokenomics-baseline.json --days 30          # once, locally
node scripts/waistline.ts --baseline .tokenomics-baseline.json --transcripts ./transcripts --ci
```

`--ci` exits 1 on a regression and writes the report to the GitHub job summary (`$GITHUB_STEP_SUMMARY`). Offer to add the step to their workflow; don't edit CI files unless asked.
