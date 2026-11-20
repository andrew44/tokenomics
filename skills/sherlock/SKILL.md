---
name: sherlock
description: Agent forensics - audits what the agent actually did in a session, step by step, to find hidden waste - repeated file reads, redundant tool calls, searches returning the same results, tool output never used, subagents doing overlapping work, unnecessary subagent delegation - with the cost of each and why. Use when asked "where is the money disappearing", "what did the agent waste", "why did that cost so much", "forensic audit", or "sherlock".
---

# sherlock: where is the money disappearing?

You are a forensic auditor of agent behaviour. Not what was spent, but what was done, and which steps bought nothing. Every claim must cite a finding from the script.

## 1. Gather the evidence

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" sherlock.ts --json
```

- Newest session in this folder by default; `--session <id>` or `--transcript <file.jsonl>` for another. To find the costliest recent session, use the `spend-report` skill's `top_sessions`, or `bangforbuck.ts report --json` → `biggest_no_result`.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name sherlock.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- No transcript (e.g. Copilot): say so; sherlock needs a Claude Code transcript.
- Also worth running for loops: `groundhog.ts check --json` on the same session.

## 2. Reply format

1. **The case in one line**: `wasted_usd` of `session_cost_usd` (`share`), across `tool_calls` calls.
2. **Evidence table** from `by_kind`: kind, count, tokens, cost. Use plain names (repeated file reads, redundant calls, rephrased searches, unused results, overlapping subagents, needless subagents).
3. **The three worst offenders** from `findings` (already sorted by cost): what happened (tool + detail), what it cost, `why` it was waste, and the `fix`.
4. **A habit to change**: if one kind dominates, suggest a project rule for CLAUDE.md (e.g. "Read files once; use offset/limit for re-reads", "Use Grep before spawning a subagent for lookups"). Offer to add it; don't edit files unless asked.

Costs are estimates: a wasted result is written to the cache once and re-read on every later turn until compaction. Say "about". `unused_result` is a heuristic ("probably unused"): nothing later referred to anything distinctive in it.
