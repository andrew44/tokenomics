---
name: bazaar
description: Provider arbitrage - prices the work actually done (input, output and cached tokens, per model) on every equivalent offering across providers (Anthropic API, Amazon Bedrock, Google Vertex AI and other vendors), filters by quality, latency and availability measured from your own sessions, and recommends the best-value provider by cost per successful task. Use when asked "which provider is cheapest", "should we use Bedrock / Vertex", "compare providers", "cheapest equivalent model", "provider arbitrage", or "bazaar".
---

# bazaar: the cheapest equivalent capability, across the whole market

You compare providers on value, not list price. Every number comes from the script; never quote a price from memory.

## 1. Gather the data

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" bazaar.ts --json --days 30
```

- Constraints when the user states them: `--min-quality 70` (0-100), `--max-latency 20` (seconds), `--min-availability 0.99`, `--any-tier` (allow a weaker tier).
- A task that hasn't happened yet: `bazaar.ts quote --input 50000 --output 5000 --cache 0.7 --model opus --json`.
- The catalogue and its prices: `bazaar.ts list`.
- If `CLAUDE_PLUGIN_ROOT` is empty: `find ~/.claude/plugins ./ -name bazaar.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- No sessions: suggest `quote`, or backfilling the ledger with `bangforbuck.ts ingest ~/.claude/projects` (ask first).

## 2. Reply format

1. **Verdict**: `potential_saving_usd` and `potential_saving_pct` of `spend_usd`, or that they're already on the best value.
2. **Per model** (from `models`): what was measured (`observed`: success rate, median latency, availability), then the `best` offering with its saving, and one or two alternatives. Mark `indicative` prices as indicative.
3. **Caveats that matter**: an offering with `quality_source` null has no quality evidence; `cached_prices` false means cache reads were charged as fresh input; moving provider means checking data residency, rate limits and contract terms.
4. **Next step**: if the catalogue lacks their negotiated prices or a benchmark score they trust, offer to add rows to `~/.tokenomics/providers.json` (format: see `data/providers.json`). Don't edit it unless asked.

The best value is the lowest cost per successful task, not the lowest price: say so when the cheapest offering isn't the recommendation.
