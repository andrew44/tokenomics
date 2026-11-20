#!/usr/bin/env node
/**
 * tokenomics / groundhog: stop the agent living the same few minutes over and over. Catches it
 * going round in circles before the loop gets expensive: the same call with the same input, a
 * command that keeps failing, an edit made and undone, tokens climbing with nothing getting done.
 * Rules: tokenomics/engine/loops.ts.
 *
 * Pre-tool hook (Claude Code: PreToolUse on every tool; Copilot: preToolUse, identical calls only).
 * The first time a loop is caught, the call is refused with a reason that tells the model to step
 * back and change strategy. What happens if it carries on depends on the mode:
 *
 *   block (default)  refuse twice, then let it through and tell you
 *   interrupt        refuse once, then end the turn so you can step in
 *   warn             never refuse; tell you once
 *   off
 *
 *   groundhog.ts [source]                       hook (stdin: hook JSON)
 *   groundhog.ts check [--session ID | --transcript FILE] [--json]
 *                                                replay a session and list every loop it got into
 *
 * Env: TOKENOMICS_GROUNDHOG (mode above), TOKENOMICS_GROUNDHOG_REPEAT (identical calls allowed, 3),
 *      TOKENOMICS_GROUNDHOG_FAILS (failures of one command in a row, 3).
 * Bypass for one command: append `# groundhog-ok`. Always exits 0; a crash never blocks a call.
 */
import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as events from '../tokenomics/engine/events.ts'
import { DEFAULTS, detect, type Loop, type Options } from '../tokenomics/engine/loops.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { argValue, asDict, errText, first, isMain, isObj, logErr, readPayload, type Obj } from '../tokenomics/util.ts'

const TAIL_BYTES = 3 * 1024 * 1024        // loops are recent: the last 3 MB of a transcript is plenty

function options(): Options {
  const n = (name: string, d: number) => {
    const v = Number.parseInt(process.env[name] ?? '', 10)
    return Number.isFinite(v) && v >= 2 ? v : d
  }
  return { ...DEFAULTS, repeat: n('TOKENOMICS_GROUNDHOG_REPEAT', DEFAULTS.repeat), fails: n('TOKENOMICS_GROUNDHOG_FAILS', DEFAULTS.fails) }
}

function history(dbPath: string, sid: string, key: string): Record<string, number> {
  try {
    return withDb(dbPath, (db) => {
      if (!db.tables().has('groundhog_events')) return {}
      return Object.fromEntries(db.all('SELECT action, COUNT(*) AS n FROM groundhog_events WHERE session_id=? AND loop_key=? GROUP BY action',
        sid, key).map((r) => [r.action, Number(r.n)]))
    })
  } catch {
    return {}
  }
}

/** Copilot has no transcript: remember recent calls in the database and catch identical repeats. */
function copilotLoop(dbPath: string, sid: string, name: string, args: Obj, o: Options): Loop | null {
  const key = trace.callKey(name, args)
  const recent = withDb(dbPath, (db) => {
    db.exec('CREATE TABLE IF NOT EXISTS groundhog_calls(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, call_key TEXT)')
    const rows = db.all('SELECT call_key FROM groundhog_calls WHERE session_id=? ORDER BY id DESC LIMIT ?', sid, o.repeat - 1)
    db.run('INSERT INTO groundhog_calls(session_id, call_key) VALUES(?,?)', sid, key)
    return rows.map((r) => r.call_key)
  })
  if (recent.length < o.repeat - 1 || recent.some((k) => k !== key)) return null
  return { rule: 'identical_call', key: 'same:' + key, count: o.repeat, usd: 0,
    reason: `groundhog: this is the ${o.repeat}th ${name} call in a row with exactly the same input. ` +
      'The result will be the same. Use the earlier result, or try something different.' }
}

function hook(source: string): void {
  const mode = (process.env.TOKENOMICS_GROUNDHOG ?? 'block').trim().toLowerCase()
  if (mode === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const adapter = getAdapter(source)
    const sid = adapter.sessionId(payload)
    const name = String(first(payload, ['tool_name', 'toolName'], '') || '')
    if (!name) return
    const input = isObj(payload.tool_input) ? payload.tool_input : asDict(first(payload, ['toolArgs', 'toolInput'], {}))
    if (/#\s*groundhog-ok\b/.test(String(input.command ?? ''))) return
    const o = options()
    let loop: Loop | null
    const path = first(payload, ['transcript_path', 'transcriptPath'])
    if (path) loop = detect(trace.parse(String(path), { tail: TAIL_BYTES }), { name, input }, o)
    else if (source === 'copilot') loop = copilotLoop(dbPath, sid, name, input, o)
    else return
    if (!loop) return
    const seen = history(dbPath, sid, loop.key)
    const [, symbol, rate] = currency.current()
    const spent = loop.usd ? ` That loop has cost about ${currency.formatMoney(loop.usd * rate, symbol)} so far.` : ''
    const bypass = name === 'Bash' ? ' (If this really must run again, add `# groundhog-ok` to the command.)' : ''
    let action: string
    let out: Obj | null = null
    if (mode === 'warn') {
      if (seen.warned) return
      action = 'warned'
      out = adapter.notify(loop.reason + spent)
    } else if (!seen.denied || (mode !== 'interrupt' && seen.denied < 2)) {
      action = 'denied'
      out = adapter.denyTool(loop.reason + spent + bypass)
    } else if (mode === 'interrupt' && !seen.interrupted) {
      action = 'interrupted'
      out = adapter.interrupt(`groundhog stopped the turn: the agent kept going round in circles (${loop.rule.replace('_', ' ')}).${spent} ` +
        'Give it a new direction, or tell it to carry on.')
    } else if (!seen.allowed) {
      action = 'allowed'
      out = adapter.notify(`groundhog: let a repeated call through after ${seen.denied} refusals (${loop.rule.replace('_', ' ')}).${spent} ` +
        'If it is stuck, interrupt it and give it a new direction.')
    } else {
      return
    }
    events.log(dbPath, 'groundhog_events', { session_id: sid, source: adapter.name, tool: name, rule: loop.rule, loop_key: loop.key,
      action, detail: loop.usd ? loop.usd.toFixed(4) : null })
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(dbPath, `groundhog\n${errText(e)}`)
  }
}

/** Every loop a finished session got into, as if groundhog had been watching. */
export function replay(t: trace.Trace, o: Options = DEFAULTS): (Loop & { at: number })[] {
  const found = new Map<string, Loop & { at: number }>()
  t.steps.forEach((s, j) => {
    const sub: trace.Trace = { ...t, steps: t.steps.slice(0, j), turns: t.turns.slice(0, s.turn + 1) }
    const loop = detect(sub, { name: s.name, input: s.input }, o)
    if (!loop) return
    const prev = found.get(loop.key)
    if (!prev || loop.count > prev.count) found.set(loop.key, { ...loop, at: prev?.at ?? j })
  })
  return [...found.values()].sort((a, b) => b.usd - a.usd)
}

export function main(args: string[]): number {
  if (args[0] !== 'check') {
    hook(args[0] ?? 'claude-code')
    return 0
  }
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  const loops = replay(trace.parse(p), options())
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ transcript: p, loops }, null, 2) + '\n')
    return 0
  }
  const [, symbol, rate] = currency.current()
  if (!loops.length) {
    process.stdout.write('groundhog: no loops in this session.\n')
    return 0
  }
  process.stdout.write(`groundhog: ${loops.length} loop(s) in this session.\n` + loops.map((l) =>
    `- ${l.rule.replace('_', ' ')} (x${l.count}, ~${currency.formatMoney(l.usd * rate, symbol)}): ${l.reason.replace(/^groundhog: /, '')}`).join('\n') + '\n')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
