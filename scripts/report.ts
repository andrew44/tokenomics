#!/usr/bin/env node
/**
 * tokenomics / report: a spend report over the last N days from the spendlens database.
 *
 *   report.ts                 # last 7 days, Markdown
 *   report.ts --days 30       # any window (0 = all time)
 *   report.ts --json          # machine-readable (used by the spend-report skill)
 *   report.ts --currency USD  # GBP (default), USD or EUR; default from TOKENOMICS_CURRENCY / statusline.json
 *   report.ts --db PATH       # another database (default $TOKENOMICS_DB or ~/.tokenomics/spendlens.db)
 *
 * Covers: spend in your currency (GBP, USD or EUR; token-billed platforms only) and how it splits
 * OPEX / CAPEX, by project and by model; cache efficiency; the costliest sessions; and what the
 * other helpers did: pennywise routing and suggestions, doggybags packed, diet blocks, budget
 * pauses. Read-only (the database is opened read-only).
 */
import { existsSync, statSync } from 'node:fs'
import { basename } from 'node:path'

import { defaultDbPath } from '../tokenomics/config.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { argValue, fmt, isMain, today, type Obj } from '../tokenomics/util.ts'

const LABELS = ['opex', 'capex', 'mixed', 'unknown'] as const

const round2 = (v: number) => Math.round(v * 100) / 100
const project = (cwd: string | null) => basename((cwd || 'unknown').replace(/[/\\]+$/, '')) || cwd || 'unknown'

export function daysAgo(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - (days - 1))
  return today(d)
}

/** money = [code, symbol, units per USD]; default: the configured display currency. */
export function build(dbPath: string, days = 7, money?: [string, string, number]): Obj {
  const [code, symbol, rate] = money ?? currency.current()
  const out: Obj = { db_path: dbPath, days, currency: code, symbol, rate_per_usd: rate, empty: true }
  if (!(existsSync(dbPath) && statSync(dbPath).isFile())) {
    out.reason = 'no-database'
    return out
  }
  const since = days ? daysAgo(days) : '0000-00-00'
  out.since = days ? since : null
  const data = withDb(dbPath, (db) => {
    const tables = db.tables()
    if (!tables.has('sessions')) return null
    const cols = db.columns('sessions')
    const want = ['session_id', 'source', 'cwd', 'label', 'prompt_count', 'updated_at', 'input_tokens',
      'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'cost_usd', 'model']
    const sel = want.map((c) => (cols.has(c) ? c : `NULL AS ${c}`)).join(', ')
    const rows = db.all(`SELECT ${sel} FROM sessions WHERE substr(COALESCE(updated_at,''),1,10) >= ?`, since)
    // spend per session inside the window (cost_events are dated increments)
    const spend = new Map<string, number>()
    let daily: Obj[] = []
    if (tables.has('cost_events')) {
      for (const r of db.all('SELECT session_id, SUM(usd) AS usd FROM cost_events WHERE day >= ? GROUP BY session_id', since)) {
        spend.set(r.session_id, r.usd || 0)
      }
      daily = db.all('SELECT day, SUM(usd) AS usd FROM cost_events WHERE day >= ? GROUP BY day ORDER BY day', since)
        .map((r) => ({ day: r.day, spend: round2(r.usd * rate) }))
    }
    const ev = (table: string, sql: string): Obj[] => (tables.has(table) ? db.all(sql, since) : [])
    const pennywise = Object.fromEntries(ev('pennywise_events', 'SELECT action, COUNT(*) AS n FROM pennywise_events ' +
      'WHERE substr(ts,1,10) >= ? GROUP BY action').map((r) => [r.action, r.n]))
    const ho = ev('handoff_events', 'SELECT COUNT(*) AS n, COALESCE(SUM(context_tokens),0) AS ctx, ' +
      'COALESCE(SUM(handoff_tokens),0) AS bag FROM handoff_events WHERE substr(ts,1,10) >= ?')[0] ?? { n: 0, ctx: 0, bag: 0 }
    const diet = ev('diet_events', 'SELECT rule, COUNT(*) AS n, COALESCE(SUM(est_tokens),0) AS t FROM diet_events ' +
      "WHERE substr(ts,1,10) >= ? AND action='denied' GROUP BY rule ORDER BY 2 DESC")
    const budget = Object.fromEntries(ev('budget_events', 'SELECT action, COUNT(*) AS n FROM budget_events WHERE day >= ? ' +
      'GROUP BY action').map((r) => [r.action, r.n]))
    const groundhog = Object.fromEntries(ev('groundhog_events', 'SELECT action, COUNT(*) AS n FROM groundhog_events ' +
      'WHERE substr(ts,1,10) >= ? GROUP BY action').map((r) => [r.action, r.n]))
    const sherlock = ev('sherlock_events', 'SELECT COUNT(*) AS n, COALESCE(SUM(wasted_usd),0) AS w, COALESCE(SUM(session_usd),0) AS s ' +
      'FROM sherlock_events WHERE substr(ts,1,10) >= ?')[0] ?? { n: 0, w: 0, s: 0 }
    const haggle = ev('contracts', "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN spent_usd >= cap_usd THEN 1 ELSE 0 END),0) AS over, " +
      'COALESCE(SUM(est_mid),0) AS quoted, COALESCE(SUM(spent_usd),0) AS spent FROM contracts WHERE day >= ?')[0] ?? { n: 0, over: 0, quoted: 0, spent: 0 }
    const value = ev('ledger', "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN primary_outcome != 'none' THEN 1 ELSE 0 END),0) AS p, " +
      "COALESCE(SUM(cost_usd),0) AS c, COALESCE(SUM(CASE WHEN primary_outcome = 'none' THEN cost_usd ELSE 0 END),0) AS w FROM ledger WHERE day >= ?")[0] ??
      { n: 0, p: 0, c: 0, w: 0 }
    return { rows, spend, daily, pennywise, ho, diet, budget, groundhog, sherlock, haggle, value }
  }, { readOnly: true })
  if (data === null) {
    out.reason = 'no-table'
    return out
  }
  const { rows, spend, daily, pennywise, ho, diet, budget, groundhog, sherlock, haggle, value } = data
  if (!rows.length && !spend.size) {
    out.reason = 'no-rows'
    return out
  }
  out.empty = false
  const byLabel: Obj = Object.fromEntries(LABELS.map((k) => [k, { sessions: 0, spend: 0 }]))
  const byProject = new Map<string, Obj>()
  const byModel = new Map<string, number>()
  const bySource: Obj = {}
  const tok = { input: 0, output: 0, cache_write: 0, cache_read: 0 }
  for (const r of rows) {
    const lab = (LABELS as readonly string[]).includes(r.label) ? r.label : 'unknown'
    const cost = (spend.get(r.session_id) ?? 0) * rate
    byLabel[lab].sessions += 1
    byLabel[lab].spend += cost
    const proj = project(r.cwd)
    if (!byProject.has(proj)) byProject.set(proj, { sessions: 0, spend: 0, opex: 0, capex: 0 })
    const p = byProject.get(proj)!
    p.sessions += 1
    p.spend += cost
    if (lab === 'opex' || lab === 'capex') p[lab] += 1
    if (r.model) byModel.set(r.model, (byModel.get(r.model) ?? 0) + cost)
    const src = r.source || 'unknown'
    bySource[src] ??= { sessions: 0, prompts: 0 }
    bySource[src].sessions += 1
    bySource[src].prompts += r.prompt_count || 0
    tok.input += r.input_tokens || 0
    tok.output += r.output_tokens || 0
    tok.cache_write += r.cache_creation_tokens || 0
    tok.cache_read += r.cache_read_tokens || 0
  }
  const denom = tok.input + tok.cache_write + tok.cache_read
  const total = [...spend.values()].reduce((a, b) => a + b, 0) * rate
  const top = rows.filter((r) => spend.get(r.session_id)).sort((a, b) => spend.get(b.session_id)! - spend.get(a.session_id)!).slice(0, 5)
  const rnd = (d: Obj) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? round2(v) : v]))
  Object.assign(out, {
    spend: round2(total),
    daily,
    by_label: Object.fromEntries(Object.entries(byLabel).map(([k, v]) => [k, { ...v, spend: round2(v.spend) }])),
    by_project: [...byProject].map(([k, v]): Obj => ({ project: k, ...rnd(v), spend: round2(v.spend) }))
      .sort((a, b) => b.spend - a.spend || b.sessions - a.sessions).slice(0, 8),
    by_model: [...byModel].map(([k, v]) => ({ model: k, spend: round2(v) })).sort((a, b) => b.spend - a.spend),
    by_source: bySource,
    tokens: tok,
    cache_hit_ratio: denom ? Math.round(tok.cache_read / denom * 1000) / 1000 : null,
    top_sessions: top.map((r) => ({ session_id: r.session_id, project: basename(String(r.cwd || '').replace(/[/\\]+$/, '')),
      label: r.label, model: r.model, prompts: r.prompt_count || 0, spend: round2(spend.get(r.session_id)! * rate) })),
    helpers: {
      pennywise,
      doggybag: { written: ho.n, context_tokens: ho.ctx, handoff_tokens: ho.bag,
        tokens_avoided_if_used: Math.max(0, ho.ctx - ho.bag) },
      diet: diet.map((d) => ({ rule: d.rule, denied: d.n, est_tokens: d.t })),
      budget,
      groundhog,
      sherlock: { sessions: sherlock.n, wasted: round2(sherlock.w * rate), of_spend: round2(sherlock.s * rate) },
      haggle: { contracts: haggle.n, over_cap: haggle.over, quoted: round2(haggle.quoted * rate), spent: round2(haggle.spent * rate) },
      bangforbuck: { sessions: value.n, productive: value.p, cost_per_success: value.p ? round2(value.c * rate / value.p) : null,
        nothing_to_show: round2(value.w * rate) },
    },
  })
  return out
}

export function markdown(r: Obj): string {
  if (r.empty) {
    const why: Record<string, string> = {
      'no-database': `No database at ${r.db_path} yet: spendlens has not recorded a session.`,
      'no-table': 'The database has no sessions table yet.',
      'no-rows': 'No sessions in this window.',
    }
    return `# tokenomics report\n\n${why[r.reason] ?? 'No data.'}\n`
  }
  const window = r.days ? `last ${r.days} days (since ${r.since})` : 'all time'
  const L: string[] = [`# tokenomics report: ${window}`, '']
  const lab = r.by_label
  const spend: number = r.spend
  const m = (v: number) => `${r.symbol}${fmt(v, 2)}`
  const share = (k: string) => (spend ? `${(lab[k].spend / spend * 100).toFixed(0)}%` : 'n/a')
  L.push(`**Spend: ${m(spend)}** ${r.currency} (token-billed sessions; Copilot premium requests are not priced)`, '',
    '| Work type | Sessions | Spend | Share |', '|---|---:|---:|---:|')
  for (const k of LABELS) {
    L.push(`| ${k === 'opex' || k === 'capex' ? k.toUpperCase() : k} | ${lab[k].sessions} | ${m(lab[k].spend)} | ${share(k)} |`)
  }
  L.push('')
  if (r.cache_hit_ratio !== null) {
    const t = r.tokens
    L.push(`Cache hit ratio: **${(r.cache_hit_ratio * 100).toFixed(0)}%** of input read from cache ` +
      `(${fmt(t.cache_read)} of ${fmt(t.cache_read + t.input + t.cache_write)} tokens).`, '')
  }
  if (r.by_project.length) {
    L.push('## By project', '', '| Project | Sessions | OPEX | CAPEX | Spend |', '|---|---:|---:|---:|---:|')
    for (const p of r.by_project) L.push(`| ${p.project} | ${p.sessions} | ${p.opex} | ${p.capex} | ${m(p.spend)} |`)
    L.push('')
  }
  if (r.by_model.length) {
    L.push('## By model', '', ...r.by_model.map((x: Obj) => `- ${x.model}: ${m(x.spend)}`), '')
  }
  if (r.top_sessions.length) {
    L.push('## Costliest sessions', '', '| Session | Project | Type | Model | Prompts | Spend |', '|---|---|---|---|---:|---:|')
    for (const s of r.top_sessions) {
      L.push(`| \`${String(s.session_id).slice(0, 8)}\` | ${s.project} | ${s.label} | ${s.model || '?'} | ${s.prompts} | ${m(s.spend)} |`)
    }
    L.push('')
  }
  const h = r.helpers
  L.push('## What the helpers did', '')
  const pw = h.pennywise
  const n = (k: string) => pw[k] ?? 0
  const proxied = n('proxy-routed')
  L.push(`- pennywise: ${n('routed')} prompts routed to a cheaper model, ${n('routed-up')} routed up to a stronger one, ` +
    (proxied ? `${proxied} turns routed by the proxy (${n('proxy-fallback')} fallbacks), ` : '') +
    `${n('blocked') + n('warned')} cheaper-model suggestions, ${n('overridden')} overridden.`)
  const ho = h.doggybag
  L.push(`- doggybag: ${ho.written} doggybags packed; carrying on from them instead of the full context ` +
    `avoids up to ${fmt(ho.tokens_avoided_if_used)} tokens of cache writes.`)
  if (h.diet.length) {
    const known = h.diet.reduce((a: number, d: Obj) => a + d.est_tokens, 0)
    const rules = h.diet.map((d: Obj) => `${d.rule} x${d.denied}`).join(', ')
    L.push(`- diet: ${h.diet.reduce((a: number, d: Obj) => a + d.denied, 0)} oversized tool calls stopped (${rules})` +
      (known ? `; at least ${fmt(known)} tokens kept out of the context.` : '.'))
  } else {
    L.push('- diet: nothing blocked.')
  }
  const b = h.budget
  if (Object.keys(b).length) {
    L.push(`- budget: ${b.warned ?? 0} warnings, ${b.blocked ?? 0} pauses, ${(b.overridden ?? 0) + (b.bypassed ?? 0)} carried on over the limit.`)
  }
  if (h.bangforbuck?.sessions) {
    const v = h.bangforbuck
    L.push(`- bangforbuck: ${v.productive} of ${v.sessions} sessions produced a result` +
      (v.cost_per_success !== null ? `, ${m(v.cost_per_success)} per successful session` : '') +
      (v.nothing_to_show ? `; ${m(v.nothing_to_show)} went on sessions with nothing to show.` : '.'))
  }
  if (h.sherlock?.sessions && h.sherlock.wasted) {
    L.push(`- sherlock: about ${m(h.sherlock.wasted)} of hidden waste found in ${h.sherlock.sessions} sessions (repeated reads, redundant calls, unused results).`)
  }
  const gh = h.groundhog ?? {}
  if (Object.keys(gh).length) {
    L.push(`- groundhog: ${(gh.denied ?? 0) + (gh.interrupted ?? 0)} loops broken, ${gh.warned ?? 0} warnings.`)
  }
  if (h.haggle?.contracts) {
    L.push(`- haggle: ${h.haggle.contracts} tasks quoted at ${m(h.haggle.quoted)} in total; they cost ${m(h.haggle.spent)} ` +
      `(${h.haggle.over_cap} went over their cap).`)
  }
  const srcs = Object.entries(r.by_source).map(([k, v]: [string, any]) => `${k}: ${v.sessions} sessions / ${v.prompts} prompts`).join(', ')
  L.push('', `Platforms: ${srcs}.`, '')
  return L.join('\n')
}

function main(args: string[]): number {
  const cur = argValue(args, '--currency')
  if (cur) {
    const code = currency.currencyCode(cur)
    if (!code) {
      process.stderr.write(`report.ts: error: unknown currency ${JSON.stringify(cur)}: use GBP, USD or EUR\n`)
      return 2
    }
    process.env.TOKENOMICS_CURRENCY = code
  }
  const days = Number.parseInt(argValue(args, '--days') ?? '7', 10)
  const r = build(argValue(args, '--db') ?? defaultDbPath(), Math.max(0, Number.isNaN(days) ? 7 : days))
  process.stdout.write((args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r)) + '\n')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
