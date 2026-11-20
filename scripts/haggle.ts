#!/usr/bin/env node
/**
 * tokenomics / haggle: agree a price before the work starts. Every substantial task gets a quote
 * (input, output and tool costs, from your own history) and a contract: a target and a maximum.
 * No more finding out afterwards that a simple change cost £5.
 *
 * Hooks (Claude Code):
 *   UserPromptSubmit  haggle.ts prompt   quote a substantial prompt and open a contract
 *   PreToolUse        haggle.ts guard    track spend as the task runs; tell you when it passes the
 *                                        estimate; at the cap, stop the agent and ask for approval
 *   Stop              haggle.ts settle   bring the contract's spend up to date
 *   SessionEnd        haggle.ts close    close it (its accuracy calibrates later estimates)
 *
 * In a prompt:
 *   haggle £2: <task>       agree a price yourself: £2 is a hard cap the agent must ask to exceed
 *   haggle +£1  /  approve  approve more spend for the current task (approve alone: half the cap again)
 *   haggle off              drop the current contract
 *
 * Commands:
 *   haggle.ts quote "task" [--price 2] [--context TOKENS] [--model M]   is this task worth £2?
 *   haggle.ts status [--json]                                           recent contracts: quoted vs actual
 *
 * Env:
 *   TOKENOMICS_HAGGLE         quote (default: quotes, warns, enforces only prices you set) | strict
 *                             (enforce every quote's cap) | off
 *   TOKENOMICS_HAGGLE_MIN     smallest estimate worth a contract, in your currency (default 0.50)
 *   TOKENOMICS_HAGGLE_CAP_X   cap = this x the estimate (default 2)
 * Hooks always exit 0; a crash never blocks anything (errors go to <db>.err).
 */
import { score as complexity } from './pennywise.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import * as contract from '../tokenomics/engine/contract.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import { withDb, type Db, type Row } from '../tokenomics/engine/db.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { argValue, errText, first, isMain, logErr, readPayload, readStdin, type Obj } from '../tokenomics/util.ts'

const PRICE_RE = /^\s*(?:haggle|cap|budget)\s*([£$€])?\s*(\d+(?:\.\d+)?)\s*([£$€])?\s*:/i
const RAISE_RE = /^\s*(?:haggle\s*\+|(?:haggle\s+)?approve\b)\s*([£$€])?\s*(\d+(?:\.\d+)?)?/i
const OFF_RE = /^\s*haggle\s*:?\s*(off|cancel|stop)\b/i
const FOLLOW_UP_RE = /^\s*(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks|thank you|continue|go( ahead| on)?|do it|carry on|sounds good|lgtm)\b/i
const TAIL = 512 * 1024
const BIG = ['COMPLEX', 'REASONING']

const mode = () => (process.env.TOKENOMICS_HAGGLE ?? 'quote').trim().toLowerCase()

function envNum(name: string, d: number): number {
  const v = Number((process.env[name] ?? '').replace(/^[£$€]/, ''))
  return Number.isFinite(v) && v > 0 ? v : d
}

type Ctx = { ctx: number, model: string, offset: number }

/** Context size and model right now, and where the transcript ends (spend is counted from there). */
function where(path: string | null): Ctx {
  if (!path) return { ctx: 0, model: 'claude-sonnet-5-5', offset: 0 }
  try {
    const t = trace.parse(path, { tail: TAIL })
    const last = t.turns[t.turns.length - 1]
    return { ctx: last?.ctx ?? 0, model: trace.lastModel(t) ?? 'claude-sonnet-5-5', offset: t.bytes }
  } catch {
    return { ctx: 0, model: 'claude-sonnet-5-5', offset: 0 }
  }
}

export function quote(db: Db, prompt: string, c: Ctx): contract.Estimate {
  const tier = complexity(prompt, c.ctx).tier
  return contract.estimate(tier, c.ctx, c.model, contract.history(db))
}

const merge = (...xs: (Obj | null)[]): Obj | null => {
  const out: Obj = {}
  for (const x of xs) if (x) Object.assign(out, x)
  return Object.keys(out).length ? out : null
}

function onPrompt(source: string): void {
  if (mode() === 'off' || source === 'copilot') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const adapter = getAdapter(source)
    const sid = adapter.sessionId(payload)
    const prompt = String(first(payload, ['prompt', 'userPrompt'], ''))
    if (!prompt.trim()) return
    const path = first(payload, ['transcript_path', 'transcriptPath'], null)
    const [, symbol, rate] = currency.current()
    const money = (usd: number) => currency.formatMoney(usd * rate, symbol)
    const db = store.connect(dbPath)
    let out: Obj | null = null
    try {
      if (OFF_RE.test(prompt)) {
        const c = contract.close(db, sid, 'cancelled')
        out = adapter.notify(c ? `haggle: contract dropped (it had cost ${money(Number(c.spent_usd) || 0)}).` : 'haggle: no contract to drop.')
        return void emit(out)
      }
      const raise = RAISE_RE.exec(prompt)
      const live = contract.open(db, sid)
      if (raise && live && !PRICE_RE.test(prompt) && (/^\s*haggle/i.test(prompt) || live.status === 'capped')) {
        const spent = contract.progress(db, live)
        const extra = raise[2] ? Number(raise[2]) / rate : Math.max(Number(live.cap_usd), spent) * 0.5
        const cap = Math.max(Number(live.cap_usd), spent) + extra
        db.run("UPDATE contracts SET cap_usd=?, status='open', warned=1 WHERE id=?", cap, live.id)
        out = merge(adapter.notify(`haggle: approved. New cap ${money(cap)} (${money(spent)} spent so far).`),
          adapter.addContext(`The user approved more spend for this task: the cap is now ${money(cap)}. Carry on.`))
        return void emit(out)
      }
      const price = PRICE_RE.exec(prompt)
      const words = prompt.split(/\s+/).filter(Boolean).length
      if (!price && (words < 6 || FOLLOW_UP_RE.test(prompt))) return       // a follow-up: same task, same contract
      const c = where(path ? String(path) : null)
      const e = quote(db, prompt.replace(PRICE_RE, ''), c)
      const minUsd = envNum('TOKENOMICS_HAGGLE_MIN', 0.5) / rate
      if (!price && !BIG.includes(e.tier) && e.mid < minUsd) return
      const explicit = Boolean(price)
      const cap = explicit ? Number(price![2]) / rate : e.mid * envNum('TOKENOMICS_HAGGLE_CAP_X', 2)
      const target = Math.min(e.mid, cap)
      contract.start(db, sid, e, target, cap, explicit, path ? String(path) : null, c.offset)
      const b = e.breakdown
      const range = `${money(e.low)}–${money(e.high)}`
      const hard = explicit || mode() === 'strict'
      let msg = `haggle: ${e.tier.toLowerCase()} task, quoted ${money(e.mid)} (likely ${range}: input ${money(b.input)}, ` +
        `tools ${money(b.tools)}, output ${money(b.output)}). ${hard ? 'Agreed cap' : 'Cap'} ${money(cap)}.`
      if (explicit && e.mid > cap) msg += ` Your price is under the estimate, so expect to be asked to approve more.`
      if (!explicit) msg += ` Set your own price with 'haggle £X: ...'.`
      out = merge(adapter.notify(msg), adapter.addContext(
        `Task contract (tokenomics haggle): this task is estimated at ${money(e.mid)} (range ${range}); ` +
        `${hard ? 'the user has agreed a hard cap of' : 'the cap is'} ${money(cap)}. Work economically: read only what you need, ` +
        'avoid repeating calls, keep tool output small. If it looks like the task will cost more than the cap, stop, report ' +
        'what is done and what is left, and ask the user to approve more.'))
      emit(out)
    } finally {
      db.close()
    }
  } catch (e) {
    logErr(dbPath, `haggle prompt\n${errText(e)}`)
  }
}

function emit(out: Obj | null): void {
  if (out) process.stdout.write(JSON.stringify(out) + '\n')
}

function onGuard(source: string): void {
  if (mode() === 'off' || source === 'copilot') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const adapter = getAdapter(source)
    const sid = adapter.sessionId(payload)
    const out = withDb(dbPath, (db) => {
      if (!db.tables().has('contracts')) return null
      const c = contract.open(db, sid)
      if (!c) return null
      const spent = contract.progress(db, c)
      return decide(db, c, spent, adapter)
    })
    emit(out)
  } catch (e) {
    logErr(dbPath, `haggle guard\n${errText(e)}`)
  }
}

export function decide(db: Db, c: Row, spent: number, adapter: ReturnType<typeof getAdapter>): Obj | null {
  const [, symbol, rate] = currency.current()
  const money = (usd: number) => currency.formatMoney(usd * rate, symbol)
  const cap = Number(c.cap_usd)
  const target = Number(c.target_usd)
  const warned = Number(c.warned) || 0
  const hard = Boolean(c.explicit) || mode() === 'strict'
  if (spent >= cap) {
    if (hard) {
      db.run("UPDATE contracts SET status='capped' WHERE id=?", c.id)
      return adapter.denyTool(`haggle: the agreed cap of ${money(cap)} for this task has been reached (${money(spent)} spent). ` +
        'Stop now and make no more tool calls. Tell the user what is done, what is left and roughly what finishing would cost, ' +
        "and ask them to approve more spend (they reply 'haggle +£X' or 'approve').")
    }
    if (warned & 2) return null
    db.run('UPDATE contracts SET warned=? WHERE id=?', warned | 2, c.id)
    return adapter.notify(`haggle: this task has cost ${money(spent)}, past its ${money(cap)} cap. ` +
      "Interrupt it if it isn't worth more (use 'haggle £X: ...' next time to have the agent stop and ask).")
  }
  if (spent >= target && !(warned & 1)) {
    db.run('UPDATE contracts SET warned=? WHERE id=?', warned | 1, c.id)
    return adapter.notify(`haggle: this task has cost ${money(spent)}, past its ${money(target)} estimate (cap ${money(cap)}).`)
  }
  return null
}

function onSettle(source: string, close: boolean): void {
  if (mode() === 'off' || source === 'copilot') return
  const dbPath = defaultDbPath()
  try {
    const sid = getAdapter(source).sessionId(readPayload())
    withDb(dbPath, (db) => {
      if (!db.tables().has('contracts')) return
      if (close) contract.close(db, sid)
      else {
        const c = contract.open(db, sid)
        if (c) contract.progress(db, c)
      }
    })
  } catch (e) {
    logErr(dbPath, `haggle settle\n${errText(e)}`)
  }
}

function status(args: string[]): number {
  const [code, symbol, rate] = currency.current()
  const rows = withDb(defaultDbPath(), (db) => {
    contract.ensure(db)
    return db.all('SELECT * FROM contracts ORDER BY id DESC LIMIT 20')
  })
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ currency: code, contracts: rows.map((r) => ({ ...r, transcript: undefined })) }, null, 2) + '\n')
    return 0
  }
  if (!rows.length) {
    process.stdout.write('haggle: no contracts yet. Substantial prompts get one automatically.\n')
    return 0
  }
  const m = (usd: number) => currency.formatMoney(usd * rate, symbol)
  process.stdout.write('| When | Tier | Quoted | Cap | Spent | Status |\n|---|---|---:|---:|---:|---|\n' + rows.map((r) =>
    `| ${String(r.ts).slice(0, 16).replace('T', ' ')} | ${r.tier} | ${m(r.est_mid)} | ${m(r.cap_usd)}${r.explicit ? ' (agreed)' : ''} | ` +
    `${m(r.spent_usd || 0)} | ${r.status} |`).join('\n') + '\n')
  return 0
}

function quoteCmd(args: string[]): number {
  const text = args.filter((a, i) => !a.startsWith('--') && !['--price', '--context', '--model'].includes(args[i - 1])).join(' ') || readStdin()
  if (!text.trim()) {
    process.stderr.write('Usage: haggle.ts quote "describe the task" [--price 2] [--context TOKENS] [--model M]\n')
    return 2
  }
  const [code, symbol, rate] = currency.current()
  const m = (usd: number) => currency.formatMoney(usd * rate, symbol)
  const c: Ctx = { ctx: Number(argValue(args, '--context') ?? 0) || 0, model: argValue(args, '--model') ?? 'claude-sonnet-5-5', offset: 0 }
  const e = withDb(defaultDbPath(), (db) => quote(db, text, c))
  const price = Number(argValue(args, '--price')?.replace(/^[£$€]/, '') ?? NaN)
  const out: Obj = { currency: code, ...e, low: e.low * rate, mid: e.mid * rate, high: e.high * rate, model: c.model,
    breakdown: Object.fromEntries(Object.entries(e.breakdown).map(([k, v]) => [k, v * rate])) }
  let verdict = ''
  if (Number.isFinite(price)) {
    out.price = price
    verdict = price >= e.high * rate ? `Yes: ${m(price / rate)} covers even a long run (up to ${m(e.high)}).`
      : price >= e.mid * rate ? `Probably: ${m(price / rate)} covers the likely cost (${m(e.mid)}), but a long run could reach ${m(e.high)}.`
        : price >= e.low * rate ? `Tight: ${m(price / rate)} only covers it if it goes well; expect about ${m(e.mid)}.`
          : `Unlikely: expect at least ${m(e.low)}, most likely ${m(e.mid)}.`
    out.verdict = verdict
  }
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
    return 0
  }
  const b = e.breakdown
  process.stdout.write(`Quote (${e.tier.toLowerCase()} task, ~${e.turns} turns on ${c.model}): ${m(e.mid)}, likely ${m(e.low)}–${m(e.high)}.\n` +
    `  input ${m(b.input)} · tools ${m(b.tools)} · output ${m(b.output)}` +
    `${e.samples ? ` · from ${e.samples} of your sessions` : ' · no history yet, using defaults'}` +
    `${e.calibration !== 1 ? ` · calibrated x${e.calibration.toFixed(2)}` : ''}\n` + (verdict ? verdict + '\n' : ''))
  return 0
}

export function main(argv: string[]): number {
  const [cmd = '', ...args] = argv
  const source = args[0] ?? 'claude-code'
  if (cmd === 'prompt') onPrompt(source)
  else if (cmd === 'guard') onGuard(source)
  else if (cmd === 'settle') onSettle(source, false)
  else if (cmd === 'close') onSettle(source, true)
  else if (cmd === 'quote') return quoteCmd(args)
  else if (cmd === 'status') return status(args)
  else {
    process.stderr.write('Commands: quote, status (hooks: prompt, guard, settle, close)\n')
    return 2
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
