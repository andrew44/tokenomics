#!/usr/bin/env node
/**
 * tokenomics / sherlock: agent forensics. Not what the session spent, but what the agent did,
 * and exactly where money went that bought nothing: files read twice, calls repeated with the
 * same answer, searches rephrased into the same results, big outputs never used, subagents
 * doing overlapping or one-step jobs. Each finding has a cost, a reason and a fix.
 * Rules and costing: tokenomics/engine/forensics.ts.
 *
 *   sherlock.ts                        the newest session in this folder
 *   sherlock.ts --session ID | --transcript FILE
 *   sherlock.ts --json                 machine-readable (used by the sherlock skill)
 *   sherlock.ts log [source]           hook (SessionEnd): record the session's waste for the spend report
 *
 * Read-only on transcripts. Env: TOKENOMICS_SHERLOCK=off turns the hook off.
 */
import { basename } from 'node:path'

import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import * as events from '../tokenomics/engine/events.ts'
import { investigate, type Investigation } from '../tokenomics/engine/forensics.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { argValue, errText, first, fmt, isMain, logErr, readPayload, type Obj } from '../tokenomics/util.ts'

const KIND_NAMES: Record<string, string> = {
  repeated_read: 'Repeated file reads', redundant_call: 'Redundant tool calls', repeated_search: 'Searches returning the same thing',
  unused_result: 'Results never used', overlapping_agents: 'Subagents doing overlapping work', needless_agent: 'Unnecessary subagent delegation',
}

export function analyse(path: string): Investigation & { session_id: string, transcript: string } {
  const t = trace.parse(path)
  return { session_id: t.sessionId || basename(path, '.jsonl'), transcript: path, ...investigate(t) }
}

export function markdown(r: Obj, money: [string, string, number] = currency.current()): string {
  const [, symbol, rate] = money
  const m = (usd: number) => currency.formatMoney(usd * rate, symbol)
  const L = [`# sherlock: session ${String(r.session_id).slice(0, 8)}`, '']
  if (!r.findings.length) {
    L.push(`No hidden waste found in ${r.tool_calls} tool calls. Session cost ${m(r.session_cost_usd)}.`, '')
    return L.join('\n')
  }
  L.push(`**About ${m(r.wasted_usd)} of ${m(r.session_cost_usd)} (${Math.round(r.share * 100)}%) bought nothing**: ` +
    `~${fmt(r.wasted_tokens)} tokens across ${r.tool_calls} tool calls${r.subagents ? ` and ${r.subagents} subagents` : ''}.`, '',
  '| Evidence | Count | Tokens | Cost |', '|---|---:|---:|---:|')
  for (const [k, v] of Object.entries(r.by_kind as Record<string, Obj>).sort((a, b) => b[1].usd - a[1].usd)) {
    L.push(`| ${KIND_NAMES[k] ?? k} | ${v.count} | ${fmt(v.tokens)} | ${m(v.usd)} |`)
  }
  L.push('', '## The worst offenders', '')
  for (const f of r.findings.slice(0, 6)) {
    L.push(`- **${KIND_NAMES[f.kind] ?? f.kind}**: \`${f.tool}\` ${f.detail ? `\`${f.detail}\`` : ''}${f.times > 1 ? ` (${f.times}x)` : ''}, ` +
      `${m(f.usd)}. ${f.why} _Fix:_ ${f.fix}`)
  }
  L.push('', '_Costs are estimates: tokens added to the context, written to the cache once and re-read on each later turn._', '')
  return L.join('\n')
}

function hook(source: string): void {
  if ((process.env.TOKENOMICS_SHERLOCK ?? '').trim().toLowerCase() === 'off' || source === 'copilot') return
  try {
    const payload = readPayload()
    const path = first(payload, ['transcript_path', 'transcriptPath'])
    if (!path) return
    const r = analyse(String(path))
    if (!r.tool_calls) return
    const top = r.findings[0]
    events.log(defaultDbPath(), 'sherlock_events', { session_id: first(payload, ['session_id', 'sessionId'], r.session_id),
      wasted_usd: r.wasted_usd, session_usd: r.session_cost_usd, findings: r.findings.length, top_kind: top?.kind ?? null })
  } catch (e) {
    logErr(defaultDbPath(), `sherlock\n${errText(e)}`)
  }
}

export function main(args: string[]): number {
  if (args[0] === 'log') {
    hook(args[1] ?? 'claude-code')
    return 0
  }
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  const r = analyse(p)
  process.stdout.write((args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r)) + '\n')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
