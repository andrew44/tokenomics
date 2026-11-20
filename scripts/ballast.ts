#!/usr/bin/env node
/**
 * tokenomics / ballast: stop paying to carry finished work into the next task.
 *
 * Every step re-sends the whole conversation. When you move on to a different task in the same chat,
 * everything from the last one comes along and is re-read at every step of the new one. ballast
 * notices, says what that costs per step, and suggests /clear (doggybag keeps your notes) or /compact.
 * Rules: tokenomics/engine/ballast.ts.
 *
 * Prompt hook (Claude Code: UserPromptSubmit). Speaks up when the context is over the threshold and
 *   new_task   the prompt looks like a different task (little in common with the recent prompts and
 *              the files the agent touched, or "new task", "unrelated", "something else" ...)
 *   heavy      the context has grown past another multiple of the threshold
 * at most once per rule and size band per session. Prompts starting with "/" are never checked, and a
 * cold cache is left to doggybag. Copilot CLI reports no token counts, so it has no ballast hook.
 *
 *   ballast.ts [source]                                         hook (stdin: hook JSON)
 *   ballast.ts check [--session ID | --transcript FILE] [--json]
 *                     replay a session: every task switch that carried old context, and what it cost
 *
 * Env: TOKENOMICS_BALLAST = warn (default: a notice) | block (pause that prompt once; send it again
 *      to go ahead) | off, TOKENOMICS_BALLAST_MIN_TOKENS (default 60000).
 * Always exits 0; a crash never blocks a prompt.
 */
import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import { carry, lastContext, readCostUsd, stepsPerPrompt, topicShift } from '../tokenomics/engine/ballast.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { CostEngine, PolicyEngine } from '../tokenomics/services/index.ts'
import { argValue, errText, first, isMain, logErr, readPayload, type Obj } from '../tokenomics/util.ts'
import { useCurrency, write } from './common.ts'

const TAIL_BYTES = 2 * 1024 * 1024
const minTokens = () => PolicyEngine.threshold('TOKENOMICS_BALLAST_MIN_TOKENS', 60_000, { min: 1000 })
const n = (v: number) => Math.round(v).toLocaleString('en-GB')

function said(dbPath: string, sid: string): { rule: string, band: number }[] {
  try {
    return withDb(dbPath, (db) => (db.tables().has('ballast_events')
      ? db.all('SELECT rule, band FROM ballast_events WHERE session_id=?', sid).map((r) => ({ rule: String(r.rule), band: Number(r.band) }))
      : []), { readOnly: true })
  } catch {
    return []
  }
}

/** What to say about this prompt, or null. Exported for tests. */
export function decide(prompt: string, t: trace.Trace, history: { rule: string, band: number }[], nowS = Date.now() / 1000):
  { rule: string, band: number, ctx: number, stepUsd: number, message: string } | null {
  if (!prompt.trim() || prompt.trimStart().startsWith('/')) return null
  const last = lastContext(t)
  const min = minTokens()
  if (!last || last.ctx < min) return null
  const ttl = Number(process.env.TOKENOMICS_CACHE_TTL) || (last.ttl1h ? 3600 : 300)
  if (last.ts !== null && nowS - last.ts > ttl) return null                    // cold: doggybag's job
  const band = Math.floor(last.ctx / min)
  const stepUsd = readCostUsd(last.ctx, last.model)
  const { fmt } = CostEngine.display()
  const steps = stepsPerPrompt(t)
  const per = `about ${fmt(stepUsd)} a step${steps > 1 ? `, roughly ${fmt(stepUsd * steps)} for a task like your last ones (${steps} steps)` : ''}`
  const shift = topicShift(prompt, t)
  if (shift.shift && !history.some((h) => h.rule === 'new_task' && h.band >= band)) {
    return { rule: 'new_task', band, ctx: last.ctx, stepUsd,
      message: `ballast: this looks like a new task, but the conversation still carries ${n(last.ctx)} tokens from the last one, ` +
        `re-read at every step (${per}). /clear starts it light (doggybag keeps your notes), or /compact keeps a summary. ` +
        'Ignore this if the new task needs what came before.' }
  }
  const top = Math.max(0, ...history.map((h) => h.band))
  if (band > top) {
    return { rule: 'heavy', band, ctx: last.ctx, stepUsd,
      message: `ballast: the conversation is now ${n(last.ctx)} tokens, re-read at every step (${per}). ` +
        'If the early part is finished work, `/compact <what to keep>` trims it.' }
  }
  return null
}

function hook(source: string): void {
  const mode = PolicyEngine.mode('TOKENOMICS_BALLAST', 'warn', ['warn', 'block', 'off'])
  if (mode === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const path = first(payload, ['transcript_path', 'transcriptPath'])
    if (!path) return
    const adapter = getAdapter(source)
    const sid = adapter.sessionId(payload)
    const prompt = String(first(payload, ['prompt', 'userPrompt'], '') || '')
    const d = decide(prompt, trace.parse(String(path), { tail: TAIL_BYTES }), said(dbPath, sid))
    if (!d) return
    const action: PolicyEngine.Action = mode === 'block' ? 'block' : 'warn'
    const out = PolicyEngine.enforce(adapter, action, mode === 'block' ? `${d.message} (Send the prompt again to go ahead as it is.)` : d.message)
    PolicyEngine.log(dbPath, 'ballast_events', { session_id: sid, source: adapter.name, rule: d.rule, ctx_tokens: d.ctx,
      step_usd: Math.round(d.stepUsd * 1e6) / 1e6, band: d.band, action: PolicyEngine.effective(adapter, action) })
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(dbPath, `ballast\n${errText(e)}`)
  }
}

export function check(t: trace.Trace): Obj {
  const min = minTokens()
  const shifts = carry(t, min)
  const main = t.turns.filter((x) => !x.sidechain && x.ctx > 0)
  const heavy = main.filter((x) => x.ctx >= min)
  return {
    session_id: t.sessionId, min_tokens: min, requests: main.length, peak_context: trace.peakContext(t),
    heavy_requests: heavy.length, heavy_read_usd: Math.round(heavy.reduce((a, x) => a + readCostUsd(x.ctx, x.model), 0) * 1e6) / 1e6,
    task_switches: shifts.map((s) => ({ ...s, usd: Math.round(s.usd * 1e6) / 1e6 })),
    carried_usd: Math.round(shifts.reduce((a, s) => a + s.usd, 0) * 1e6) / 1e6,
  }
}

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const L = [`# ballast: context carried between tasks, session ${String(r.session_id ?? '').slice(0, 8)}`, '',
    `Peak context ${n(r.peak_context)} tokens. ${r.heavy_requests} of ${r.requests} requests ran with more than ${n(r.min_tokens)} tokens ` +
    `(re-reading it cost ${fmt(r.heavy_read_usd)}).`, '']
  if (!r.task_switches.length) {
    L.push('No task switches with a heavy context: nothing was carried that a /clear would have saved.')
    return L.join('\n')
  }
  L.push(`**${fmt(r.carried_usd)} went on re-reading earlier tasks' context** after the conversation moved on:`, '')
  for (const s of r.task_switches) {
    L.push(`- prompt ${s.prompt + 1} "${s.preview}": carried ${n(s.ctx)} tokens for ${s.steps} steps, ${fmt(s.usd)}${s.cue ? ' (you said it was a new task)' : ''}`)
  }
  L.push('', 'Next time: /clear when you switch task (doggybag keeps your notes), or /compact with what to keep. ' +
    '_A "switch" is judged from the words of your prompts; ignore any that needed the earlier context._')
  return L.join('\n')
}

export function main(args: string[]): number {
  if (args[0] !== 'check') {
    hook(args[0] ?? 'claude-code')
    return 0
  }
  if (!useCurrency(args)) return 2
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  const r = check(trace.parse(p))
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
