/**
 * The value pipeline: one session in, one enriched ledger row out. All five engines in one pass.
 *
 *   TelemetryEngine   project, developer, cost by agent / subagent and by model, provider, latency
 *   CostEngine        per-request cost at each model's rates (in the trace)
 *   OutcomeEngine     outcomes, status from observable signals, task category
 *   InsightsEngine    dead work and out-of-scope spend
 *
 * bangforbuck calls this at every turn end (Claude Code), and `ingest` for old transcripts. Copilot
 * has no transcript: its sessions are judged from telemetry events instead (statusFromEvents).
 */
import { basename } from 'node:path'

import type { Db } from '../engine/db.ts'
import * as ledger from '../engine/ledger.ts'
import * as store from '../engine/store.ts'
import * as trace from '../engine/trace.ts'
import { provider } from './cost.ts'
import { deadWork, scopeReview } from './insights.ts'
import { activityFromEvents, category, judge, signals, status, type Verdict } from './outcome.ts'
import { breakdown, developer, events, project } from './telemetry.ts'

/** A full ledger row for a parsed transcript. */
export function enrich(t: trace.Trace, sessionId: string, label: string | null = null): ledger.LedgerRow {
  const row = ledger.summarise(t, sessionId, label)
  const v = judge(t)
  const dead = deadWork(t, v)
  const { agents, models } = breakdown(t)
  const lastTs = [...t.turns].reverse().find((x) => x.ts)?.ts ?? null
  const usage = t.turns.reduce((a, x) => ({ input: a.input + x.usage.inputTokens, cache_write: a.cache_write + x.usage.cacheCreationTokens,
    cache_read: a.cache_read + x.usage.cacheReadTokens, output: a.output + x.usage.outputTokens }), { input: 0, cache_write: 0, cache_read: 0, output: 0 })
  let scopeUsd = 0
  try {
    scopeUsd = scopeReview(t).out_of_scope_usd
  } catch {
    // a scope review is a bonus; never lose the row over it
  }
  return {
    ...row, project: project(t.cwd), developer: developer(), provider: provider(row.model),
    category: category(t.prompts.map((p) => p.text), v.signals), status: v.status, status_reason: v.reason,
    last_ts: lastTs, usage, agents, models, dead_usd: dead.dead_usd, dead: dead.items, commits: v.signals.commits, scope_usd: scopeUsd,
  }
}

function label(db: Db, sid: string): string | null {
  if (!db.tables().has('sessions')) return null
  return db.get('SELECT label FROM sessions WHERE session_id=?', sid)?.label ?? null
}

/** Parse one transcript and write its enriched ledger row. */
export function recordTranscript(dbPath: string, path: string, sessionId?: string | null): ledger.LedgerRow {
  const t = trace.parse(path)
  const sid = sessionId || t.sessionId || basename(path, '.jsonl')
  const db = store.connect(dbPath)
  try {
    const row = enrich(t, sid, label(db, sid))
    ledger.record(db, row)
    return row
  } finally {
    db.close()
  }
}

export type EventSession = { session_id: string, platform: string, project: string | null, developer: string | null, last: string,
  prompts: number, tool_calls: number, files: number } & Verdict

/** Sessions known only from telemetry events (Copilot), judged by the same OutcomeEngine rules. */
export function eventSessions(db: Db, since: string, platform = 'copilot'): EventSession[] {
  const rows = events(db, { since, platform })
  const by = new Map<string, typeof rows>()
  for (const r of rows) by.set(r.session_id, [...(by.get(r.session_id) ?? []), r])
  return [...by].map(([sid, rs]) => {
    const sig = signals(activityFromEvents(rs))
    return { session_id: sid, platform: rs[0].platform, project: rs.find((r) => r.project)?.project ?? null,
      developer: rs.find((r) => r.developer)?.developer ?? null, last: rs[rs.length - 1].ts,
      prompts: rs.filter((r) => r.type === 'prompt').length, tool_calls: rs.filter((r) => r.type === 'tool_result').length,
      files: sig.files.length, ...status(sig) }
  })
}
