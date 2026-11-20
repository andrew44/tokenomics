#!/usr/bin/env node
/**
 * tokenomics / bangforbuck: what useful work costs. Stop measuring tokens saved; measure the cost
 * of getting a result. The cheapest model isn't the best value if it needs three goes.
 *
 * Every turn end (Claude Code: Stop hook) it reads the session's transcript and writes one ledger
 * row: cost, tokens, tool calls, and the outcomes the agent actually achieved: completed features,
 * bugs fixed, passing test suites, commits, pull requests, successful subagent tasks (see
 * tokenomics/engine/outcomes.ts). Only numbers and tool names are stored, never prompts or code.
 *
 *   bangforbuck.ts record [source]          hook: update this session's ledger row (stdin: hook JSON)
 *   bangforbuck.ts report [--days 30]       cost per outcome, per model, vs the previous period
 *                  [--json] [--currency USD]
 *   bangforbuck.ts session [--session ID | --transcript FILE] [--json]
 *                                           what one session cost and what it produced
 *   bangforbuck.ts mark <kind> [note] [--session ID]
 *                                           record an outcome by hand (kind: feature, bug_fix, ...)
 *   bangforbuck.ts ingest <file-or-dir>...  backfill the ledger from old transcripts
 *
 * Env: TOKENOMICS_BANGFORBUCK=off turns the hook off. The hook always exits 0 and prints nothing.
 */
import { basename, join } from 'node:path'
import { existsSync, readdirSync, statSync } from 'node:fs'

import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import { withDb, type Db } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import { KINDS, LABELS, total } from '../tokenomics/engine/outcomes.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { argValue, errText, first, isMain, logErr, readPayload, today, type Obj } from '../tokenomics/util.ts'

const round2 = (v: number) => Math.round(v * 100) / 100
const pct = (a: number, b: number) => (b ? Math.round((a - b) / b * 1000) / 10 : null)

function label(db: Db, sid: string): string | null {
  if (!db.tables().has('sessions')) return null
  return db.get('SELECT label FROM sessions WHERE session_id=?', sid)?.label ?? null
}

/** Parse one transcript and write its ledger row. */
export function recordTranscript(dbPath: string, path: string, sessionId?: string | null): ledger.LedgerRow {
  const t = trace.parse(path)
  const sid = sessionId || t.sessionId || basename(path, '.jsonl')
  const db = store.connect(dbPath)
  try {
    const row = ledger.summarise(t, sid, label(db, sid))
    ledger.record(db, row)
    return row
  } finally {
    db.close()
  }
}

function hook(source: string): void {
  if ((process.env.TOKENOMICS_BANGFORBUCK ?? '').trim().toLowerCase() === 'off') return
  try {
    if (source === 'copilot') return                       // no transcript and no prices: nothing to measure
    const payload = readPayload()
    const path = first(payload, ['transcript_path', 'transcriptPath'])
    if (!path) return
    recordTranscript(defaultDbPath(), String(path), first(payload, ['session_id', 'sessionId']))
  } catch (e) {
    logErr(defaultDbPath(), `bangforbuck\n${errText(e)}`)
  }
}

type Money = [string, string, number]

function stats(rows: ledger.LedgerRow[], rate: number): Obj {
  const spend = rows.reduce((a, r) => a + r.cost_usd, 0) * rate
  const productive = rows.filter((r) => total(r.outcomes) > 0)
  const kinds = [...new Set([...KINDS, ...rows.flatMap((r) => Object.keys(r.outcomes))])]
  const byKind = kinds.map((k) => {
    const with_ = rows.filter((r) => (r.outcomes[k] ?? 0) > 0)
    const count = with_.reduce((a, r) => a + (r.outcomes[k] ?? 0), 0)
    const s = with_.reduce((a, r) => a + r.cost_usd, 0) * rate
    return { kind: k, label: LABELS[k] ?? k.replaceAll('_', ' '), count, sessions: with_.length, spend: round2(s),
      cost_each: count ? round2(s / count) : null }
  }).filter((k) => k.count)
  const models = new Map<string, ledger.LedgerRow[]>()
  for (const r of rows) models.set(r.model || 'unknown', [...(models.get(r.model || 'unknown') ?? []), r])
  const byModel = [...models].map(([model, rs]) => {
    const s = rs.reduce((a, r) => a + r.cost_usd, 0) * rate
    const ok = rs.filter((r) => total(r.outcomes) > 0).length
    return { model, sessions: rs.length, productive: ok, success_rate: rs.length ? round2(ok / rs.length) : 0,
      spend: round2(s), cost_per_session: round2(s / rs.length), cost_per_success: ok ? round2(s / ok) : null }
  }).sort((a, b) => b.spend - a.spend)
  const unproductive = rows.filter((r) => !total(r.outcomes))
  const waste = unproductive.reduce((a, r) => a + r.cost_usd, 0) * rate
  return {
    sessions: rows.length, productive: productive.length, spend: round2(spend),
    cost_per_success: productive.length ? round2(spend / productive.length) : null,
    outcomes: rows.reduce((a, r) => a + total(r.outcomes), 0),
    by_kind: byKind, by_model: byModel,
    nothing_to_show: { sessions: unproductive.length, spend: round2(waste), share: spend ? round2(waste / spend) : 0 },
  }
}

export function build(dbPath: string, days = 30, money?: Money): Obj {
  const [code, symbol, rate] = money ?? currency.current()
  const end = today()
  const since = days ? ledger.shiftDay(end, days - 1) : '0000-00-00'
  const prevSince = days ? ledger.shiftDay(since, days) : null
  const prevUntil = days ? ledger.shiftDay(since, 1) : null
  if (!existsSync(dbPath)) return { days, since: days ? since : null, currency: code, symbol, empty: true }
  const [cur, prev] = withDb(dbPath, (db) => [ledger.rows(db, since), prevSince ? ledger.rows(db, prevSince, prevUntil) : []],
    { readOnly: true })
  const out: Obj = { days, since: days ? since : null, currency: code, symbol, empty: !cur.length }
  if (!cur.length) return out
  const now_ = stats(cur, rate)
  const before = prev.length ? stats(prev, rate) : null
  const best = now_.by_model.filter((m: Obj) => m.productive >= 2 && m.cost_per_success !== null)
    .sort((a: Obj, b: Obj) => a.cost_per_success - b.cost_per_success)[0] ?? null
  const cheapest = [...now_.by_model].filter((m: Obj) => m.sessions >= 2).sort((a: Obj, b: Obj) => a.cost_per_session - b.cost_per_session)[0] ?? null
  Object.assign(out, now_, {
    previous: before && { sessions: before.sessions, spend: before.spend, cost_per_success: before.cost_per_success,
      by_kind: Object.fromEntries(before.by_kind.map((k: Obj) => [k.kind, k.cost_each])) },
    change_pct: before && {
      cost_per_success: pct(now_.cost_per_success ?? 0, before.cost_per_success ?? 0),
      ...Object.fromEntries(now_.by_kind.map((k: Obj) => [k.kind, pct(k.cost_each ?? 0, before.by_kind.find((b: Obj) => b.kind === k.kind)?.cost_each ?? 0)])),
    },
    best_value_model: best?.model ?? null,
    cheapest_model: cheapest?.model ?? null,
    priciest_results: cur.filter((r) => total(r.outcomes)).map((r) => ({ session_id: r.session_id, project: basename(r.cwd || ''),
      outcome: r.primary, spend: round2(r.cost_usd * rate), per_outcome: round2(r.cost_usd * rate / total(r.outcomes)) }))
      .sort((a, b) => b.per_outcome - a.per_outcome).slice(0, 3),
    biggest_no_result: cur.filter((r) => !total(r.outcomes)).sort((a, b) => b.cost_usd - a.cost_usd).slice(0, 3)
      .map((r) => ({ session_id: r.session_id, project: basename(r.cwd || ''), spend: round2(r.cost_usd * rate), turns: r.turns })),
  })
  return out
}

export function markdown(r: Obj): string {
  if (r.empty) return '# bangforbuck\n\nNo sessions in the ledger for this window yet. It fills in at the end of each turn ' +
    '(or backfill with `bangforbuck.ts ingest ~/.claude/projects`).\n'
  const m = (v: number | null) => (v === null ? 'n/a' : currency.formatMoney(v, r.symbol))
  const ch = (v: number | null | undefined) => (v === null || v === undefined ? '' : ` (${v > 0 ? '+' : ''}${v}% vs before)`)
  const L = [`# bangforbuck: value for money, ${r.days ? `last ${r.days} days` : 'all time'}`, '',
    `**${m(r.cost_per_success)} per session that got something done**${ch(r.change_pct?.cost_per_success)}. ` +
    `${r.productive} of ${r.sessions} sessions produced a result; spend ${m(r.spend)}.`, '']
  if (r.by_kind.length) {
    L.push('| Outcome | Count | Cost each | Change |', '|---|---:|---:|---:|')
    for (const k of r.by_kind) {
      const c = r.change_pct?.[k.kind]
      L.push(`| ${k.label} | ${k.count} | ${m(k.cost_each)} | ${c === null || c === undefined ? '' : `${c > 0 ? '+' : ''}${c}%`} |`)
    }
    L.push('')
  }
  if (r.by_model.length) {
    L.push('## By model: the cost of a successful result', '', '| Model | Sessions | Success rate | Per session | Per success |',
      '|---|---:|---:|---:|---:|')
    for (const x of r.by_model) {
      L.push(`| ${x.model} | ${x.sessions} | ${Math.round(x.success_rate * 100)}% | ${m(x.cost_per_session)} | ${m(x.cost_per_success)} |`)
    }
    if (r.best_value_model && r.cheapest_model && r.best_value_model !== r.cheapest_model) {
      L.push('', `Cheapest per session is ${r.cheapest_model}, but best value per result is **${r.best_value_model}**.`)
    }
    L.push('')
  }
  const n = r.nothing_to_show
  if (n.sessions) L.push(`**Nothing to show:** ${n.sessions} sessions, ${m(n.spend)} (${Math.round(n.share * 100)}% of spend) ` +
    'ended with no test pass, commit, PR or finished task. Some are research or questions; the rest is the leak.', '')
  return L.join('\n')
}

function sessionReport(args: string[]): number {
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  const t = trace.parse(p)
  const row = ledger.summarise(t, t.sessionId || basename(p, '.jsonl'))
  const [code, symbol, rate] = currency.current()
  const n = total(row.outcomes)
  const out = { session_id: row.session_id, currency: code, spend: round2(row.cost_usd * rate), turns: row.turns,
    tool_calls: row.tool_calls, outcomes: row.outcomes, per_outcome: n ? round2(row.cost_usd * rate / n) : null }
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return 0
  }
  const list = Object.entries(row.outcomes).map(([k, v]) => `${v} ${LABELS[k] ?? k}`).join(', ') || 'nothing yet'
  process.stdout.write(`Session ${row.session_id.slice(0, 8)}: ${currency.formatMoney(out.spend, symbol)} over ${row.turns} turns.\n` +
    `Produced: ${list}.\n` + (n ? `That is ${currency.formatMoney(out.per_outcome!, symbol)} per outcome.\n` : ''))
  return 0
}

function walk(p: string): string[] {
  try {
    if (statSync(p).isFile()) return p.endsWith('.jsonl') ? [p] : []
    return readdirSync(p).flatMap((f) => walk(join(p, f)))
  } catch {
    return []
  }
}

function money(args: string[]): boolean {
  const cur = argValue(args, '--currency')
  if (!cur) return true
  const c = currency.currencyCode(cur)
  if (!c) {
    process.stderr.write(`unknown currency ${JSON.stringify(cur)}: use GBP, USD or EUR\n`)
    return false
  }
  process.env.TOKENOMICS_CURRENCY = c
  return true
}

export function main(argv: string[]): number {
  const [cmd = 'report', ...args] = argv
  if (cmd === 'record') {
    hook(args[0] ?? 'claude-code')
    return 0
  }
  if (cmd === 'session') return sessionReport(args)
  if (cmd === 'mark') {
    const kind = (args[0] ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
    if (!kind || kind.startsWith('--')) {
      process.stderr.write(`Usage: bangforbuck.ts mark <kind> [note] [--session ID]   kinds: ${KINDS.join(', ')} (or your own)\n`)
      return 2
    }
    let sid = argValue(args, '--session')
    if (!sid) {
      const p = findTranscript({})
      sid = p ? basename(p, '.jsonl') : null
    }
    if (!sid) {
      process.stderr.write('No session found for this folder: pass --session <id>.\n')
      return 1
    }
    const note = args.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--session').join(' ') || null
    const db = store.connect(defaultDbPath())
    try {
      ledger.mark(db, sid, kind, note)
    } finally {
      db.close()
    }
    process.stdout.write(`Recorded 1 ${LABELS[kind] ?? kind} for session ${sid.slice(0, 8)}.\n`)
    return 0
  }
  if (cmd === 'ingest') {
    const files = args.filter((a) => !a.startsWith('--')).flatMap(walk)
    let n = 0
    for (const f of files) {
      try {
        if (recordTranscript(argValue(args, '--db') ?? defaultDbPath(), f).turns) n++
      } catch {
        // an unreadable transcript is skipped
      }
    }
    process.stdout.write(`Ledger: ${n} sessions recorded from ${files.length} transcripts.\n`)
    return 0
  }
  if (cmd === 'report') {
    if (!money(args)) return 2
    const days = Number.parseInt(argValue(args, '--days') ?? '30', 10)
    const r = build(argValue(args, '--db') ?? defaultDbPath(), Math.max(0, Number.isNaN(days) ? 30 : days))
    process.stdout.write((args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r)) + '\n')
    return 0
  }
  process.stderr.write(`Unknown command ${cmd}. Commands: record, report, session, mark, ingest.\n`)
  return 2
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
