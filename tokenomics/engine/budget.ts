/**
 * Spending limits: a daily and a per-session budget. Platform-independent.
 *
 * Limits are amounts in the display currency (GBP by default; USD or EUR via TOKENOMICS_CURRENCY,
 * see engine/currency.ts). Spend is stored in USD and converted at the configured rate.
 *
 * Spend comes from the usage store (cost_usd per session, cost_events per day), which spendlens
 * updates at every turn end, so the figure is at most one turn behind. Only token-billed
 * platforms have a cost; Copilot (premium requests) never counts towards a budget.
 *
 * At `warn` percent of a limit the user gets one notice per session per day. At 100% the next
 * prompt is paused once (mode "block") with three ways on: send the same prompt again, prefix it
 * with "over-budget:", or raise the limit. After an override the session is not paused again for
 * that limit that day.
 */
import { now, sha1, today } from '../util.ts'
import * as currency from './currency.ts'
import type { Db } from './db.ts'
import * as store from './store.ts'

const BYPASS_RE = /^\s*over-budget:\s*/i

export type Limits = {
  daily: number | null          // in the display currency
  session: number | null
  warnPct: number
  mode: string                  // block | warn | off
}

export function limits(l: Partial<Limits> = {}): Limits {
  return { daily: null, session: null, warnPct: 80, mode: 'block', ...l }
}

export function active(l: Limits): boolean {
  return l.mode !== 'off' && Boolean(l.daily || l.session)
}

function num(name: string): number | null {
  const raw = (process.env[name] ?? '').trim().replace(/^[£€$]+/, '').replaceAll(',', '')
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v > 0 ? v : null
}

export function loadLimits(): Limits {
  const mode = (process.env.TOKENOMICS_BUDGET_MODE ?? 'block').trim().toLowerCase()
  return limits({ daily: num('TOKENOMICS_BUDGET_DAILY'), session: num('TOKENOMICS_BUDGET_SESSION'),
    warnPct: num('TOKENOMICS_BUDGET_WARN') ?? 80, mode: ['block', 'warn', 'off'].includes(mode) ? mode : 'block' })
}

export type Decision = { action: 'warned' | 'blocked', message: string }

function ensure(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS budget_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, day TEXT, kind TEXT,
    action TEXT, spent REAL, limit_amount REAL, currency TEXT, digest TEXT)`)
  const have = db.columns('budget_events')
  for (const [col, typ] of [['spent', 'REAL'], ['limit_amount', 'REAL'], ['currency', 'TEXT']]) {
    if (!have.has(col)) db.exec(`ALTER TABLE budget_events ADD COLUMN ${col} ${typ}`)   // tables from before currencies were configurable
  }
}

function log(db: Db, sid: string, kind: string, action: string, spent: number, limit: number, code: string,
  digest: string | null = null): void {
  db.run('INSERT INTO budget_events(session_id,ts,day,kind,action,spent,limit_amount,currency,digest) VALUES(?,?,?,?,?,?,?,?,?)',
    sid, now(), today(), kind, action, spent, limit, code, digest)
}

function seen(db: Db, sid: string, kind: string, actions: string[]): { action: string, digest: string | null }[] {
  return db.all(`SELECT action, digest FROM budget_events WHERE session_id=? AND day=? AND kind=? ` +
    `AND action IN (${actions.map(() => '?').join(',')}) ORDER BY id DESC`, sid, today(), kind, ...actions) as any
}

/** Decide what to do with this prompt. Writes budget_events. */
export function check(db: Db, sid: string, prompt: string, l: Limits): Decision | null {
  if (!active(l)) return null
  ensure(db)
  const [code, symbol, rate] = currency.current()
  const money = (v: number) => currency.formatMoney(v, symbol)
  const spent: Record<string, number> = {
    session: (store.sessionCost(db, sid) ?? 0) * rate,
    daily: store.dayCostUsd(db) * rate,
  }
  const caps: Record<string, number | null> = { session: l.session, daily: l.daily }
  const digest = sha1(prompt.trim())
  const bypass = BYPASS_RE.test(prompt)
  for (const kind of ['daily', 'session']) {
    const cap = caps[kind]
    if (!cap) continue
    const used = spent[kind]
    const what = kind === 'daily' ? "today's" : "this session's"
    if (used >= cap) {
      const history = seen(db, sid, kind, ['blocked', 'overridden', 'bypassed', 'over'])
      if (history.some((h) => h.action === 'overridden' || h.action === 'bypassed')) continue   // already chose to carry on today
      if (bypass) {
        log(db, sid, kind, 'bypassed', used, cap, code)
        continue
      }
      if (history.length && history[0].action === 'blocked' && history[0].digest === digest) {
        log(db, sid, kind, 'overridden', used, cap, code)
        continue
      }
      const msg = `tokenomics budget: ${what} spend is ${money(used)}, over the ${money(cap)} limit. ` +
        "To carry on, send the same prompt again or start it with 'over-budget:'. " +
        'Cheaper ways on: /compact, a smaller model (/model), or a fresh session.'
      if (l.mode === 'warn') {
        if (history.length) continue
        log(db, sid, kind, 'over', used, cap, code)
        return { action: 'warned', message: msg.replace(" To carry on, send the same prompt again or start it with 'over-budget:'.", '') }
      }
      log(db, sid, kind, 'blocked', used, cap, code, digest)
      return { action: 'blocked', message: msg }
    }
    if (used >= cap * l.warnPct / 100 && !seen(db, sid, kind, ['warned']).length) {
      log(db, sid, kind, 'warned', used, cap, code)
      return { action: 'warned', message: `tokenomics budget: ${what} spend is ${money(used)}, ` +
        `${(used / cap * 100).toFixed(0)}% of the ${money(cap)} limit.` }
    }
  }
  return null
}
