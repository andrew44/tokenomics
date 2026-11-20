/**
 * Usage store: one SQLite schema for every platform (default ~/.tokenomics/spendlens.db).
 *
 * Rows from Claude Code and Copilot sit side by side and are comparable on label, prompts
 * and session counts. Billing stays platform-specific: `billing_model` says what the
 * platform charges for, and token columns are NULL (not 0) where the platform reports none.
 */
import { now, today } from '../util.ts'
import type { Classification } from './classifier.ts'
import { Db, type Row } from './db.ts'
import { totalTokens, type TokenUsage } from './evidence.ts'

export { Db } from './db.ts'

type LabelFn = (o: number, c: number) => string

export const SESSION_COLUMNS: [string, string][] = [
  ['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'],
  ['cache_creation_tokens', 'INTEGER'], ['cache_read_tokens', 'INTEGER'],
  ['total_tokens', 'INTEGER'], ['skills', 'TEXT'],
  ['skill_opex', 'INTEGER'], ['skill_capex', 'INTEGER'], ['skill_detail', 'TEXT'],
  ['label_source', 'TEXT'], ['llm_label', 'TEXT'], ['llm_confidence', 'REAL'],
  ['llm_reason', 'TEXT'], ['llm_model', 'TEXT'], ['llm_input_hash', 'TEXT'],
  // added with the shared engine (v1.1)
  ['billing_model', 'TEXT'],        // anthropic_tokens | copilot_premium_requests | unknown
  ['usage_status', 'TEXT'],         // reported | unavailable
  ['evidence', 'TEXT'],             // transcript | hook-events
  // added with budget / spend-report (v1.2)
  ['cost_usd', 'REAL'],             // NULL unless the platform bills tokens and reports usage
  ['model', 'TEXT'],                // last model seen
]

export function connect(dbPath: string): Db {
  const db = new Db(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions(
      session_id TEXT PRIMARY KEY, source TEXT, cwd TEXT, label TEXT,
      opex_score INTEGER, capex_score INTEGER, prompt_count INTEGER DEFAULT 0,
      first_seen TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS prompt_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
      opex_score INTEGER, capex_score INTEGER, label TEXT, excerpt TEXT);
    CREATE INDEX IF NOT EXISTS idx_pe_session ON prompt_events(session_id);
    CREATE TABLE IF NOT EXISTS tool_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
      tool TEXT, kind TEXT, skill TEXT, opex_score INTEGER, capex_score INTEGER);
    CREATE INDEX IF NOT EXISTS idx_te_session ON tool_events(session_id);
    CREATE TABLE IF NOT EXISTS cost_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, day TEXT, usd REAL);
    CREATE INDEX IF NOT EXISTS idx_ce_day ON cost_events(day);
  `)
  const have = db.columns('sessions')
  for (const [col, typ] of SESSION_COLUMNS) {
    if (!have.has(col)) db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${typ}`)
  }
  return db
}

/** Accumulate (replace=false) or overwrite (replace=true) keyword scores. An LLM label,
 *  once set, is kept: later prompts never overwrite it. */
export function upsert(db: Db, sid: string, source: string, cwd: string | null, o: number, c: number,
  prompts: number, replace: boolean, labelFor: LabelFn): void {
  const row = db.get('SELECT opex_score, capex_score, prompt_count FROM sessions WHERE session_id=?', sid)
  if (row && !replace) {
    o += row.opex_score || 0
    c += row.capex_score || 0
    prompts += row.prompt_count || 0
  } else if (row && replace) {
    prompts = Math.max(prompts, row.prompt_count || 0)
  }
  const ts = now()
  db.run(`INSERT INTO sessions(session_id,source,cwd,label,opex_score,capex_score,prompt_count,first_seen,updated_at,label_source)
          VALUES(?,?,?,?,?,?,?,?,?,'keywords')
          ON CONFLICT(session_id) DO UPDATE SET
            label=COALESCE(sessions.llm_label, excluded.label),
            label_source=CASE WHEN sessions.llm_label IS NULL THEN 'keywords' ELSE sessions.label_source END,
            opex_score=excluded.opex_score, capex_score=excluded.capex_score,
            prompt_count=excluded.prompt_count, updated_at=excluded.updated_at`,
  sid, source, cwd, labelFor(o, c), o, c, prompts, ts, ts)
}

export function addPromptEvent(db: Db, sid: string, o: number, c: number, label: string, excerpt: string | null): void {
  db.run('INSERT INTO prompt_events(session_id,ts,opex_score,capex_score,label,excerpt) VALUES(?,?,?,?,?,?)',
    sid, now(), o, c, label, excerpt)
}

export function addToolEvent(db: Db, sid: string, tool: string, kind: string, skill: string, o: number, c: number): void {
  db.run('INSERT INTO tool_events(session_id,ts,tool,kind,skill,opex_score,capex_score) VALUES(?,?,?,?,?,?,?)',
    sid, now(), tool, kind, skill || null, o, c)
}

export function promptTotals(db: Db, sid: string): [number, number, number] {
  const r = db.get('SELECT COALESCE(SUM(opex_score),0) AS o, COALESCE(SUM(capex_score),0) AS c, COUNT(*) AS n ' +
    'FROM prompt_events WHERE session_id=?', sid)!
  return [Number(r.o), Number(r.c), Number(r.n)]
}

export function promptExcerpts(db: Db, sid: string, limit = 5): string[] {
  return db.all('SELECT excerpt FROM prompt_events WHERE session_id=? AND excerpt IS NOT NULL ORDER BY id LIMIT ?',
    sid, limit).map((r) => String(r.excerpt))
}

export type ToolRow = { tool: string, kind: string, skill: string | null, opex_score: number, capex_score: number }

export function toolRows(db: Db, sid: string): ToolRow[] {
  return db.all('SELECT tool, kind, skill, opex_score, capex_score FROM tool_events WHERE session_id=? ORDER BY id',
    sid) as ToolRow[]
}

export function writeDetails(db: Db, sid: string, cls: Classification, usage: TokenUsage | null,
  billingModel: string, evidence: string): void {
  const tok = usage === null
    ? [null, null, null, null, null]
    : [usage.inputTokens, usage.outputTokens, usage.cacheCreationTokens, usage.cacheReadTokens, totalTokens(usage)]
  const status = usage === null ? 'unavailable' : 'reported'
  db.run(`UPDATE sessions SET input_tokens=?, output_tokens=?, cache_creation_tokens=?,
          cache_read_tokens=?, total_tokens=?, skills=?, skill_opex=?, skill_capex=?,
          skill_detail=?, billing_model=?, usage_status=?, evidence=? WHERE session_id=?`,
  ...tok, JSON.stringify(cls.skills), cls.skillOpex, cls.skillCapex, JSON.stringify(cls.skillDetail),
  billingModel, status, evidence, sid)
}

/** Store the session's cost so far and log the increase since the last call as a dated
 *  cost event, so spend can be summed per day even for sessions that span several days. */
export function setCost(db: Db, sid: string, usd: number | null, model: string | null): void {
  if (usd === null) return
  const row = db.get('SELECT cost_usd FROM sessions WHERE session_id=?', sid)
  const delta = usd - (row ? row.cost_usd || 0 : 0)
  if (delta > 1e-9) db.run('INSERT INTO cost_events(session_id,ts,day,usd) VALUES(?,?,?,?)', sid, now(), today(), delta)
  db.run('UPDATE sessions SET cost_usd=?, model=COALESCE(?, model) WHERE session_id=?', usd, model, sid)
}

export function dayCostUsd(db: Db, day?: string): number {
  const r = db.get('SELECT COALESCE(SUM(usd),0) AS usd FROM cost_events WHERE day=?', day || today())!
  return Number(r.usd)
}

export function sessionCost(db: Db, sid: string): number | null {
  const r = db.get('SELECT cost_usd FROM sessions WHERE session_id=?', sid)
  return !r || r.cost_usd === null ? null : Number(r.cost_usd)
}

export function setBilling(db: Db, sid: string, billingModel: string): void {
  db.run('UPDATE sessions SET billing_model=COALESCE(billing_model, ?) WHERE session_id=?', billingModel, sid)
}

export function llmState(db: Db, sid: string): Row | undefined {
  return db.get('SELECT llm_input_hash, llm_label FROM sessions WHERE session_id=?', sid)
}

export type LlmResult = { label: string, confidence: number | null, reason: string, model: string }

export function writeLlm(db: Db, sid: string, res: LlmResult, h: string): void {
  db.run(`UPDATE sessions SET label=?, label_source='llm', llm_label=?, llm_confidence=?,
          llm_reason=?, llm_model=?, llm_input_hash=? WHERE session_id=?`,
  res.label, res.label, res.confidence, res.reason, res.model, h, sid)
}

export function refreshLabel(db: Db, sid: string, labelFor: LabelFn): void {
  const row = db.get('SELECT opex_score, capex_score FROM sessions WHERE session_id=?', sid)
  if (row) {
    db.run('UPDATE sessions SET label=COALESCE(llm_label, ?), updated_at=? WHERE session_id=?',
      labelFor(row.opex_score || 0, row.capex_score || 0), now(), sid)
  }
}
