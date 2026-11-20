#!/usr/bin/env node
/**
 * tokenomics / crystalball: what will this cost? A financial planning tool for AI adoption: simulate
 * a team's monthly AI spend before rolling out an agentic workflow, across every model and provider.
 *
 *   crystalball.ts [--devs 10] [--tasks 20] [--input 50000] [--output 5000] [--cache 0.7] [--days 21]
 *       --devs      developers                       --tasks   AI tasks per developer per day
 *       --input     tokens the model reads per task  --output  tokens it writes per task
 *       --cache     share of input read from the prompt cache (0 = no caching; agents typically 0.6-0.9)
 *       --days      working days a month
 *   crystalball.ts --from-history [--history-days 30]
 *                   take tasks a day, tokens per task and cache share from your own ledger (bangforbuck),
 *                   then override any of them with the options above
 *   --mix "haiku=60,sonnet=35,opus=5"   a routed mix (as pennywise would route): its blended cost
 *   --growth 10 [--months 12]           adoption growing N% a month: month-by-month and the year's total
 *   --model sonnet                      the offering the growth plan and sensitivities use (default:
 *                                       the cheapest balanced one with a confirmed price)
 *   --tier fast|balanced|frontier       only offerings of that tier;  --provider anthropic|bedrock|...
 *   --json  --currency USD|EUR|GBP
 *
 * Prices: CostEngine (data/model-prices.json, data/providers.json, ~/.tokenomics/providers.json).
 * Copilot bills seats and premium requests rather than tokens, so it isn't priced here.
 */
import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import { CostEngine } from '../tokenomics/services/index.ts'
import { argValue, isMain, today, type Obj } from '../tokenomics/util.ts'
import { numArg, round2, useCurrency, write } from './common.ts'
import { existsSync } from 'node:fs'

type Offering = CostEngine.Offering

const round6 = (v: number) => Math.round(v * 1e6) / 1e6
/** 0.7, 70 or 70% -> 0.7 */
const share = (v: number) => Math.min(1, Math.max(0, v > 1 ? v / 100 : v))

/** Scenario numbers from the ledger: tasks per developer per working day, median tokens per task, cache share. */
export function fromHistory(dbPath: string, days = 30): Partial<CostEngine.Scenario> & { sessions: number } {
  if (!existsSync(dbPath)) return { sessions: 0 }
  const rows = withDb(dbPath, (db) => ledger.rows(db, ledger.shiftDay(today(), days - 1)), { readOnly: true }).filter((r) => r.turns > 0)
  if (!rows.length) return { sessions: 0 }
  const activeDays = new Set(rows.map((r) => r.day)).size || 1
  const devs = new Set(rows.map((r) => r.developer || 'me')).size || 1
  const read = (r: ledger.LedgerRow) => (r.usage ? r.usage.input + r.usage.cache_write + r.usage.cache_read : r.input_tokens)
  const cached = rows.reduce((a, r) => a + (r.usage?.cache_read ?? 0), 0)
  const total = rows.reduce((a, r) => a + read(r), 0)
  return {
    sessions: rows.length, developers: devs, tasksPerDay: Math.max(1, Math.round(rows.length / activeDays / devs * 10) / 10),
    inputPerTask: Math.round(ledger.median(rows.map(read))), outputPerTask: Math.round(ledger.median(rows.map((r) => r.output_tokens))),
    cacheHit: total && rows.some((r) => r.usage) ? Math.round(cached / total * 100) / 100 : undefined,
  }
}

/** "haiku=60,sonnet=35,opus=5" -> [[offering, share]] (shares normalised to 1). */
export function parseMix(spec: string, list: Offering[], providerName = 'anthropic'): [Offering, number][] {
  const parts = spec.split(',').map((p) => p.split('=').map((x) => x.trim())).filter(([k, v]) => k && Number(v) > 0)
  const out: [Offering, number][] = []
  for (const [k, v] of parts) {
    const key = k.toLowerCase()
    const o = list.find((x) => x.id.toLowerCase() === key) ??
      list.find((x) => x.provider === providerName && (x.model.includes(key) || x.id.includes(key))) ??
      list.find((x) => x.model.includes(key) || x.id.includes(key))
    if (o) out.push([o, Number(v)])
  }
  const sum = out.reduce((a, [, v]) => a + v, 0)
  return sum ? out.map(([o, v]) => [o, v / sum]) : []
}

export function simulate(args: string[], list: Offering[] = CostEngine.offerings(), dbPath = defaultDbPath()): Obj {
  let base: Partial<CostEngine.Scenario> = {}
  let history: Obj | null = null
  if (args.includes('--from-history')) {
    const h = fromHistory(dbPath, Math.max(1, numArg(args, '--history-days', 30)))
    history = h
    const { sessions: _s, ...rest } = h
    base = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
  }
  const has = (n: string) => argValue(args, n) !== null
  const s = CostEngine.scenario({
    ...base,
    ...(has('--devs') ? { developers: Math.max(0, numArg(args, '--devs', 1)) } : {}),
    ...(has('--tasks') ? { tasksPerDay: Math.max(0, numArg(args, '--tasks', 10)) } : {}),
    ...(has('--input') ? { inputPerTask: Math.max(0, numArg(args, '--input', 50_000)) } : {}),
    ...(has('--output') ? { outputPerTask: Math.max(0, numArg(args, '--output', 5_000)) } : {}),
    ...(has('--cache') ? { cacheHit: share(numArg(args, '--cache', 0.7)) } : {}),
    ...(has('--days') ? { workingDays: Math.max(1, numArg(args, '--days', 21)) } : {}),
  })
  const tier = argValue(args, '--tier')
  const prov = argValue(args, '--provider')
  const offs = list.filter((o) => (!tier || o.tier === tier) && (!prov || o.provider === prov))
  const rows = offs.map((o) => CostEngine.project(s, o)).sort((a, b) => a.monthlyUsd - b.monthlyUsd)
  const pick = argValue(args, '--model')
  const chosen = (pick && parseMix(`${pick}=1`, offs.length ? offs : list)[0]?.[0]) ||
    rows.find((r) => r.offering.tier === 'balanced' && !r.offering.indicative)?.offering ||
    rows.find((r) => r.offering.tier === 'balanced')?.offering || rows[0]?.offering || null
  const out: Obj = {
    scenario: s, tasks_per_month: CostEngine.tasksPerMonth(s), history,
    workload_per_task: CostEngine.taskWorkload(s),
    offerings: rows.map((r) => ({ id: r.offering.id, provider: r.offering.providerName, model: r.offering.model, tier: r.offering.tier,
      per_task_usd: round6(r.perTaskUsd), per_developer_month_usd: round2(r.perDeveloperUsd), month_usd: round2(r.monthlyUsd),
      year_usd: round2(r.yearlyUsd), indicative: r.offering.indicative, cached_prices: r.offering.cacheRead !== null })),
  }
  if (chosen) {
    const at = (over: Partial<CostEngine.Scenario>) => CostEngine.project({ ...s, ...over }, chosen).monthlyUsd
    const now = at({})
    out.reference = chosen.id
    out.sensitivity = {
      plus_10k_input_month_usd: round2(at({ inputPerTask: s.inputPerTask + 10_000 }) - now),
      plus_1k_output_month_usd: round2(at({ outputPerTask: s.outputPerTask + 1_000 }) - now),
      cache_plus_10pts_month_usd: round2(at({ cacheHit: Math.min(1, s.cacheHit + 0.1) }) - now),
      no_cache_month_usd: round2(at({ cacheHit: 0 }) - now),
      plus_one_developer_month_usd: round2(at({ developers: s.developers + 1 }) - now),
    }
    const growth = numArg(args, '--growth', 0)
    if (growth) {
      const months = Math.max(1, Math.min(60, Math.trunc(numArg(args, '--months', 12))))
      const plan = Array.from({ length: months }, (_, i) => round2(now * (1 + growth / 100) ** i))
      out.growth = { pct_per_month: growth, months: plan, total_usd: round2(plan.reduce((a, b) => a + b, 0)) }
    }
  }
  const mixSpec = argValue(args, '--mix')
  if (mixSpec) {
    const mix = parseMix(mixSpec, list)
    const month = mix.reduce((a, [o, w]) => a + CostEngine.project({ ...s, tasksPerDay: s.tasksPerDay * w }, o).monthlyUsd, 0)
    const ref = chosen ? CostEngine.project(s, chosen).monthlyUsd : null
    out.mix = { parts: mix.map(([o, w]) => ({ id: o.id, share: Math.round(w * 1000) / 1000 })), month_usd: round2(month),
      vs_reference_pct: ref ? Math.round((month - ref) / ref * 1000) / 10 : null }
  }
  return out
}

const n0 = (v: number) => Math.round(v).toLocaleString('en-US')

export function markdown(r: Obj): string {
  const { fmt, rate, symbol } = CostEngine.display()
  const unit = (usd: number) => (usd * rate < 0.1 ? `${symbol}${(usd * rate).toFixed(4)}` : fmt(usd))
  const delta = (usd: number) => (usd > 0 ? '+' : '') + fmt(usd, 100)
  const s = r.scenario as CostEngine.Scenario
  const L = ['# crystalball: what will it cost?', '',
    `**${n0(s.developers)} developers × ${s.tasksPerDay} tasks a day × ${s.workingDays} days = ${n0(r.tasks_per_month)} tasks a month**, ` +
    `each reading ${n0(s.inputPerTask)} tokens (${Math.round(s.cacheHit * 100)}% from the cache) and writing ${n0(s.outputPerTask)}.`, '']
  if (r.history) L.push(r.history.sessions ? `_From your last ${r.history.sessions} sessions, then your overrides._` : '_No history in the ledger yet: using the defaults._', '')
  if (!r.offerings.length) return [...L, 'No offerings match.'].join('\n')
  L.push('| Offering | Tier | Per task | Per developer / month | Team / month | Year |', '|---|---|---:|---:|---:|---:|')
  for (const o of r.offerings) {
    L.push(`| ${o.id}${o.indicative ? ' *' : ''} | ${o.tier} | ${unit(o.per_task_usd)} | ${fmt(o.per_developer_month_usd, 100)} | **${fmt(o.month_usd, 100)}** | ${fmt(o.year_usd, 100)} |`)
  }
  if (r.offerings.some((o: Obj) => o.indicative)) L.push('', '\\* indicative list price: check it against your provider and contract (`~/.tokenomics/providers.json`).')
  if (r.sensitivity) {
    const x = r.sensitivity
    L.push('', `## What moves the bill (${r.reference})`, '',
      `- +10k input tokens a task: ${delta(x.plus_10k_input_month_usd)} a month`,
      `- +1k output tokens a task: ${delta(x.plus_1k_output_month_usd)} a month`,
      `- 10 points more cache hits: ${delta(x.cache_plus_10pts_month_usd)} a month`,
      `- no prompt caching at all: ${delta(x.no_cache_month_usd)} a month`,
      `- one more developer: ${delta(x.plus_one_developer_month_usd)} a month`)
  }
  if (r.mix) {
    L.push('', `## Routed mix: ${r.mix.parts.map((p: Obj) => `${p.id} ${Math.round(p.share * 100)}%`).join(', ')}`, '',
      `**${fmt(r.mix.month_usd, 100)} a month**${r.mix.vs_reference_pct !== null ? ` (${r.mix.vs_reference_pct > 0 ? '+' : ''}${r.mix.vs_reference_pct}% vs all on ${r.reference})` : ''}.`)
  }
  if (r.growth) {
    L.push('', `## Adoption growing ${r.growth.pct_per_month}% a month (${r.reference})`, '',
      r.growth.months.map((v: number, i: number) => `M${i + 1} ${fmt(v, 100)}`).join(' · '), '', `**${r.growth.months.length}-month total: ${fmt(r.growth.total_usd, 100)}**`)
  }
  L.push('', '_A plan, not a quote: real tasks vary a lot in size. Re-run with `--from-history` once you have a few weeks of your own data._')
  return L.join('\n')
}

export function main(args: string[]): number {
  if (args.includes('-h') || args.includes('--help')) {
    write('Usage: crystalball.ts [--devs N] [--tasks N] [--input N] [--output N] [--cache 0.7] [--days 21] [--from-history]\n' +
      '                      [--mix "haiku=60,sonnet=40"] [--growth 10 --months 12] [--model X] [--tier T] [--json] [--currency C]')
    return 0
  }
  if (!useCurrency(args)) return 2
  const r = simulate(args)
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
