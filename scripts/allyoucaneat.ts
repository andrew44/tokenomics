#!/usr/bin/env node
/**
 * tokenomics / allyoucaneat: are you on the right plan?
 *
 * The same Claude Code work can be paid for per token (an API key) or by subscription (Pro, Max).
 * spendlens prices every session at API rates whichever you use, so your ledger already holds the
 * pay-as-you-go price of your actual work. allyoucaneat sets that against each plan:
 *
 *   on pay-as-you-go   which subscriptions cost less than your typical month (candidates, since every
 *                      subscription has usage limits that reset every few hours and weekly)
 *   on a subscription  how many times over it paid for itself, or, if you used less than you pay for,
 *                      what pay-as-you-go or a lower plan would have cost
 *
 * with your heaviest 5-hour stretch and week, the shape that runs into usage limits.
 *
 *   allyoucaneat.ts [--plan api|pro|max5|max20] [--months 3] [--json] [--currency USD]
 *
 * Plans and prices: data/plans.json, overridden or added to by id in ~/.tokenomics/plans.json.
 * Your plan: --plan, or TOKENOMICS_PLAN. Claude Code only (Copilot bills premium requests). Read-only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { CostEngine } from '../tokenomics/services/index.ts'
import { argValue, isMain, isObj, parseTs, today, type Obj } from '../tokenomics/util.ts'
import { numArg, round2, useCurrency, write } from './common.ts'

export const PLANS_FILE = join(import.meta.dirname, '..', 'data', 'plans.json')
const userFile = () => join(process.env.TOKENOMICS_HOME || join(homedir(), '.tokenomics'), 'plans.json')
const MIN_DAYS_TO_PROJECT = 7

export type Plan = { id: string, name: string, kind: 'metered' | 'subscription', usd_per_month: number }

function readJson(p: string): Obj {
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'))
    return isObj(d) ? d : {}
  } catch {
    return {}
  }
}

/** Shipped plans, then ~/.tokenomics/plans.json (same id replaces, `"disabled": true` removes). */
export function plans(extra?: Obj): Plan[] {
  const rows = new Map<string, Obj>()
  for (const src of [readJson(PLANS_FILE), extra ?? readJson(userFile())]) {
    for (const r of Array.isArray(src.plans) ? src.plans : []) {
      if (isObj(r) && r.id) rows.set(String(r.id), { ...(rows.get(String(r.id)) ?? {}), ...r })
    }
  }
  return [...rows.values()].filter((r) => !r.disabled && Number.isFinite(Number(r.usd_per_month)))
    .map((r) => ({ id: String(r.id), name: String(r.name ?? r.id), kind: r.kind === 'metered' ? 'metered' as const : 'subscription' as const,
      usd_per_month: Number(r.usd_per_month) }))
    .sort((a, b) => a.usd_per_month - b.usd_per_month)
}

const monthOf = (day: string) => day.slice(0, 7)
const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}
function shiftMonth(month: string, k: number): string {
  const [y, m] = month.split('-').map(Number)
  const d = new Date(y, m - 1 + k, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** Largest spend inside any window of `seconds` (two pointers over time-ordered events). */
export function peakWindow(events: { t: number, usd: number }[], seconds: number): number {
  let best = 0
  let sum = 0
  let lo = 0
  for (let hi = 0; hi < events.length; hi++) {
    sum += events[hi].usd
    while (events[hi].t - events[lo].t >= seconds) sum -= events[lo++].usd
    best = Math.max(best, sum)
  }
  return best
}

export function build(args: string[], dbPath = defaultDbPath(), day = today()): Obj {
  const months = Math.max(1, Math.min(24, Math.trunc(numArg(args, '--months', 3))))
  const list = plans()
  const planArg = (argValue(args, '--plan') ?? process.env.TOKENOMICS_PLAN ?? '').trim().toLowerCase()
  const current = list.find((p) => p.id === planArg) ?? null
  const thisMonth = monthOf(day)
  const since = `${shiftMonth(thisMonth, -months)}-01`
  let rows: Obj[] = []
  if (existsSync(dbPath)) {
    rows = withDb(dbPath, (db) => (db.tables().has('cost_events')
      ? db.all('SELECT ts, day, usd FROM cost_events WHERE day >= ? AND day <= ? ORDER BY ts', since, day) : []), { readOnly: true })
  }
  const base = { months, plan: current?.id ?? null, plans: list, unknown_plan: planArg && !current ? planArg : null }
  if (!rows.length) return { ...base, empty: true }

  const first = String(rows[0].day)
  const byMonth = new Map<string, number>()
  for (const r of rows) byMonth.set(monthOf(String(r.day)), (byMonth.get(monthOf(String(r.day))) ?? 0) + Number(r.usd || 0))
  const table: { month: string, usd: number, complete: boolean, projected_usd: number | null }[] = []
  for (let m = shiftMonth(thisMonth, -months); m <= thisMonth; m = shiftMonth(m, 1)) {
    if (m < monthOf(first)) continue
    const usd = byMonth.get(m) ?? 0
    const complete = m < thisMonth && !(m === monthOf(first) && first.slice(8) !== '01')    // a month you started part-way is partial
    let projected: number | null = null
    if (m === thisMonth) {
      const elapsed = Number(day.slice(8)) - (m === monthOf(first) ? Number(first.slice(8)) - 1 : 0)
      if (elapsed >= MIN_DAYS_TO_PROJECT) projected = usd / elapsed * daysIn(m)
    }
    table.push({ month: m, usd: round2(usd), complete, projected_usd: projected === null ? null : round2(projected) })
  }
  const full = table.filter((t) => t.complete)
  const now = table.find((t) => t.month === thisMonth)
  let typical: number | null = null
  let basis = ''
  if (full.length) {
    typical = full.reduce((a, t) => a + t.usd, 0) / full.length
    basis = `average of ${full.length} full month${full.length === 1 ? '' : 's'}`
  } else if (now?.projected_usd != null) {
    typical = now.projected_usd
    basis = 'this month so far, projected to the month end'
  }
  const events = rows.map((r) => ({ t: parseTs(r.ts) ?? 0, usd: Number(r.usd || 0) })).filter((e) => e.t > 0)
  const peak5h = round2(peakWindow(events, 5 * 3600))
  const peakWeek = round2(peakWindow(events, 7 * 86400))

  const out: Obj = { ...base, typical_usd: typical === null ? null : round2(typical), basis, by_month: table,
    peak_5h_usd: peak5h, peak_week_usd: peakWeek }
  if (typical === null) return { ...out, too_early: true }

  const { fmt } = CostEngine.display()
  const subs = list.filter((p) => p.kind === 'subscription')
  out.options = list.map((p) => ({ id: p.id, name: p.name, kind: p.kind, monthly_usd: round2(p.kind === 'metered' ? typical! : p.usd_per_month),
    vs_payg_usd: round2((p.kind === 'metered' ? typical! : p.usd_per_month) - typical!),
    value_ratio: p.kind === 'subscription' && p.usd_per_month ? Math.round(typical! / p.usd_per_month * 10) / 10 : null }))
  const cheaper = subs.filter((p) => p.usd_per_month < typical!)
  const lines: string[] = []
  let verdict: string
  if (!current || current.kind === 'metered') {
    if (!cheaper.length) {
      verdict = 'stay'
      lines.push(`Your work costs about ${fmt(typical)} a month at API prices, less than any subscription${subs[0] ? ` (from ${fmt(subs[0].usd_per_month)})` : ''}: pay-as-you-go is the better deal.`)
    } else {
      verdict = 'consider_subscription'
      const best = cheaper[0]
      lines.push(`Your work costs about ${fmt(typical)} a month at API prices. ${cheaper.map((p) => `${p.name} (${fmt(p.usd_per_month)})`).join(', ')} ` +
        `cost${cheaper.length === 1 ? 's' : ''} less: up to ${fmt(typical - best.usd_per_month)} a month saved on ${best.name}, if its usage limits cover you.`)
      lines.push(`Limits bite on bursts: your heaviest 5 hours used ${fmt(peak5h)} of API-priced work and your heaviest week ${fmt(peakWeek)}. ` +
        'If a plan keeps stopping you mid-task, the next one up is still cheaper than pay-as-you-go while its price is below your monthly spend.')
    }
  } else {
    const ratio = current.usd_per_month ? typical / current.usd_per_month : 0
    if (ratio >= 1) {
      verdict = 'good_value'
      lines.push(`${current.name} costs ${fmt(current.usd_per_month)} and you used about ${fmt(typical)} of API-priced work a month: it paid for itself ${Math.round(ratio * 10) / 10}x over.`)
    } else {
      verdict = 'overpaying'
      const alt = [...subs.filter((p) => p.usd_per_month < current.usd_per_month && p.usd_per_month >= typical)]
      lines.push(`${current.name} costs ${fmt(current.usd_per_month)}, but your work came to about ${fmt(typical)} a month at API prices ` +
        `(${Math.round(ratio * 100)}% of the price).`)
      lines.push(alt.length
        ? `${alt[0].name} at ${fmt(alt[0].usd_per_month)} would still cost more than you use: about ${fmt(current.usd_per_month - alt[0].usd_per_month)} a month back.`
        : `Pay-as-you-go would have cost about ${fmt(typical)}: ${fmt(current.usd_per_month - typical)} a month back, if your heavy days fit.`)
    }
  }
  if (!current) lines.push('That assumes you pay per token. On a subscription? Say which (--plan pro, max5 or max20, or TOKENOMICS_PLAN) to see whether it pays for itself.')
  return { ...out, verdict, advice: lines }
}

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const L = ['# allyoucaneat: are you on the right plan?', '']
  if (r.unknown_plan) L.push(`_Unknown plan "${r.unknown_plan}": use one of ${r.plans.map((p: Plan) => p.id).join(', ')} (or add it to ~/.tokenomics/plans.json)._`, '')
  if (r.empty) {
    L.push('Nothing recorded yet. spendlens prices each Claude Code session as you work; come back after a week or two.')
    return L.join('\n')
  }
  L.push('| Month | Spend at API prices |', '|---|---:|')
  for (const m of r.by_month) L.push(`| ${m.month}${m.complete ? '' : ' (part)'} | ${fmt(m.usd)}${m.projected_usd != null ? ` (on course for ${fmt(m.projected_usd)})` : ''} |`)
  L.push('')
  if (r.too_early) {
    L.push(`Not enough history yet to call a typical month (${MIN_DAYS_TO_PROJECT}+ days needed).`)
    return L.join('\n')
  }
  L.push(`**A typical month: ${fmt(r.typical_usd)}** (${r.basis}). Heaviest 5 hours ${fmt(r.peak_5h_usd)}, heaviest week ${fmt(r.peak_week_usd)}.`, '')
  L.push('| Plan | A month costs | vs pay-as-you-go |', '|---|---:|---:|')
  for (const o of r.options) {
    const mark = o.id === r.plan ? ' (yours)' : ''
    L.push(`| ${o.name}${mark} | ${fmt(o.monthly_usd)} | ${o.kind === 'metered' ? '—' : `${o.vs_payg_usd > 0 ? '+' : ''}${fmt(o.vs_payg_usd)}`} |`)
  }
  L.push('')
  for (const a of r.advice) L.push(`- ${a}`)
  L.push('', '_Spend is priced at API rates whatever you pay with. Subscriptions have usage limits; check current prices and limits on claude.com/pricing, ' +
    'and set your plan with --plan or TOKENOMICS_PLAN._')
  return L.join('\n')
}

export function main(args: string[]): number {
  if (!useCurrency(args)) return 2
  const r = build(args)
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
