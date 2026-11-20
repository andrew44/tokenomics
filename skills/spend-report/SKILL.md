---
name: spend-report
description: Reports where AI coding spend went over a period (default the last 7 days) - money spent in the user's currency, the OPEX/CAPEX split, projects, models, the costliest sessions and what the tokenomics helpers saved - with three concrete ways to spend less. Use when asked for a spend report, weekly AI cost summary, "where did my tokens go this week", budget status, or to compare OPEX and CAPEX spend.
---

# Spend report

You turn the tokenomics database into a short, decision-ready report. Every number you state must come from the report output. Never estimate or invent figures.

## 1. Gather the data

```bash
sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" report.ts --json --days 7
```

- If the user asks for a currency ("in dollars", "in euros"), add `--currency USD` or `--currency EUR`. Otherwise use the configured one.
- Use the period the user asked for: `--days 30` for a month, `--days 1` for today, `--days 0` for all time.
- If `CLAUDE_PLUGIN_ROOT` is empty, locate the script: `find ~/.claude/plugins ./ -name report.ts -path "*tokenomics*" 2>/dev/null | head -1`.
- If `empty` is true, explain the `reason` plainly (for `no-database`: spendlens is installed with the plugin and starts recording from the next session) and stop.
- For budget questions also run `sh "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" budget.ts status`.

## 2. Reply format

1. **Headline**: total `spend` for the period in the report's currency (show amounts with its `symbol`, e.g. £, $ or €), and the OPEX vs CAPEX share of it (from `by_label`).
2. **Where it went**: a small table of the top projects (`by_project`) and one line on models (`by_model`).
3. **Costliest sessions**: the top 3 from `top_sessions` with project, work type and spend.
4. **What the helpers did** (`helpers`): pennywise routing, suggestions and overrides, doggybags packed and tokens they can avoid, diet blocks, budget pauses, groundhog loops broken, haggle quotes vs actual, sherlock's estimated hidden waste, and bangforbuck's cost per successful session and spend with nothing to show. Leave out any helper with nothing to report.
5. **Three ways to spend less**, each tied to a number above. Pick from:
   - Spend concentrated on the most expensive model with many short sessions: use a cheaper model for routine work (pennywise does this per prompt).
   - `cache_hit_ratio` under 0.6: keep sessions on one task, avoid idle gaps over 5 minutes, don't switch models mid-session.
   - Large `doggybag.tokens_avoided_if_used`: after a break, `/clear` (the doggybag loads itself) instead of carrying on in the cold session or `--resume`.
   - Many diet blocks of one rule: that habit (e.g. dumping logs) is costly; suggest a project instruction in CLAUDE.md.
   - OPEX share high: observability questions are often cheaper with a dedicated, narrow skill or a smaller model.
   - One session dominating spend: suggest `coach` on that session id for a detailed review, and `sherlock` for the wasted steps.
   - Large `bangforbuck.nothing_to_show`: suggest the `bangforbuck` skill to see which models and sessions deliver results.
   - Large `sherlock.wasted`: suggest a CLAUDE.md rule for the habit sherlock finds most (e.g. read each file once).

Copilot sessions are counted (sessions and prompts) but not priced: Copilot bills premium requests, which tokenomics cannot see. Say so if Copilot appears in `by_source`.

Keep it under about 25 lines. Offer the dashboard (`/tokenomics:dashboard`) for charts.
