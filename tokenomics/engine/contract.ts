/**
 * Task contracts: a price agreed before an agent starts a substantial task. Used by haggle.
 *
 * The estimate is built bottom-up from how this task is likely to run, learnt from your own
 * ledger where there is history:
 *
 *   turns        typical requests per task in your sessions, scaled by how complex the prompt is
 *   input        every request re-reads the context (cache reads), which grows as work piles up
 *   tools        what each turn adds to the context (tool results, file contents): cache writes
 *   output       what the model writes per turn
 *
 * The range is the same sum with half and twice the turns. Once contracts have finished, the
 * estimate is calibrated by how far off earlier ones were (median actual / estimate).
 */
import { now, today } from '../util.ts'
import type { Db, Row } from './db.ts'
import * as ledger from './ledger.ts'
import { ratesFor } from './pricing.ts'
import * as trace from './trace.ts'

export const TIER_FACTOR: Record<string, number> = { SIMPLE: 0.35, MEDIUM: 1, COMPLEX: 2.2, REASONING: 3 }
const DEFAULT_TURNS = 10
const DEFAULT_OUTPUT_PER_TURN = 600
const DEFAULT_GROWTH_PER_TURN = 2_000
const FRESH_CONTEXT = 20_000      // system prompt, tools and CLAUDE.md in a brand-new session

export type History = { turns: number, outputPerTurn: number, growthPerTurn: number, calibration: number, samples: number }

export type Estimate = {
  tier: string
  turns: number
  low: number
  mid: number
  high: number
  breakdown: { input: number, tools: number, output: number }     // USD, of mid
  calibration: number
  samples: number
}

export function ensure(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS contracts(
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, day TEXT, tier TEXT,
    est_low REAL, est_mid REAL, est_high REAL, target_usd REAL, cap_usd REAL, explicit INTEGER, transcript TEXT,
    start_offset INTEGER, progress_offset INTEGER, last_msg_id TEXT, last_msg_usd REAL, spent_usd REAL DEFAULT 0,
    status TEXT, warned INTEGER DEFAULT 0, closed_ts TEXT);
  CREATE INDEX IF NOT EXISTS idx_contracts_session ON contracts(session_id, status);`)
}

export function history(db: Db, days = 60): History {
  const rows = ledger.rows(db, ledger.shiftDay(today(), days - 1)).filter((r) => r.turns > 0)
  const h: History = { turns: DEFAULT_TURNS, outputPerTurn: DEFAULT_OUTPUT_PER_TURN, growthPerTurn: DEFAULT_GROWTH_PER_TURN,
    calibration: 1, samples: rows.length }
  if (rows.length >= 3) {
    h.turns = Math.max(3, Math.round(ledger.median(rows.map((r) => r.turns / Math.max(1, r.prompts)))))
    const turns = rows.reduce((a, r) => a + r.turns, 0)
    h.outputPerTurn = Math.round(rows.reduce((a, r) => a + r.output_tokens, 0) / turns)
    h.growthPerTurn = Math.max(300, Math.round(ledger.median(rows.map((r) => Math.max(0, r.peak_ctx - FRESH_CONTEXT) / r.turns))))
  }
  ensure(db)
  const done = db.all("SELECT est_mid, spent_usd FROM contracts WHERE status='closed' AND est_mid > 0 AND spent_usd > 0 ORDER BY id DESC LIMIT 30")
  if (done.length >= 3) h.calibration = Math.min(3, Math.max(0.5, ledger.median(done.map((r) => r.spent_usd / r.est_mid))))
  return h
}

function cost(turns: number, ctx0: number, model: string, h: History): { input: number, tools: number, output: number } {
  const r = ratesFor(model)
  const g = h.growthPerTurn
  return {
    input: (turns * ctx0 + g * turns * (turns - 1) / 2) * r.cache_read / 1e6,
    tools: g * turns * r.cache_write_5m / 1e6,
    output: h.outputPerTurn * turns * r.output / 1e6,
  }
}

const sum = (c: { input: number, tools: number, output: number }) => c.input + c.tools + c.output

export function estimate(tier: string, contextTokens: number, model: string, h: History): Estimate {
  const turns = Math.max(2, Math.round(h.turns * (TIER_FACTOR[tier] ?? 1)))
  const ctx0 = contextTokens > 0 ? contextTokens : FRESH_CONTEXT
  const mid = cost(turns, ctx0, model, h)
  const k = h.calibration
  return {
    tier, turns, calibration: k, samples: h.samples,
    low: sum(cost(Math.max(1, Math.round(turns / 2)), ctx0, model, h)) * k,
    mid: sum(mid) * k,
    high: sum(cost(turns * 2, ctx0, model, h)) * k,
    breakdown: { input: mid.input * k, tools: mid.tools * k, output: mid.output * k },
  }
}

export function open(db: Db, sid: string): Row | undefined {
  ensure(db)
  return db.get("SELECT * FROM contracts WHERE session_id=? AND status IN ('open','capped') ORDER BY id DESC LIMIT 1", sid)
}

/** Count spend since the contract started: reads only the transcript written since last time. */
export function progress(db: Db, c: Row): number {
  if (!c.transcript) return Number(c.spent_usd) || 0
  let t: trace.Trace
  try {
    t = trace.parse(String(c.transcript), { from: Number(c.progress_offset) || 0 })
  } catch {
    return Number(c.spent_usd) || 0
  }
  let spent = Number(c.spent_usd) || 0
  let lastId = c.last_msg_id as string | null
  let lastUsd = Number(c.last_msg_usd) || 0
  for (const turn of t.turns) {
    if (turn.id === lastId) {
      spent += turn.costUsd - lastUsd        // the same message, streamed across the boundary
    } else {
      spent += turn.costUsd
    }
    lastId = turn.id
    lastUsd = turn.costUsd
  }
  db.run('UPDATE contracts SET spent_usd=?, progress_offset=?, last_msg_id=?, last_msg_usd=? WHERE id=?',
    spent, t.bytes, lastId, lastUsd, c.id)
  c.spent_usd = spent
  return spent
}

export function start(db: Db, sid: string, e: Estimate, targetUsd: number, capUsd: number, explicit: boolean,
  transcript: string | null, offset: number): number {
  ensure(db)
  close(db, sid)
  db.run(`INSERT INTO contracts(session_id,ts,day,tier,est_low,est_mid,est_high,target_usd,cap_usd,explicit,transcript,
            start_offset,progress_offset,spent_usd,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,'open')`,
  sid, now(), today(), e.tier, e.low, e.mid, e.high, targetUsd, capUsd, explicit ? 1 : 0, transcript, offset, offset)
  return Number(db.get('SELECT last_insert_rowid() AS id')!.id)
}

/** Settle and close the session's open contract, if any. */
export function close(db: Db, sid: string, status = 'closed'): Row | null {
  const c = open(db, sid)
  if (!c) return null
  progress(db, c)
  db.run('UPDATE contracts SET status=?, closed_ts=? WHERE id=?', status, now(), c.id)
  return { ...c, status }
}
