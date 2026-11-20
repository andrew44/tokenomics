#!/usr/bin/env node
/**
 * tokenomics / waistline: AI cost regression testing. Is the same kind of work getting more
 * expensive? Treat cost creep like a performance regression: catch it before it becomes normal.
 *
 * Compares two periods of the ledger (bangforbuck writes it), or the ledger against a saved
 * baseline, on equivalent work (sessions grouped by what they produced: feature, bug fix, ...):
 *
 *   cost per session and per result     median, per kind of task
 *   context consumption                 average context per request, peak context
 *   tool calls                          calls per session; new tools; tools whose output grew
 *   models                              a different model doing the work, and what it costs per turn
 *
 *   waistline.ts [--days 7] [--threshold 15] [--json] [--currency USD]
 *                                   last N days vs the N days before
 *   waistline.ts --save-baseline FILE [--days 30]
 *                                   write today's numbers as a baseline (commit it to your repo)
 *   waistline.ts --baseline FILE [--ci]
 *                                   compare against a baseline; --ci exits 1 on a regression and
 *                                   appends the report to $GITHUB_STEP_SUMMARY
 *   waistline.ts --transcripts DIR  measure transcripts in DIR instead of the ledger (for CI runs)
 *   waistline.ts nudge              hook (SessionStart): at most once a day, a one-line notice when
 *                                   last week cost noticeably more than the week before
 *
 * Env: TOKENOMICS_WAISTLINE=off turns the nudge off; TOKENOMICS_WAISTLINE_THRESHOLD (default 15, %).
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { defaultDbPath } from '../tokenomics/config.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import { LABELS, total } from '../tokenomics/engine/outcomes.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { argValue, errText, isMain, logErr, now, today, type Obj } from '../tokenomics/util.ts'

const MIN_SESSIONS = 3                  // fewer than this on either side: not enough to call a trend
const MATERIAL_TOKENS = 2_000           // tool output per session below this is noise
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d

export type Metrics = {
  sessions: number
  spend_usd: number
  median_cost_usd: number
  cost_per_result_usd: number | null
  avg_ctx: number
  peak_ctx: number
  turns_per_session: number
  tool_calls_per_session: number
  tools: Record<string, { calls_per_session: number, result_tokens_per_session: number }>
  models: Record<string, { sessions: number, cost_per_turn_usd: number, spend_usd: number }>
  tasks: Record<string, { sessions: number, median_cost_usd: number }>
}

export function metrics(rows: ledger.LedgerRow[]): Metrics {
  const n = rows.length || 1
  const productive = rows.filter((r) => total(r.outcomes))
  const results = productive.reduce((a, r) => a + total(r.outcomes), 0)
  const tools: Metrics['tools'] = {}
  for (const r of rows) {
    for (const [name, st] of Object.entries(r.tools)) {
      const t = tools[name] ??= { calls_per_session: 0, result_tokens_per_session: 0 }
      t.calls_per_session += st.calls / n
      t.result_tokens_per_session += st.result_tokens / n
    }
  }
  for (const t of Object.values(tools)) {
    t.calls_per_session = round(t.calls_per_session, 1)
    t.result_tokens_per_session = Math.round(t.result_tokens_per_session)
  }
  const models: Metrics['models'] = {}
  for (const r of rows) {
    const k = r.model || 'unknown'
    const m = models[k] ??= { sessions: 0, cost_per_turn_usd: 0, spend_usd: 0 }
    m.sessions += 1
    m.spend_usd += r.cost_usd
    m.cost_per_turn_usd += r.turns
  }
  for (const m of Object.values(models)) {
    m.cost_per_turn_usd = m.cost_per_turn_usd ? round(m.spend_usd / m.cost_per_turn_usd, 4) : 0
    m.spend_usd = round(m.spend_usd, 4)
  }
  const tasks: Metrics['tasks'] = {}
  for (const k of new Set(rows.map((r) => r.primary))) {
    const rs = rows.filter((r) => r.primary === k)
    tasks[k] = { sessions: rs.length, median_cost_usd: round(ledger.median(rs.map((r) => r.cost_usd)), 4) }
  }
  return {
    sessions: rows.length,
    spend_usd: round(rows.reduce((a, r) => a + r.cost_usd, 0), 4),
    median_cost_usd: round(ledger.median(rows.map((r) => r.cost_usd)), 4),
    cost_per_result_usd: results ? round(productive.reduce((a, r) => a + r.cost_usd, 0) / results, 4) : null,
    avg_ctx: Math.round(ledger.mean(rows.map((r) => r.avg_ctx))),
    peak_ctx: Math.round(ledger.mean(rows.map((r) => r.peak_ctx))),
    turns_per_session: round(ledger.mean(rows.map((r) => r.turns)), 1),
    tool_calls_per_session: round(ledger.mean(rows.map((r) => r.tool_calls)), 1),
    tools, models, tasks,
  }
}

export type Check = { name: string, before: number, after: number, change_pct: number, status: 'regression' | 'improved' | 'ok',
  unit: 'usd' | 'tokens' | 'count', note?: string }

export function compare(before: Metrics, after: Metrics, thresholdPct = 15): { checks: Check[], findings: string[], regressed: boolean,
  enough_data: boolean } {
  const enough = before.sessions >= MIN_SESSIONS && after.sessions >= MIN_SESSIONS
  const checks: Check[] = []
  const add = (name: string, b: number | null, a: number | null, unit: Check['unit'], note?: string) => {
    if (b === null || a === null || b <= 0) return
    const change = round((a - b) / b * 100, 1)
    const status = !enough ? 'ok' : change > thresholdPct ? 'regression' : change < -thresholdPct ? 'improved' : 'ok'
    checks.push({ name, before: b, after: a, change_pct: change, status, unit, ...(note ? { note } : {}) })
  }
  add('median cost per session', before.median_cost_usd, after.median_cost_usd, 'usd')
  add('cost per result', before.cost_per_result_usd, after.cost_per_result_usd, 'usd')
  add('context per request', before.avg_ctx, after.avg_ctx, 'tokens')
  add('peak context', before.peak_ctx, after.peak_ctx, 'tokens')
  add('tool calls per session', before.tool_calls_per_session, after.tool_calls_per_session, 'count')
  for (const [k, t] of Object.entries(after.tasks)) {
    const b = before.tasks[k]
    if (b && b.sessions >= 2 && t.sessions >= 2) add(`cost of a ${LABELS[k] ?? (k === 'none' ? 'session with no result' : k)}`, b.median_cost_usd, t.median_cost_usd, 'usd')
  }
  const findings: string[] = []
  if (!before.sessions || !after.sessions) return { checks, findings, regressed: false, enough_data: false }
  for (const [name, t] of Object.entries(after.tools)) {
    const b = before.tools[name]
    if (!b && t.result_tokens_per_session >= MATERIAL_TOKENS) {
      findings.push(`New tool **${name}**: ${t.calls_per_session} calls and ~${t.result_tokens_per_session.toLocaleString('en-US')} tokens of output per session.`)
    } else if (b && t.result_tokens_per_session >= MATERIAL_TOKENS &&
      t.result_tokens_per_session > b.result_tokens_per_session * (1 + thresholdPct / 100)) {
      add(`${name} output per session`, b.result_tokens_per_session, t.result_tokens_per_session, 'tokens')
    }
  }
  const top = (m: Metrics) => Object.entries(m.models).sort((a, b) => b[1].spend_usd - a[1].spend_usd)[0]
  const tb = top(before)
  const ta = top(after)
  if (tb && ta && tb[0] !== ta[0]) {
    const note = `main model changed ${tb[0]} -> ${ta[0]}`
    add('cost per turn (model change)', tb[1].cost_per_turn_usd, ta[1].cost_per_turn_usd, 'usd', note)
    findings.push(`Model change: most spend moved from **${tb[0]}** to **${ta[0]}**.`)
  }
  return { checks, findings, regressed: checks.some((c) => c.status === 'regression'), enough_data: enough }
}

// ---- inputs -------------------------------------------------------------------------------------

function fromTranscripts(dir: string): ledger.LedgerRow[] {
  const walk = (p: string): string[] => {
    try {
      return statSync(p).isFile() ? (p.endsWith('.jsonl') ? [p] : []) : readdirSync(p).flatMap((f) => walk(join(p, f)))
    } catch {
      return []
    }
  }
  return walk(dir).map((f) => {
    const t = trace.parse(f)
    return ledger.summarise(t, t.sessionId || basename(f, '.jsonl'))
  }).filter((r) => r.turns)
}

function ledgerRows(dbPath: string, since: string, until: string | null = null): ledger.LedgerRow[] {
  if (!existsSync(dbPath)) return []
  return withDb(dbPath, (db) => ledger.rows(db, since, until), { readOnly: true })
}

export function periods(dbPath: string, days: number): [ledger.LedgerRow[], ledger.LedgerRow[]] {
  const since = ledger.shiftDay(today(), days - 1)
  return [ledgerRows(dbPath, ledger.shiftDay(since, days), ledger.shiftDay(since, 1)), ledgerRows(dbPath, since)]
}

// ---- output -------------------------------------------------------------------------------------

export function markdown(r: Obj): string {
  const [, symbol, rate] = r.money
  const show = (c: Check, v: number) => (c.unit === 'usd' ? currency.formatMoney(v * rate, symbol, null)
    : Math.round(v).toLocaleString('en-US'))
  const icon = { regression: '🔺', improved: '✅', ok: '·' }
  const L = [`# waistline: ${r.title}`, '']
  if (!r.enough_data) L.push(`_Only ${r.before.sessions} vs ${r.after.sessions} sessions: too few (need ${MIN_SESSIONS} each side) to call a trend._`, '')
  L.push(r.regressed ? `**Cost regression:** ${r.checks.filter((c: Check) => c.status === 'regression').length} measure(s) up more than ${r.threshold}%.`
    : `**No cost regression** (threshold ${r.threshold}%).`, '')
  if (r.checks.length) L.push('| | Measure | Before | After | Change |', '|---|---|---:|---:|---:|')
  for (const c of r.checks as Check[]) {
    L.push(`| ${icon[c.status]} | ${c.name}${c.note ? ` (${c.note})` : ''} | ${show(c, c.before)} | ${show(c, c.after)} | ${c.change_pct > 0 ? '+' : ''}${c.change_pct}% |`)
  }
  if (r.findings.length) L.push('', ...r.findings.map((f: string) => `- ${f}`))
  L.push('', `Sessions: ${r.before.sessions} before, ${r.after.sessions} after.`, '')
  return L.join('\n')
}

function threshold(args: string[]): number {
  const v = Number(argValue(args, '--threshold') ?? process.env.TOKENOMICS_WAISTLINE_THRESHOLD ?? 15)
  return Number.isFinite(v) && v > 0 ? v : 15
}

function nudge(source: string): void {
  const mode = (process.env.TOKENOMICS_WAISTLINE ?? 'on').trim().toLowerCase()
  if (mode === 'off') return
  const dbPath = defaultDbPath()
  try {
    if (!existsSync(dbPath)) return
    const db = store.connect(dbPath)
    try {
      db.exec('CREATE TABLE IF NOT EXISTS waistline_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, day TEXT, action TEXT, detail TEXT)')
      if (db.get('SELECT 1 FROM waistline_events WHERE day=?', today())) return
      db.run('INSERT INTO waistline_events(ts,day,action,detail) VALUES(?,?,?,?)', now(), today(), 'checked', null)
    } finally {
      db.close()
    }
    const [before, after] = periods(dbPath, 7)
    const res = compare(metrics(before), metrics(after), threshold([]))
    const worst = res.checks.filter((c) => c.status === 'regression' && c.unit === 'usd').sort((a, b) => b.change_pct - a.change_pct)[0]
    if (!res.enough_data || !worst) return
    const [, symbol, rate] = currency.current()
    const msg = `tokenomics waistline: ${worst.name} is up ${worst.change_pct}% on the week before ` +
      `(${currency.formatMoney(worst.after * rate, symbol)} vs ${currency.formatMoney(worst.before * rate, symbol)}). ` +
      "Ask for a 'waistline report' to see why."
    const out = getAdapter(source).notify(msg)
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
    withDb(dbPath, (d) => d.run('INSERT INTO waistline_events(ts,day,action,detail) VALUES(?,?,?,?)', now(), today(), 'nudged', worst.name))
  } catch (e) {
    logErr(dbPath, `waistline\n${errText(e)}`)
  }
}

export function main(args: string[]): number {
  if (args[0] === 'nudge') {
    nudge(args[1] ?? 'claude-code')
    return 0
  }
  const cur = argValue(args, '--currency')
  if (cur) {
    const c = currency.currencyCode(cur)
    if (!c) {
      process.stderr.write(`unknown currency ${JSON.stringify(cur)}: use GBP, USD or EUR\n`)
      return 2
    }
    process.env.TOKENOMICS_CURRENCY = c
  }
  const dbPath = argValue(args, '--db') ?? defaultDbPath()
  const daysRaw = Number.parseInt(argValue(args, '--days') ?? '', 10)
  const th = threshold(args)
  const dir = argValue(args, '--transcripts')
  const save = argValue(args, '--save-baseline')
  const base = argValue(args, '--baseline')
  if (save) {
    const days = Number.isNaN(daysRaw) ? 30 : daysRaw
    const rows = dir ? fromTranscripts(dir) : ledgerRows(dbPath, ledger.shiftDay(today(), days - 1))
    writeFileSync(save, JSON.stringify({ created: now(), source: dir ? 'transcripts' : `ledger, last ${days} days`, metrics: metrics(rows) }, null, 2) + '\n')
    process.stdout.write(`Baseline written to ${save} (${rows.length} sessions).\n`)
    return 0
  }
  let before: Metrics
  let after: Metrics
  let title: string
  if (base) {
    let saved: Obj
    try {
      saved = JSON.parse(readFileSync(base, 'utf8'))
    } catch (e) {
      process.stderr.write(`Can't read baseline ${base}: ${errText(e).split('\n')[0]}\n`)
      return 2
    }
    before = saved.metrics
    const days = Number.isNaN(daysRaw) ? 7 : daysRaw
    after = metrics(dir ? fromTranscripts(dir) : ledgerRows(dbPath, ledger.shiftDay(today(), days - 1)))
    title = `${dir ? 'these transcripts' : `last ${days} days`} vs baseline (${String(saved.created ?? '').slice(0, 10)})`
  } else {
    const days = Number.isNaN(daysRaw) ? 7 : Math.max(1, daysRaw)
    const [b, a] = periods(dbPath, days)
    before = metrics(b)
    after = metrics(a)
    title = `last ${days} days vs the ${days} before`
  }
  const res = compare(before, after, th)
  const r = { title, threshold: th, money: currency.current(), before: { sessions: before.sessions }, after: { sessions: after.sessions }, ...res }
  const md = markdown(r)
  process.stdout.write((args.includes('--json') ? JSON.stringify({ ...r, before_metrics: before, after_metrics: after }, null, 2) : md) + '\n')
  if (args.includes('--ci')) {
    if (process.env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
      } catch {
        // the summary is a nicety
      }
    }
    return res.regressed ? 1 : 0
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
