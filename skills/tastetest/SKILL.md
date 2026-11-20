---
name: tastetest
description: Proves whether a cost-saving change damaged quality - compares two runs of the same task (baseline vs optimised model, prompt, or trimmed instructions) on cost, tokens, tests, linting and type checks, and gives a quality-adjusted saving score and verdict (safe saving, cheaper but worse, false economy). Use when asked "did the cheaper model do as well", "prove the optimisation didn't hurt quality", "A/B two runs", "quality gate", or "tastetest".
---

# tastetest: can I prove the optimisation didn't damage quality?

A saving only counts if quality held. You compare two runs of the same task on evidence: cost from the transcripts, quality from the user's own checks.

## 1. Set up the comparison (if they haven't got two runs yet)

Explain the minimal A/B, then offer to do the git part:

```bash
git worktree add ../taste-a && git worktree add ../taste-b
```

Run the same prompt once in each (e.g. A on the usual model, B with the cheaper model / new CLAUDE.md / new prompt), and note each session id (`/status`, or the newest transcript in each folder).

## 2. Run the taste test

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" tastetest.ts --a <session-or-transcript> --b <session-or-transcript> \
  --a-dir ../taste-a --b-dir ../taste-b --json --save "<short label>"
```

- Checks are auto-detected (npm test/lint/typecheck, pytest, cargo test, go test/vet). Add or override with `--check "make verify"` (repeatable). Checks run the project's own commands in each folder: confirm with the user before running them if the commands are not obvious.
- No working copies? Leave out `--a-dir/--b-dir`: quality then comes from each transcript (did the last test run pass, how many tool calls failed). Say that this is weaker evidence.
- Known costs from elsewhere: `--a-cost 1.20 --b-cost 0.40` (in the display currency).
- Earlier results: `tastetest.ts history`.

## 3. Reply format

1. **Verdict** (`summary`), then the score: raw saving %, quality change (points), **quality-adjusted saving %** = 1 − (cost_B/quality_B) / (cost_A/quality_A).
2. **Side-by-side**: cost, tokens, turns, each check's pass/fail counts, quality.
3. **Recommendation**:
   - `safe-saving` → adopt B; suggest making it the default (e.g. pennywise tiers, model setting).
   - `cheaper-but-worse` → say exactly what got worse and let the user decide.
   - `false-economy` → keep A; name the broken checks.
   - `better-for-more`, `no-saving`, `worse` → state the trade-off plainly.

One run each is anecdote: suggest repeating on two or three tasks before changing defaults.
