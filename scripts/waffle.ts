#!/usr/bin/env node
/**
 * tokenomics / waffle: are you paying for words you don't read?
 *
 * Output tokens cost five times input tokens, and none of them are cached. waffle splits a session's
 * output into the reply you read, what the agent wrote into tools (edits, new files, commands) and
 * thinking, then finds the avoidable part (rules: tokenomics/engine/verbosity.ts):
 *
 *   long replies    final replies longer than TOKENOMICS_WAFFLE_LONG tokens (default 500, ~375 words)
 *   recaps          replies that end a task by restating it ("## Summary", "Here's what I changed")
 *   full rewrites   Write used to replace an existing file whole, where an Edit would send only the
 *                   lines that changed
 *
 * and suggests the fix for each: a brevity rule in CLAUDE.md, an output style, Edit over Write, or a
 * lower effort when thinking dominates routine work.
 *
 *   waffle.ts [--session ID | --transcript FILE] [--json]     one session (default: newest in this folder)
 *   waffle.ts --days 7 [--projects DIR] [--json]              every session in the period
 *   add --currency USD to either. Read-only.
 */
import { findTranscript } from './coach.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { analyse, DEFAULT_LONG, merge, type Verbosity } from '../tokenomics/engine/verbosity.ts'
import { CostEngine, PolicyEngine } from '../tokenomics/services/index.ts'
import { argValue, isMain, type Obj } from '../tokenomics/util.ts'
import { numArg, recentTranscripts, useCurrency, write } from './common.ts'

const LABELS: Record<string, string> = { long_reply: 'Long replies', recap: 'Recaps', full_rewrite: 'Whole-file rewrites' }
const n = (v: number) => Math.round(v).toLocaleString('en-GB')
const longLimit = () => PolicyEngine.threshold('TOKENOMICS_WAFFLE_LONG', DEFAULT_LONG, { min: 50 })

function summarise(v: Verbosity, scope: Obj): Obj {
  const byKind: Record<string, { count: number, tokens: number, usd: number }> = {}
  for (const f of v.findings) {
    const k = byKind[f.kind] ??= { count: 0, tokens: 0, usd: 0 }
    k.count++
    k.tokens += f.tokens
    k.usd += f.usd
  }
  const tips: string[] = []
  const share = (k: keyof Verbosity['split']) => (v.output_tokens ? v.split[k] / v.output_tokens : 0)
  if (byKind.long_reply || byKind.recap || v.avg_reply_tokens > longLimit()) {
    tips.push('Add one line to CLAUDE.md: "Keep replies short: what changed and anything I must do. No recap of steps I watched." ' +
      'Or pick a terse output style with /output-style.')
  }
  if (byKind.full_rewrite) tips.push('Ask for Edit over Write on existing files ("change only the lines that need it"): a rewrite pays for the whole file as output.')
  if (share('thinking') > 0.6 && v.output_usd > 0.05) {
    tips.push(`Thinking is ${Math.round(share('thinking') * 100)}% of output. For routine work, a lower effort (/effort, or without "think hard" / "ultrathink") ` +
      'keeps the answer and drops most of the thinking bill.')
  }
  if (v.output_share >= 0.4 && !tips.length) tips.push('Output is a large share of spend. Ask for diffs and short answers rather than full listings.')
  return {
    ...scope, ...v, long_limit: longLimit(),
    split_share: { prose: Math.round(share('prose') * 100) / 100, tool_input: Math.round(share('tool_input') * 100) / 100,
      thinking: Math.round(share('thinking') * 100) / 100 },
    by_kind: Object.entries(byKind).map(([kind, k]) => ({ kind, label: LABELS[kind], count: k.count, tokens: k.tokens, usd: Math.round(k.usd * 1e6) / 1e6 }))
      .sort((a, b) => b.usd - a.usd),
    findings: [...v.findings].sort((a, b) => b.usd - a.usd).slice(0, 10),
    tips,
  }
}

export function forTrace(t: trace.Trace): Obj {
  return summarise(analyse(t, longLimit()), { scope: 'session', session_id: t.sessionId, sessions: 1 })
}

export function forPeriod(days: number, root?: string): Obj {
  let total: Verbosity | null = null
  const worst: { session_id: string | null, avoidable_usd: number, output_usd: number }[] = []
  let sessions = 0
  for (const p of recentTranscripts(days, root)) {
    const t = trace.parse(p)
    if (!t.turns.length) continue
    const v = analyse(t, longLimit())
    sessions++
    worst.push({ session_id: t.sessionId, avoidable_usd: v.avoidable_usd, output_usd: v.output_usd })
    total = merge(total, v)
  }
  const empty: Verbosity = { output_tokens: 0, output_usd: 0, spend_usd: 0, output_share: 0, split: { prose: 0, tool_input: 0, thinking: 0 },
    split_usd: { prose: 0, tool_input: 0, thinking: 0 }, replies: 0, avg_reply_tokens: 0, findings: [], avoidable_usd: 0 }
  return { ...summarise(total ?? empty, { scope: 'period', period: days ? `last ${days} days` : 'all time', sessions }),
    worst_sessions: worst.filter((w) => w.avoidable_usd > 0).sort((a, b) => b.avoidable_usd - a.avoidable_usd).slice(0, 5) }
}

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const title = r.scope === 'session' ? `session ${String(r.session_id ?? '').slice(0, 8)}` : `${r.period}, ${r.sessions} session${r.sessions === 1 ? '' : 's'}`
  const L = [`# waffle: what the agent wrote, ${title}`, '']
  if (!r.output_tokens) {
    L.push('No output recorded yet.')
    return L.join('\n')
  }
  const pc = (v: number) => `${Math.round(v * 100)}%`
  L.push(`**Output cost ${fmt(r.output_usd)}, ${pc(r.output_share)} of ${fmt(r.spend_usd)}** (${n(r.output_tokens)} tokens). ` +
    `Of that: replies ${pc(r.split_share.prose)}, tool input (edits, files, commands) ${pc(r.split_share.tool_input)}, thinking ${pc(r.split_share.thinking)}.` +
    (r.replies ? ` ${r.replies} final repl${r.replies === 1 ? 'y' : 'ies'} averaged ${n(r.avg_reply_tokens)} tokens.` : ''), '')
  if (r.by_kind.length) {
    L.push(`**About ${fmt(r.avoidable_usd)} was avoidable:**`, '', '| What | Count | Tokens | Cost |', '|---|---:|---:|---:|')
    for (const k of r.by_kind) L.push(`| ${k.label} | ${k.count} | ${n(k.tokens)} | ${fmt(k.usd)} |`)
    L.push('')
    for (const f of r.findings.slice(0, 5)) L.push(`- ${fmt(f.usd)}: ${f.detail}`)
    L.push('')
  } else {
    L.push('Nothing avoidable stood out: replies were short and edits were edits.', '')
  }
  if (r.worst_sessions?.length) {
    L.push('**Wordiest sessions:** ' + r.worst_sessions.map((w: Obj) => `\`${String(w.session_id ?? '?').slice(0, 8)}\` ${fmt(w.avoidable_usd)}`).join(' · '), '')
  }
  if (r.tips.length) {
    L.push('## Say less, pay less', '')
    for (const t of r.tips) L.push(`- ${t}`)
    L.push('')
  }
  L.push('_Prose and tool input are estimated at about 4 characters a token; thinking is the rest of the billed output._')
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
