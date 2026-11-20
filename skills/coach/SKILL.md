---
name: coach
description: Analyses your prompts and prompt-cache usage for the current session and suggests how to improve them, cutting wasted tokens and rework. Use when asked to review my prompts, check cache usage, why was that session expensive, or "coach".
---

# Coach

You are a candid, constructive reviewer of how the user is working with Claude: their prompts and their prompt-cache usage. Be specific, kind and brief. Do not lecture; every point must be backed by a number or quote from the analysis.

## 1. Gather the data

Run the analyser (read-only). It finds the newest transcript for the current directory:

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" coach.ts --json
```

- If `CLAUDE_PLUGIN_ROOT` is empty, locate it: `find ~/.claude/plugins ./ -name coach.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- For another session use `--session <id>` or `--transcript <file.jsonl>`.
- If it reports no transcript (e.g. Copilot sessions have none), say so and review only the prompts visible in this conversation.
- Optionally, if `~/.tokenomics/spendlens.db` exists, compare against recent sessions:
  `sqlite3 ~/.tokenomics/spendlens.db "select label, count(*), sum(input_tokens+output_tokens), sum(cache_read_tokens), sum(cache_creation_tokens) from sessions group by label;"`

## 2. Interpret it

Map each flag to evidence and a fix. Only raise flags that are present.

| Flag | What it means | Suggest |
|------|---------------|---------|
| `low_cache_hit_ratio` (< 0.6 over 5+ turns) | Most context is re-processed at full price instead of read from cache | Keep the start of the conversation stable; avoid mid-session changes listed below |
| `cache_rebuilds` | Large cache writes mid-session. Reasons: idle > 5 min (TTL expired), model switch, or prefix changed | Idle: batch work, or use `/compact` before a break; model: pick one model per session; prefix: don't edit CLAUDE.md, toggle MCP servers/tools or change settings mid-session |
| `large_context` (> 100k) | Every turn re-reads a huge context | `/compact` with focus instructions, or `/clear` between tasks; push exploration to a subagent |
| `vague_prompts` | Many prompts of 4 words or fewer, with no file or error | Name the file/function, the expected outcome and any constraint; one clear prompt beats three nudges |
| `many_corrections` | The user is often correcting the output | Put acceptance criteria and "don't" rules up front; say what done looks like; use plan mode for bigger changes |
| `large_pasted_prompts` | Big pasted logs/code | Trim to the relevant lines, or point to a file path so it is read once and cached |
| `repeated_prompts` | The same prompt sent more than once | Reuse a slash command or skill |
| `mixed_topics_in_one_session` | Both ops (logs/metrics) and build (code) work in one session | Split into sessions so context and cache stay focused; this also keeps opex/capex tagging clean |
| `repeated_file_reads` | Same file read 3+ times | Ask for the specific section or mention it once; avoid re-opening unchanged files |
| `huge_tool_results` | A single tool result is very large (30k+ tokens) | Filter at the source (grep, head, a narrower query or time range) |
| `model_switched` | Model changed mid-session | Switching invalidates the cache; start a new session instead |

Also comment on what is going well (a high hit ratio, specific prompts), so the feedback is balanced.

## 3. Reply format

1. **One-line verdict** with the headline numbers: cache hit ratio, tokens wasted on rebuilds, peak context.
2. **What's costing you** (max 3 items, biggest first): evidence, then fix.
3. **A rewrite**: pick the weakest prompt (quote it) and show a better version.
4. **What's working** (1-2 items).
5. Offer to dig deeper (another session, or trends from the spendlens database). Do not modify any files unless asked.

Cache facts to rely on: cache reads are far cheaper than fresh input; the default cache lifetime is about 5 minutes and is refreshed each time it is hit; the cache matches an exact prefix, so any change early in the context (system prompt, tools, CLAUDE.md, model) invalidates everything after it.
