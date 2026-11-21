#!/usr/bin/env node
/**
 * tokenomics / coldsnap: why did the prompt cache go cold, and what did each time cost?
 *
 * A warm cache makes re-sending the conversation cost a tenth of the input price. Every time it goes
 * cold, the whole context is written to the cache again at 1.25x (or 2x) the input price. coldsnap
 * finds every rebuild in your sessions and names its cause (rules: tokenomics/engine/coldcache.ts):
 *
 *   idle            a break longer than the cache lives (5 minutes, or 1 hour)
 *   model switch    a different model mid-conversation (each model has its own cache)
 *   prefix change   something early in the context changed: CLAUDE.md, an MCP server or skill,
 *                   settings, or an edited earlier message
 *   compaction      /compact or auto-compact (expected, never counted as avoidable)
 *
 * with the premium each one cost over a warm read, the fix for each cause, and, for sessions on the
 * 5-minute cache, what the 1-hour cache would have saved net of its dearer writes.
 *
 *   coldsnap.ts [--session ID | --transcript FILE] [--json]     one session (default: newest in this folder)
 *   coldsnap.ts --days 7 [--projects DIR] [--json]              every session in the period
 *   add --currency USD to either. Read-only.
 */
import { findTranscript } from './coach.ts'
import { analyse, merge, type Cause, type ColdCache } from '../tokenomics/engine/coldcache.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { CostEngine } from '../tokenomics/services/index.ts'
import { argValue, isMain, type Obj } from '../tokenomics/util.ts'
import { numArg, recentTranscripts, useCurrency, write } from './common.ts'

const LABELS: Record<Cause, string> = {
  idle: 'Breaks longer than the cache lives', model_switch: 'Model switched mid-conversation',
  prefix_change: 'Start of the context changed', compaction: 'Compaction (expected)',
}
const n = (v: number) => Math.round(v).toLocaleString('en-GB')
const r6 = (v: number) => Math.round(v * 1e6) / 1e6

function summarise(c: ColdCache, scope: Obj): Obj {
  const byCause: Partial<Record<Cause, { count: number, tokens: number, usd: number }>> = {}
  for (const r of c.rebuilds) {
    const k = byCause[r.cause] ??= { count: 0, tokens: 0, usd: 0 }
    k.count++
    k.tokens += r.tokens
    k.usd += r.usd
  }
  const { fmt } = CostEngine.display()
  const tips: string[] = []
  if (byCause.idle) {
    tips.push('Breaks: carrying on in a cold conversation re-writes all of it. After a break, `/clear` and let the doggybag note ' +
      'bring you back for a few thousand tokens, or wrap up before you step away.')
  }
  if (c.ttl_1h && c.ttl_1h.net_usd > 0.01) {
    tips.push(`Your breaks are mostly under an hour: the 1-hour cache would have saved about ${fmt(c.ttl_1h.saved_usd)}, ` +
      `less ${fmt(c.ttl_1h.extra_usd)} for its dearer writes (${fmt(c.ttl_1h.net_usd)} net). Worth switching on where your provider offers it.`)
  }
  if (byCause.model_switch) {
    tips.push('Model switches: pick the model when you start a task (after `/clear`), not halfway through; each switch re-writes ' +
      'the whole conversation. The pennywise router keeps the model while its cache is warm.')
  }
  if (byCause.prefix_change) {
    tips.push('Prefix changes: edit CLAUDE.md, add or remove MCP servers and plugins, and change settings between sessions, not ' +
      'during one. Editing or rewinding an early message has the same effect.')
  }
  return {
    ...scope, ...c,
    by_cause: (Object.entries(byCause) as [Cause, { count: number, tokens: number, usd: number }][])
      .map(([cause, k]) => ({ cause, label: LABELS[cause], count: k.count, tokens: k.tokens, usd: r6(k.usd) }))
      .sort((a, b) => b.usd - a.usd),
    rebuilds: [...c.rebuilds].sort((a, b) => b.usd - a.usd).slice(0, 10),
    rebuild_count: c.rebuilds.length,
    tips,
  }
}

export function forTrace(t: trace.Trace): Obj {
  return summarise(analyse(t), { scope: 'session', session_id: t.sessionId, sessions: 1 })
}

export function forPeriod(days: number, root?: string): Obj {
  let total: ColdCache | null = null
  const worst: { session_id: string | null, avoidable_usd: number, rebuilds: number }[] = []
  let sessions = 0
  for (const p of recentTranscripts(days, root)) {
    const t = trace.parse(p)
    if (!t.turns.length) continue
    const c = analyse(t)
    sessions++
    worst.push({ session_id: t.sessionId, avoidable_usd: c.avoidable_usd, rebuilds: c.rebuilds.length })
    total = merge(total, c)
  }
  const empty: ColdCache = { requests: 0, input_tokens: 0, cache_write_tokens: 0, cache_read_tokens: 0, hit_ratio: null,
    rebuilds: [], rebuild_usd: 0, avoidable_usd: 0, ttl_1h: null }
  return { ...summarise(total ?? empty, { scope: 'period', period: days ? `last ${days} days` : 'all time', sessions }),
    worst_sessions: worst.filter((w) => w.avoidable_usd > 0).sort((a, b) => b.avoidable_usd - a.avoidable_usd).slice(0, 5) }
}

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const title = r.scope === 'session' ? `session ${String(r.session_id ?? '').slice(0, 8)}` : `${r.period}, ${r.sessions} session${r.sessions === 1 ? '' : 's'}`
  const L = [`# coldsnap: when the cache went cold, ${title}`, '']
  if (!r.requests) {
    L.push('No requests recorded yet.')
    return L.join('\n')
  }
  L.push(`${n(r.requests)} requests, ${r.hit_ratio === null ? 'no' : `${Math.round(r.hit_ratio * 100)}%`} of input read from a warm cache.`, '')
  if (!r.rebuild_count) {
    L.push('The cache never went cold mid-conversation: nothing to fix.')
    return L.join('\n')
  }
  L.push(`**The cache was rebuilt ${r.rebuild_count} time${r.rebuild_count === 1 ? '' : 's'}, costing ${fmt(r.rebuild_usd)} more than warm reads; ` +
    `${fmt(r.avoidable_usd)} of it avoidable.**`, '', '| Cause | Times | Tokens re-written | Extra cost |', '|---|---:|---:|---:|')
  for (const k of r.by_cause) L.push(`| ${k.label} | ${k.count} | ${n(k.tokens)} | ${fmt(k.usd)} |`)
  L.push('')
  for (const b of r.rebuilds.slice(0, 5)) L.push(`- ${fmt(b.usd)}: ${n(b.tokens)} tokens, ${b.detail}`)
  L.push('')
  if (r.worst_sessions?.length) {
    L.push('**Coldest sessions:** ' + r.worst_sessions.map((w: Obj) => `\`${String(w.session_id ?? '?').slice(0, 8)}\` ${fmt(w.avoidable_usd)}`).join(' · '), '')
  }
  if (r.tips.length) {
    L.push('## Keep it warm', '')
    for (const t of r.tips) L.push(`- ${t}`)
    L.push('')
  }
  L.push('_Extra cost is each rebuild\'s cache write less what a warm read of the same tokens would have cost._')
  return L.join('\n')
}

export function main(args: string[]): number {
  if (!useCurrency(args)) return 2
  let r: Obj
  if (argValue(args, '--days') !== null) {
    r = forPeriod(Math.max(0, Math.trunc(numArg(args, '--days', 7))), argValue(args, '--projects') ?? undefined)
  } else {
    const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
    if (!p) {
      process.stderr.write('No transcript found. Pass --transcript <file.jsonl>, --session <id>, or --days 7 for every recent session.\n')
      return 1
    }
    r = forTrace(trace.parse(p))
  }
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
