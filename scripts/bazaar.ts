#!/usr/bin/env node
/**
 * tokenomics / bazaar: find the cheapest equivalent capability across the whole AI provider market,
 * not just a cheaper model from one vendor.
 *
 * Takes the work you actually did (from the ledger: fresh input, cache writes, cache reads and output,
 * per model) and prices exactly that workload on every equivalent offering in the catalogue: the same
 * model on another cloud (Anthropic API, Amazon Bedrock, Google Vertex AI) and comparable models from
 * other providers. Cached-token prices are applied where an offering lists them; where it doesn't,
 * cache reads are charged as fresh input. Offerings are then filtered and ranked on value:
 *
 *   quality        a benchmark score you add to the catalogue, or the success rate your own sessions
 *                  measured on that model (OutcomeEngine: tests green, committed, accepted ...)
 *   latency        seconds to a reply: from the catalogue, or measured from your transcripts
 *   availability   1 - API errors per request, measured from your transcripts (or the catalogue)
 *   tier           only the same tier or stronger, unless --any-tier
 *
 * and the best value is the lowest cost per successful task, not the lowest price.
 *
 *   bazaar.ts [--days 30] [--min-quality 70] [--max-latency 20] [--min-availability 0.99] [--any-tier] [--json]
 *   bazaar.ts quote --input 50000 --output 5000 [--cache 0.7] [--model sonnet]    one task, across the market
 *   bazaar.ts list [--json]                                                       the catalogue, priced
 *
 * Catalogue: data/providers.json, plus your own rows / prices / benchmark scores in
 * ~/.tokenomics/providers.json. Copilot sessions report no tokens, so only Claude Code work is priced.
 */
import { existsSync } from 'node:fs'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import { CostEngine, InsightsEngine } from '../tokenomics/services/index.ts'
import { argValue, isMain, type Obj } from '../tokenomics/util.ts'
import { numArg, period, useCurrency, write } from './common.ts'

const JUDGED = new Set(['succeeded', 'failed', 'discarded', 'abandoned'])

export type ModelUse = { model: string, sessions: number, workload: CostEngine.Workload, spend_usd: number, observed: InsightsEngine.Observed }

/** Workload and measured behaviour per model, from ledger rows (sessions split by model where they mixed). */
export function usage(rows: ledger.LedgerRow[]): ModelUse[] {
  const by = new Map<string, ModelUse & { lat: number[], turns: number, errors: number, ok: number, judged: number }>()
  for (const r of rows) {
    const models: Obj = r.models && Object.keys(r.models).length ? r.models
      : { [r.model || 'unknown']: { turns: r.turns, cost_usd: r.cost_usd, input: 0, cache_write: 0, cache_read: r.input_tokens, output: r.output_tokens } }
    for (const [model, m] of Object.entries(models)) {
      if (model === 'unknown' || !(Number(m.turns) > 0)) continue
      const u = by.get(model) ?? { model, sessions: 0, workload: CostEngine.workload(), spend_usd: 0,
        observed: { sessions: 0, success_rate: null, latency_s: null, availability: null }, lat: [], turns: 0, errors: 0, ok: 0, judged: 0 }
      u.sessions++
      CostEngine.addWorkload(u.workload, { input: Number(m.input) || 0, cacheWrite: Number(m.cache_write) || 0,
        cacheRead: Number(m.cache_read) || 0, output: Number(m.output) || 0 })
      u.spend_usd += Number(m.cost_usd) || 0
      u.turns += Number(m.turns) || 0
      u.errors += Number(m.api_errors) || 0
      if (m.latency_s !== null && m.latency_s !== undefined) u.lat.push(Number(m.latency_s))
      if (r.status && JUDGED.has(r.status)) {
        u.judged++
        if (r.status === 'succeeded') u.ok++
      }
      by.set(model, u)
    }
  }
  return [...by.values()].map(({ lat, turns, errors, ok, judged, ...u }) => ({
    ...u, spend_usd: round6(u.spend_usd),
    observed: { sessions: judged, success_rate: judged >= 3 ? Math.round(ok / judged * 100) / 100 : null,
      latency_s: lat.length ? Math.round(ledger.median(lat) * 10) / 10 : null,
      availability: turns ? Math.round((1 - errors / (turns + errors)) * 1000) / 1000 : null },
  })).sort((a, b) => b.spend_usd - a.spend_usd)
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

function constraints(args: string[]): InsightsEngine.Constraints {
  const c: InsightsEngine.Constraints = { anyTier: args.includes('--any-tier') }
  if (argValue(args, '--min-quality') !== null) c.minQuality = numArg(args, '--min-quality', 0)
  if (argValue(args, '--max-latency') !== null) c.maxLatencyS = numArg(args, '--max-latency', 60)
  if (argValue(args, '--min-availability') !== null) {
    const a = numArg(args, '--min-availability', 0.99)
    c.minAvailability = a > 1 ? a / 100 : a
  }
  return c
}

export function build(args: string[], dbPath = defaultDbPath(), list = CostEngine.offerings()): Obj {
  const p = period(args, 30)
  const rows = existsSync(dbPath) ? withDb(dbPath, (db) => ledger.rows(db, p.since, p.until), { readOnly: true }) : []
  const uses = usage(rows)
  const observed = Object.fromEntries(uses.map((u) => [u.model, u.observed]))
  const c = constraints(args)
  const models = uses.map((u) => {
    const a = InsightsEngine.arbitrage(u.workload, u.model, list, observed, c)
    return { model: u.model, sessions: u.sessions, spend_usd: u.spend_usd, observed: u.observed, workload: u.workload,
      current: a.current, best: a.best, candidates: a.candidates }
  })
  const saving = models.reduce((a, m) => a + (m.best && m.current && m.best.id !== m.current.id ? Math.max(0, m.best.saving_usd) : 0), 0)
  const spend = uses.reduce((a, u) => a + u.spend_usd, 0)
  return { period: p.label, since: p.since, sessions: rows.length, spend_usd: round6(spend), constraints: c, models,
    potential_saving_usd: round6(saving), potential_saving_pct: spend ? Math.round(saving / spend * 1000) / 10 : 0 }
}

export function quote(args: string[], list = CostEngine.offerings()): Obj {
  const s = CostEngine.scenario({ developers: 1, tasksPerDay: 1, workingDays: 1, inputPerTask: numArg(args, '--input', 50_000),
    outputPerTask: numArg(args, '--output', 5_000), cacheHit: (() => { const v = numArg(args, '--cache', 0.7); return v > 1 ? v / 100 : v })() })
  const w = CostEngine.taskWorkload(s)
  const model = argValue(args, '--model') ?? 'claude-sonnet-5-5'
  const ref = list.find((o) => o.model.includes(model) || o.id.includes(model))?.model ?? model
  const a = InsightsEngine.arbitrage(w, ref, list, {}, constraints(args))
  return { task: { input: s.inputPerTask, output: s.outputPerTask, cache: s.cacheHit }, workload: w, reference: a.current?.id ?? null,
    best: a.best, candidates: a.candidates }
}

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const L = [`# bazaar: the best-value provider for your work, ${r.period}`, '']
  if (!r.models.length) {
    return [...L, 'No priced sessions in the ledger for this window. It fills in at the end of each Claude Code turn (bangforbuck), ' +
      'or backfill with `bangforbuck.ts ingest ~/.claude/projects`. For a single task, try `bazaar.ts quote --input 50000 --output 5000`.'].join('\n')
  }
  L.push(r.potential_saving_usd > 0
    ? `**About ${fmt(r.potential_saving_usd)} (${r.potential_saving_pct}%) of ${fmt(r.spend_usd)} could be saved** by running the same work where it is best value.`
    : `**You are already on the best-value offering** for ${fmt(r.spend_usd)} of work, within the constraints.`, '')
  for (const m of r.models) {
    const o = m.observed
    const facts = [o.success_rate !== null ? `${Math.round(o.success_rate * 100)}% success over ${o.sessions} judged sessions` : 'too few judged sessions for a success rate',
      o.latency_s !== null ? `${o.latency_s}s median reply` : null, o.availability !== null ? `${(o.availability * 100).toFixed(1)}% available` : null].filter(Boolean)
    L.push(`## ${m.model}: ${m.sessions} sessions, ${fmt(m.spend_usd)}`, '', `_Measured: ${facts.join(', ')}._`, '',
      '| Offering | Tier | Same work costs | Saving | Quality | Latency | Per success |', '|---|---|---:|---:|---:|---:|---:|')
    for (const c of m.candidates.filter((x: Obj) => x.eligible || x.id === m.current?.id).slice(0, 8)) {
      const tag = c.id === m.current?.id ? ' (you)' : c.id === m.best?.id ? ' ✅' : ''
      L.push(`| ${c.id}${tag}${c.indicative ? ' *' : ''} | ${c.tier} | ${fmt(c.cost_usd)} | ${!c.saving_pct ? '' : `${c.saving_pct > 0 ? '-' : '+'}${Math.abs(c.saving_pct)}%`} | ` +
        `${c.quality === null ? '?' : `${c.quality}${c.quality_source === 'your sessions' ? ' (yours)' : ''}`} | ${c.latency_s === null ? '?' : `${c.latency_s}s`} | ` +
        `${c.cost_per_success_usd === null ? '' : fmt(c.cost_per_success_usd)} |`)
    }
    const excluded = m.candidates.filter((x: Obj) => !x.eligible)
    if (excluded.length) L.push('', `_Left out: ${excluded.slice(0, 5).map((x: Obj) => `${x.id} (${x.why_not})`).join('; ')}${excluded.length > 5 ? ' ...' : ''}._`)
    if (m.best && m.current && m.best.id !== m.current.id && m.best.saving_usd > 0) {
      L.push('', `**Best value: ${m.best.id}**, ${fmt(m.best.saving_usd)} less for the same work` +
        `${m.best.provider !== m.current.provider ? ` (moving provider: check data residency, rate limits and your contract first)` : ''}.`)
    }
    L.push('')
  }
  L.push('\\* indicative list price. Rows without a cached-token price charge cache reads as fresh input. Add prices from your contract, ' +
    'benchmark scores (`quality`), `latency_s` and `availability` in `~/.tokenomics/providers.json`.')
  return L.join('\n')
}

function quoteMarkdown(r: Obj): string {
  const { fmt, rate, symbol } = CostEngine.display()
  const unit = (usd: number) => (usd * rate < 0.1 ? `${symbol}${(usd * rate).toFixed(4)}` : fmt(usd))
  const L = [`# bazaar: one task (${r.task.input.toLocaleString('en-US')} in, ${r.task.output.toLocaleString('en-US')} out, ${Math.round(r.task.cache * 100)}% cached)`, '',
    '| Offering | Provider | Tier | Cost | vs reference |', '|---|---|---|---:|---:|']
  for (const c of r.candidates) {
    L.push(`| ${c.id}${c.id === r.reference ? ' (reference)' : ''}${c.indicative ? ' *' : ''} | ${c.provider} | ${c.tier} | ${unit(c.cost_usd)} | ` +
      `${!c.saving_pct || c.id === r.reference ? '' : `${c.saving_pct > 0 ? '-' : '+'}${Math.abs(c.saving_pct)}%`} |`)
  }
  return L.join('\n')
}

export function main(argv: string[]): number {
  const [cmd = '', ...rest] = argv
  const args = ['quote', 'list'].includes(cmd) ? rest : argv
  if (!useCurrency(args)) return 2
  const json = args.includes('--json')
  if (cmd === 'list') {
    const list = CostEngine.offerings()
    if (json) write(JSON.stringify(list, null, 2))
    else {
      const { fmt } = CostEngine.display()
      write(['| Offering | Provider | Tier | Input | Cache write | Cache read | Output | Notes |', '|---|---|---|---:|---:|---:|---:|---|',
        ...list.map((o) => `| ${o.id} | ${o.providerName} | ${o.tier} | ${fmt(o.input)} | ${o.cacheWrite === null ? '—' : fmt(o.cacheWrite)} | ` +
          `${o.cacheRead === null ? '—' : fmt(o.cacheRead)} | ${fmt(o.output)} | ${o.indicative ? 'indicative' : ''} |`),
        '', '_Per million tokens._'].join('\n'))
    }
    return 0
  }
  if (cmd === 'quote') {
    const r = quote(args)
    write(json ? JSON.stringify(r, null, 2) : quoteMarkdown(r))
    return 0
  }
  const r = build(args)
  write(json ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
