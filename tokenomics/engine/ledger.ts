/**
 * Ledger: one row per session describing what it cost and what it produced.
 *
 * Written at each turn end by bangforbuck (replacing the session's row), read by bangforbuck's
 * value report, waistline (cost regression), and haggle (estimates from your own history).
 * Rows hold numbers and tool names only: never prompt text, file contents or commands.
 */
import { now, today, type Obj } from '../util.ts'
import type { Db } from './db.ts'
import { outcomesOf, primary, total, type Outcomes } from './outcomes.ts'
import { approxTokens, costUsd, lastModel, peakContext, type Trace } from './trace.ts'

export type ToolStat = { calls: number, result_tokens: number, errors: number }

export type LedgerRow = {
  session_id: string
  day: string
  cwd: string | null
  model: string | null
  label: string | null
  cost_usd: number
  turns: number
  tool_calls: number
  peak_ctx: number
  avg_ctx: number
  input_tokens: number         // fresh input + cache writes + cache reads, summed over requests
  output_tokens: number
  prompts: number
  tools: Record<string, ToolStat>
  outcomes: Outcomes
  primary: string
  // attribution and outcome status (added with the shared services; filled by services/value.ts)
  project?: string | null
  developer?: string | null
  provider?: string | null
  category?: string | null
  status?: string | null           // succeeded | failed | discarded | abandoned | unverified | no_change
  status_reason?: string | null
  last_ts?: number | null          // epoch seconds of the last request
  usage?: { input: number, cache_write: number, cache_read: number, output: number } | null
  agents?: Obj | null              // agent -> { turns, cost_usd }
  models?: Obj | null              // model -> { provider, turns, cost_usd, latency_s, api_errors, tokens }
  dead_usd?: number | null
  dead?: Obj[] | null              // [{ kind, usd, detail }]
  commits?: string[] | null
  scope_usd?: number | null        // spend on changes outside what was asked (blinkers)
}

/** Columns added after the first ledger: [name, type, JSON?]. */
export const EXTRA_COLUMNS: [string, string, boolean][] = [
  ['project', 'TEXT', false], ['developer', 'TEXT', false], ['provider', 'TEXT', false], ['category', 'TEXT', false],
  ['status', 'TEXT', false], ['status_reason', 'TEXT', false], ['last_ts', 'REAL', false], ['usage', 'TEXT', true],
  ['agents', 'TEXT', true], ['models', 'TEXT', true], ['dead_usd', 'REAL', false], ['dead', 'TEXT', true], ['commits', 'TEXT', true],
  ['scope_usd', 'REAL', false],
]

export function ensure(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger(
      session_id TEXT PRIMARY KEY, ts TEXT, day TEXT, cwd TEXT, model TEXT, label TEXT, cost_usd REAL,
      turns INTEGER, tool_calls INTEGER, peak_ctx INTEGER, avg_ctx INTEGER, input_tokens INTEGER,
      output_tokens INTEGER, prompts INTEGER, tools TEXT, outcomes TEXT, primary_outcome TEXT);
    CREATE INDEX IF NOT EXISTS idx_ledger_day ON ledger(day);
    CREATE TABLE IF NOT EXISTS outcome_marks(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, kind TEXT, note TEXT);`)
  const have = db.columns('ledger')
  for (const [col, typ] of EXTRA_COLUMNS) if (!have.has(col)) db.exec(`ALTER TABLE ledger ADD COLUMN ${col} ${typ}`)
}

const dayOf = (ts: number | null) => (ts ? today(new Date(ts * 1000)) : today())

export function summarise(t: Trace, sessionId: string, label: string | null = null): LedgerRow {
  const tools: Record<string, ToolStat> = {}
  for (const s of t.steps) {
    const st = tools[s.name] ??= { calls: 0, result_tokens: 0, errors: 0 }
    st.calls += 1
    st.result_tokens += approxTokens(s.resultChars)
    if (s.isError) st.errors += 1
  }
  const outcomes = outcomesOf(t)
  const turns = t.turns.length
  const lastTs = [...t.turns].reverse().find((x) => x.ts)?.ts ?? null
  return {
    session_id: sessionId, day: dayOf(lastTs), cwd: t.cwd, model: lastModel(t), label,
    cost_usd: costUsd(t), turns, tool_calls: t.steps.length, peak_ctx: peakContext(t),
    avg_ctx: turns ? Math.round(t.turns.reduce((a, x) => a + x.ctx, 0) / turns) : 0,
    input_tokens: t.turns.reduce((a, x) => a + x.ctx, 0),
    output_tokens: t.turns.reduce((a, x) => a + x.usage.outputTokens, 0),
    prompts: t.prompts.length, tools, outcomes, primary: primary(outcomes),
  }
}

export function record(db: Db, r: LedgerRow): void {
  ensure(db)
  db.run(`INSERT INTO ledger(session_id,ts,day,cwd,model,label,cost_usd,turns,tool_calls,peak_ctx,avg_ctx,input_tokens,
            output_tokens,prompts,tools,outcomes,primary_outcome) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(session_id) DO UPDATE SET ts=excluded.ts, day=excluded.day, cwd=excluded.cwd,
            model=excluded.model, label=COALESCE(excluded.label, ledger.label), cost_usd=excluded.cost_usd,
            turns=excluded.turns, tool_calls=excluded.tool_calls, peak_ctx=excluded.peak_ctx, avg_ctx=excluded.avg_ctx,
            input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, prompts=excluded.prompts,
            tools=excluded.tools, outcomes=excluded.outcomes, primary_outcome=excluded.primary_outcome`,
  r.session_id, now(), r.day, r.cwd, r.model, r.label, r.cost_usd, r.turns, r.tool_calls, r.peak_ctx, r.avg_ctx,
  r.input_tokens, r.output_tokens, r.prompts, JSON.stringify(r.tools), JSON.stringify(r.outcomes), r.primary)
  const extra = EXTRA_COLUMNS.filter(([col]) => (r as Obj)[col] !== undefined)
  if (extra.length) {
    db.run(`UPDATE ledger SET ${extra.map(([c]) => `${c}=?`).join(', ')} WHERE session_id=?`,
      ...extra.map(([c, , json]) => (json ? JSON.stringify((r as Obj)[c]) : (r as Obj)[c])), r.session_id)
  }
}

export function mark(db: Db, sessionId: string, kind: string, note: string | null): void {
  ensure(db)
  db.run('INSERT INTO outcome_marks(session_id,ts,kind,note) VALUES(?,?,?,?)', sessionId, now(), kind, note)
}

const parseAny = (s: unknown): any => {
  try {
    return JSON.parse(String(s))
  } catch {
    return null
  }
}

const parseJson = (s: unknown): Obj => {
  try {
    const v = JSON.parse(String(s ?? '{}'))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

/** Marks that set a session's status rather than add an outcome (deadwood mark / bangforbuck mark). */
export const STATUS_MARKS: Record<string, string> = {
  accepted: 'succeeded', succeeded: 'succeeded', rejected: 'discarded', discarded: 'discarded', abandoned: 'abandoned', failed: 'failed',
}

/** Ledger rows with day in [since, until] (inclusive; null = open), hand-marked outcomes merged in. */
export function rows(db: Db, since: string | null, until: string | null = null): LedgerRow[] {
  if (!db.tables().has('ledger')) return []
  const marks = new Map<string, Record<string, number>>()
  if (db.tables().has('outcome_marks')) {
    for (const m of db.all('SELECT session_id, kind, COUNT(*) AS n, MAX(id) AS last FROM outcome_marks GROUP BY session_id, kind ORDER BY last')) {
      const o = marks.get(m.session_id) ?? {}
      o[m.kind] = Number(m.n)
      marks.set(m.session_id, o)
    }
  }
  return db.all('SELECT * FROM ledger WHERE day >= ? AND day <= ? ORDER BY day, ts', since ?? '0000-00-00', until ?? '9999-99-99')
    .map((r) => {
      const outcomes: Record<string, number> = parseJson(r.outcomes)
      let marked: string | null = null
      for (const [k, n] of Object.entries(marks.get(r.session_id) ?? {})) {
        if (Object.hasOwn(STATUS_MARKS, k)) marked = STATUS_MARKS[k]
        else outcomes[k] = (outcomes[k] ?? 0) + n
      }
      const row = {
        session_id: r.session_id, day: r.day, cwd: r.cwd, model: r.model, label: r.label, cost_usd: Number(r.cost_usd) || 0,
        turns: Number(r.turns) || 0, tool_calls: Number(r.tool_calls) || 0, peak_ctx: Number(r.peak_ctx) || 0,
        avg_ctx: Number(r.avg_ctx) || 0, input_tokens: Number(r.input_tokens) || 0, output_tokens: Number(r.output_tokens) || 0,
        prompts: Number(r.prompts) || 0, tools: parseJson(r.tools), outcomes,
        primary: total(outcomes) ? primary(outcomes) : 'none',
        ...Object.fromEntries(EXTRA_COLUMNS.map(([c, , json]) => [c, r[c] === undefined || r[c] === null ? null : json ? parseAny(r[c]) : r[c]])),
      } as LedgerRow
      if (marked && marked !== row.status) {
        row.status_reason = `marked ${marked} by hand`
        row.status = marked
        row.dead_usd = ['failed', 'discarded', 'abandoned'].includes(marked) ? row.cost_usd : marked === 'succeeded' ? 0 : row.dead_usd
      }
      return row
    })
}

// ---- small statistics used by the reports ---------------------------------------------------

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (pos - lo)
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

/** Local day `n` days before `day` (YYYY-MM-DD). */
export function shiftDay(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return today(new Date(y, m - 1, d - n))
}
