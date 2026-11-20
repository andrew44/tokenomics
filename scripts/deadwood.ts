#!/usr/bin/env node
/**
 * tokenomics / deadwood: what did we spend on work that produced nothing? Not AI spend: wasted AI spend.
 *
 * Every session in the ledger gets a status from observable signals (OutcomeEngine), never from token
 * counts: succeeded, failed, discarded, abandoned, unverified or no change. Dead work is:
 *
 *   failed implementations   code changed, and the last test / build / lint run failed
 *   work discarded           the change was reverted (git checkout / restore / reset --hard / stash),
 *                            the user refused it, or every file created was deleted
 *   abandoned tasks          code changed, then the user interrupted with nothing verified
 *   repeated debugging       inside work that did succeed: the same check failing a 3rd time and on
 *   unused generated files   files written and then deleted, or never used again in unshipped work
 *
 * Questions and research (no change) and unverified work (changed, no signal either way) are never
 * counted as waste; mark them when you know (`deadwood mark discarded --session ID`).
 *
 *   deadwood.ts [--month 2026-11 | --days 30] [--merged] [--json] [--currency USD]
 *                       the report (default: this calendar month); --merged also checks which commits
 *                       made it onto the main branch (accepted changes)
 *   deadwood.ts session [--session ID | --transcript FILE] [--json]    one session's verdict and dead spend
 *   deadwood.ts mark <accepted|discarded|abandoned|failed> [note] [--session ID]
 *
 * The ledger is written by bangforbuck at each turn end (Claude Code). Copilot sessions are judged from
 * their hook events by the same rules and counted, but not priced (premium requests).
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { CostEngine, InsightsEngine, OutcomeEngine } from '../tokenomics/services/index.ts'
import { eventSessions } from '../tokenomics/services/value.ts'
import { argValue, isMain, today, type Obj } from '../tokenomics/util.ts'
import { pctChange, period, previous, round2, useCurrency, write } from './common.ts'

const round6 = (v: number) => Math.round(v * 1e6) / 1e6
const DEAD = new Set<string>(OutcomeEngine.DEAD)

/** A row's dead items (a hand mark that changed the status replaces them). */
export function deadItems(r: ledger.LedgerRow): { kind: string, usd: number, detail: string }[] {
  if (r.status && DEAD.has(r.status)) {
    const items = (r.dead ?? []).filter((x: Obj) => x.kind === r.status)
    return items.length ? items as any : [{ kind: r.status, usd: r.cost_usd, detail: r.status_reason ?? r.status }]
  }
  if (r.status === 'succeeded' && r.status_reason?.startsWith('marked')) return []
  return ((r.dead ?? []) as any[]).filter((x) => !DEAD.has(x.kind))
}

function summarise(rows: ledger.LedgerRow[]) {
  const spend = rows.reduce((a, r) => a + r.cost_usd, 0)
  const byKind: Record<string, { usd: number, count: number }> = {}
  const byStatus: Record<string, { sessions: number, usd: number }> = {}
  let dead = 0
  for (const r of rows) {
    const st = r.status ?? 'unverified'
    const s = byStatus[st] ??= { sessions: 0, usd: 0 }
    s.sessions++
    s.usd += r.cost_usd
    for (const it of deadItems(r)) {
      const k = byKind[it.kind] ??= { usd: 0, count: 0 }
      k.usd += it.usd
      k.count++
      dead += it.usd
    }
  }
  return { spend, dead: Math.min(dead, spend), byKind, byStatus }
}

export function build(args: string[], dbPath = defaultDbPath()): Obj {
  const month = argValue(args, '--month') ?? (argValue(args, '--days') === null ? today().slice(0, 7) : null)
  const p = period(month ? [...args, '--month', month] : args, 30)
  const prev = previous(p)
  if (!existsSync(dbPath)) return { period: p.label, empty: true }
  const [rows, before, copilot] = withDb(dbPath, (db) => [ledger.rows(db, p.since, p.until),
    prev ? ledger.rows(db, prev.since, prev.until) : [], eventSessions(db, p.since).filter((c) => c.last.slice(0, 10) <= p.until)], { readOnly: true })
  const now_ = summarise(rows)
  const was = before.length ? summarise(before) : null
  const groupDead = (key: (r: ledger.LedgerRow) => string) => InsightsEngine.attribute(rows, (r) => [[key(r), 1]], (r) => r.cost_usd,
    (r) => r.status ?? null, (r) => deadItems(r).reduce((a, x) => a + x.usd, 0))
    .map((g) => ({ key: g.key, sessions: g.sessions, spend_usd: g.cost_usd, dead_usd: g.dead_usd, dead_share: g.cost_usd ? round2(g.dead_usd / g.cost_usd) : 0 }))
    .filter((g) => g.dead_usd > 0).sort((a, b) => b.dead_usd - a.dead_usd)
  let accepted: Obj | null = null
  if (args.includes('--merged')) {
    const committed = rows.filter((r) => (r.commits ?? []).length)
    const merged = committed.filter((r) => OutcomeEngine.mergedCommits(r.cwd, r.commits ?? []).length)
    accepted = { committed_sessions: committed.length, merged_sessions: merged.length,
      merged_share: committed.length ? round2(merged.length / committed.length) : null }
  }
  const unverified = now_.byStatus.unverified ?? { sessions: 0, usd: 0 }
  return {
    period: p.label, since: p.since, until: p.until, empty: !rows.length && !copilot.length,
    sessions: rows.length, spend_usd: round6(now_.spend), dead_usd: round6(now_.dead), dead_share: now_.spend ? round2(now_.dead / now_.spend) : 0,
    previous: was && { spend_usd: round6(was.spend), dead_usd: round6(was.dead), dead_share: was.spend ? round2(was.dead / was.spend) : 0 },
    change_pct: was ? pctChange(now_.dead, was.dead) : null,
    by_kind: Object.entries(now_.byKind).map(([kind, v]) => ({ kind, label: InsightsEngine.DEAD_LABELS[kind] ?? kind, count: v.count, usd: round6(v.usd) }))
      .sort((a, b) => b.usd - a.usd),
    by_status: Object.fromEntries(Object.entries(now_.byStatus).map(([k, v]) => [k, { sessions: v.sessions, usd: round6(v.usd) }])),
    unverified: { sessions: unverified.sessions, usd: round6(unverified.usd) },
    by_project: groupDead((r) => r.project || basename(r.cwd || '') || 'unknown'),
    by_model: groupDead((r) => r.model || 'unknown'),
    by_category: groupDead((r) => r.category || 'unknown'),
    worst: rows.map((r) => ({ r, usd: deadItems(r).reduce((a, x) => a + x.usd, 0) })).filter((x) => x.usd > 0)
      .sort((a, b) => b.usd - a.usd).slice(0, 5)
      .map(({ r, usd }) => ({ session_id: r.session_id, day: r.day, project: r.project || basename(r.cwd || ''), status: r.status,
        reason: r.status_reason, dead_usd: round6(usd), items: deadItems(r).map((x) => x.detail).slice(0, 3) })),
    accepted,
    copilot: copilot.length ? { sessions: copilot.length, dead: copilot.filter((c) => DEAD.has(c.status)).length,
      prompts_dead: copilot.filter((c) => DEAD.has(c.status)).reduce((a, c) => a + c.prompts, 0),
      by_status: Object.fromEntries(OutcomeEngine.STATUSES.map((s) => [s, copilot.filter((c) => c.status === s).length]).filter(([, n]) => n)) } : null,
  }
}

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const L = [`# deadwood: spend that produced nothing, ${r.period}`, '']
  if (r.empty) {
    return [...L, 'Nothing in the ledger for this window yet. It fills in at the end of each Claude Code turn; ' +
      'backfill with `bangforbuck.ts ingest ~/.claude/projects`.'].join('\n')
  }
  const ch = r.change_pct === null ? '' : ` (${r.change_pct > 0 ? '+' : ''}${r.change_pct}% vs the period before)`
  L.push(`**${fmt(r.dead_usd)} of ${fmt(r.spend_usd)} (${Math.round(r.dead_share * 100)}%) bought nothing**${ch}, across ${r.sessions} sessions.`, '')
  if (r.by_kind.length) {
    L.push('| Dead work | Count | Spend |', '|---|---:|---:|')
    for (const k of r.by_kind) L.push(`| ${k.label} | ${k.count} | ${fmt(k.usd)} |`)
    L.push('')
  }
  const st = r.by_status
  L.push('**Every session, by outcome:** ' + OutcomeEngine.STATUSES.filter((s) => st[s]).map((s) => `${s.replace('_', ' ')} ${st[s].sessions} (${fmt(st[s].usd)})`).join(' · '), '')
  if (r.unverified.sessions) {
    L.push(`_${r.unverified.sessions} sessions (${fmt(r.unverified.usd)}) changed code with no test, commit or acceptance seen. ` +
      'They are not counted as waste. Mark the ones you know: `deadwood.ts mark discarded --session <id>` or `mark accepted`._', '')
  }
  if (r.worst.length) {
    L.push('## The biggest losses', '')
    for (const w of r.worst) L.push(`- ${w.day} **${w.project || 'unknown'}** \`${String(w.session_id).slice(0, 8)}\` ${w.status}: ${fmt(w.dead_usd)}. ${w.items.join('; ')}`)
    L.push('')
  }
  for (const [title, list] of [['By project', r.by_project], ['By model', r.by_model], ['By task category', r.by_category]] as [string, Obj[]][]) {
    if (!list.length) continue
    L.push(`**${title}:** ` + list.slice(0, 5).map((g) => `${g.key} ${fmt(g.dead_usd)} (${Math.round(g.dead_share * 100)}% of its spend)`).join(' · '), '')
  }
  if (r.accepted) L.push(`**Accepted changes:** ${r.accepted.merged_sessions} of ${r.accepted.committed_sessions} sessions that committed made it onto the main branch.`, '')
  if (r.copilot) {
    L.push(`**Copilot CLI:** ${r.copilot.dead} of ${r.copilot.sessions} sessions produced nothing (${r.copilot.prompts_dead} premium requests). ` +
      Object.entries(r.copilot.by_status).map(([k, v]) => `${v} ${k}`).join(', ') + '.', '')
  }
  L.push('_Status comes from what happened (checks, commits, reverts, refusals), never from token counts. Research and Q&A are not waste._')
  return L.join('\n')
}

function sessionReport(args: string[]): number {
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  const t = trace.parse(p)
  const v = OutcomeEngine.judge(t)
  const d = InsightsEngine.deadWork(t, v)
  const out = { session_id: t.sessionId || basename(p, '.jsonl'), status: v.status, reason: v.reason, cost_usd: round6(trace.costUsd(t)),
    dead_usd: d.dead_usd, items: d.items, quality: OutcomeEngine.quality(v.signals),
    signals: { files_changed: v.signals.files.length, checks: v.signals.checks, committed: v.signals.committed, pr: v.signals.pr,
      rejected: v.signals.rejected, interrupts: v.signals.interrupts, reverted: v.signals.reverted } }
  if (args.includes('--json')) {
    write(JSON.stringify(out, null, 2))
    return 0
  }
  const { fmt } = CostEngine.display()
  write([`Session ${out.session_id.slice(0, 8)}: ${out.status} (${out.reason}). Cost ${fmt(out.cost_usd)}, dead ${fmt(out.dead_usd)}.`,
    ...d.items.map((x) => `- ${InsightsEngine.DEAD_LABELS[x.kind] ?? x.kind}: ${fmt(x.usd)}, ${x.detail}`)].join('\n'))
  return 0
}

const MARKS = ['accepted', 'discarded', 'rejected', 'abandoned', 'failed']

export function main(argv: string[]): number {
  const [cmd = '', ...rest] = argv
  if (cmd === 'session') return sessionReport(rest)
  if (cmd === 'mark') {
    const kind = (rest[0] ?? '').toLowerCase()
    if (!MARKS.includes(kind)) {
      process.stderr.write(`Usage: deadwood.ts mark <${MARKS.join('|')}> [note] [--session ID]\n`)
      return 2
    }
    let sid = argValue(rest, '--session')
    if (!sid) {
      const p = findTranscript({})
      sid = p ? basename(p, '.jsonl') : null
    }
    if (!sid) {
      process.stderr.write('No session found for this folder: pass --session <id>.\n')
      return 1
    }
    const note = rest.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--session').join(' ') || null
    const db = store.connect(defaultDbPath())
    try {
      ledger.mark(db, sid, kind, note)
    } finally {
      db.close()
    }
    write(`Marked session ${sid.slice(0, 8)} ${kind}.`)
    return 0
  }
  const args = cmd === 'report' ? rest : argv
  if (!useCurrency(args)) return 2
  const r = build(args)
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
