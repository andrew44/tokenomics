/**
 * TelemetryEngine: event collection and normalisation, the same for every platform.
 *
 * Each adapter only translates. It maps its platform's lifecycle (Claude Code: UserPromptSubmit,
 * PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd; Copilot: userPromptSubmitted, preToolUse,
 * postToolUse, sessionStart, sessionEnd) onto one shared event, and everything downstream (attribution,
 * outcomes, dead work, scope) reads only that.
 *
 * A TelemetryEvent holds numbers, names and kinds: never prompt text, file contents or the text of a
 * command. A shell command is kept as what it is for (test, lint, build, commit, ...) and a file as its
 * path relative to the project.
 *
 * It also derives the attribution dimensions finance and engineering managers ask about: project,
 * developer, agent / subagent, model and provider (per session, from a transcript where there is one).
 */
import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

import type { LifecycleEvent, PlatformAdapter } from '../platform/adapter.ts'
import { errText, first, logErr, now, type Obj } from '../util.ts'
import { withDb, type Db } from '../engine/db.ts'
import { median } from '../engine/ledger.ts'
import type { Trace } from '../engine/trace.ts'
import { provider } from './cost.ts'
import { commandKind } from './outcome.ts'

export const VERSION = 1

export type TelemetryEvent = {
  v: number
  type: LifecycleEvent
  platform: string
  session_id: string
  ts: string
  project: string | null
  developer: string | null
  billing_model: string
  tool: string | null
  tool_kind: string | null       // code_edit | shell | read | skill | other
  command_kind: string | null    // shell only: test | lint | build | commit | pr | revert | delete | other
  path: string | null            // file a tool touched, relative to the project
  ok: boolean | null             // tool_result only: did it succeed (null: not reported)
  prompt_chars: number | null    // prompt only: its length, never its text
}

// ---- dimensions ---------------------------------------------------------------------------------

const rootCache = new Map<string, string | null>()

/** The project folder: the nearest folder above cwd holding .git, else cwd itself. */
export function projectRoot(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  if (rootCache.has(cwd)) return rootCache.get(cwd)!
  let dir = cwd
  let found: string | null = null
  for (let i = 0; i < 40; i++) {
    try {
      if (existsSync(join(dir, '.git'))) {
        found = dir
        break
      }
    } catch {
      break
    }
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  rootCache.set(cwd, found ?? cwd)
  return found ?? cwd
}

/** A project's name: TOKENOMICS_PROJECT, else the repository (or folder) name. */
export function project(cwd: string | null | undefined): string | null {
  const forced = (process.env.TOKENOMICS_PROJECT ?? '').trim()
  if (forced) return forced
  const root = projectRoot(cwd)
  return root ? basename(root) || root : null
}

/** Who did the work: TOKENOMICS_DEVELOPER (set it to a team handle to share reports), else the
 *  computer's user name. Never an email address. */
export function developer(): string | null {
  const forced = (process.env.TOKENOMICS_DEVELOPER ?? '').trim()
  if (forced) return forced
  try {
    return userInfo().username || null
  } catch {
    return null
  }
}

/** A path relative to the project (absolute paths outside it stay absolute). */
export function relPath(path: string, cwd: string | null): string {
  if (!path) return ''
  const root = projectRoot(cwd)
  if (!root || !isAbsolute(path)) return path.replaceAll('\\', '/')
  const r = relative(root, path)
  return (r.startsWith('..') ? path : r).replaceAll('\\', '/')
}

// ---- normalisation ------------------------------------------------------------------------------

/** One platform hook payload -> the shared event. `mode` is the hook runner's mode, used only where the
 *  payload doesn't name its own event. */
export function normalise(adapter: PlatformAdapter, payload: Obj, mode: string): TelemetryEvent {
  const type = adapter.lifecycle(payload, mode)
  const cwd = payload.cwd ? String(payload.cwd) : null
  const ev: TelemetryEvent = {
    v: VERSION, type, platform: adapter.name, session_id: adapter.sessionId(payload), ts: now(), project: project(cwd),
    developer: developer(), billing_model: adapter.billingModel, tool: null, tool_kind: null, command_kind: null, path: null,
    ok: null, prompt_chars: null,
  }
  if (type === 'prompt') {
    const text = first(payload, ['prompt', 'userPrompt'], '')
    ev.prompt_chars = String(text ?? '').length
  }
  if (type === 'tool_call' || type === 'tool_result') {
    const call = adapter.toolCall(payload)
    if (call) {
      ev.tool = call.name
      ev.tool_kind = call.kind
      ev.command_kind = call.command ? commandKind(call.command) : null
      ev.path = call.path ? relPath(call.path, cwd) : null
    }
    if (type === 'tool_result') ev.ok = adapter.toolOk(payload)
  }
  return ev
}

// ---- collection ---------------------------------------------------------------------------------

const COLUMNS = 'v INTEGER, type TEXT, platform TEXT, session_id TEXT, project TEXT, developer TEXT, billing_model TEXT, ' +
  'tool TEXT, tool_kind TEXT, command_kind TEXT, path TEXT, ok INTEGER, prompt_chars INTEGER'

export function ensure(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS telemetry_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, ${COLUMNS});
    CREATE INDEX IF NOT EXISTS idx_tel_session ON telemetry_events(session_id);`)
}

export function collect(db: Db, events: TelemetryEvent[]): void {
  ensure(db)
  for (const e of events) {
    db.run(`INSERT INTO telemetry_events(ts,v,type,platform,session_id,project,developer,billing_model,tool,tool_kind,command_kind,path,ok,prompt_chars)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, e.ts, e.v, e.type, e.platform, e.session_id, e.project, e.developer, e.billing_model,
    e.tool, e.tool_kind, e.command_kind, e.path, e.ok, e.prompt_chars)
  }
}

export function enabled(): boolean {
  return (process.env.TOKENOMICS_TELEMETRY ?? '').trim().toLowerCase() !== 'off'
}

/** Hook entry point: normalise and store one lifecycle event. Never throws. */
export function ingest(adapter: PlatformAdapter, payload: Obj, mode: string, dbPath: string): TelemetryEvent | null {
  if (!enabled()) return null
  try {
    const ev = normalise(adapter, payload, mode)
    withDb(dbPath, (db) => collect(db, [ev]))
    return ev
  } catch (e) {
    logErr(dbPath, `telemetry\n${errText(e)}`)
    return null
  }
}

export type EventRow = { ts: string, type: string, platform: string, session_id: string, project: string | null, developer: string | null,
  tool: string | null, tool_kind: string | null, command_kind: string | null, path: string | null, ok: number | null }

/** Stored events, oldest first; for one session, or every session last seen on or after `since` (YYYY-MM-DD). */
export function events(db: Db, opts: { session?: string, since?: string, platform?: string } = {}): EventRow[] {
  if (!db.tables().has('telemetry_events')) return []
  const where: string[] = []
  const args: string[] = []
  if (opts.session) {
    where.push('session_id=?')
    args.push(opts.session)
  }
  if (opts.since) {
    where.push('session_id IN (SELECT session_id FROM telemetry_events GROUP BY session_id HAVING substr(MAX(ts),1,10) >= ?)')
    args.push(opts.since)
  }
  if (opts.platform) {
    where.push('platform=?')
    args.push(opts.platform)
  }
  return db.all(`SELECT ts,type,platform,session_id,project,developer,tool,tool_kind,command_kind,path,ok FROM telemetry_events
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`, ...args) as EventRow[]
}

// ---- per-session attribution (from a transcript) -------------------------------------------------

export type ModelStat = { provider: string, turns: number, cost_usd: number, latency_s: number | null, api_errors: number,
  input: number, cache_write: number, cache_read: number, output: number }
export type AgentStat = { turns: number, cost_usd: number }

/** Cost and tokens by agent (main or subagent type) and by model, with each model's provider, its
 *  median reply latency and its API errors. */
export function breakdown(t: Trace): { agents: Record<string, AgentStat>, models: Record<string, ModelStat> } {
  const agents: Record<string, AgentStat> = {}
  const models: Record<string, ModelStat> = {}
  const lat = new Map<string, number[]>()
  for (const turn of t.turns) {
    const a = agents[turn.agent] ??= { turns: 0, cost_usd: 0 }
    a.turns++
    a.cost_usd += turn.costUsd
    const name = turn.model || 'unknown'
    const m = models[name] ??= { provider: provider(name), turns: 0, cost_usd: 0, latency_s: null, api_errors: 0,
      input: 0, cache_write: 0, cache_read: 0, output: 0 }
    m.turns++
    m.cost_usd += turn.costUsd
    m.input += turn.usage.inputTokens
    m.cache_write += turn.usage.cacheCreationTokens
    m.cache_read += turn.usage.cacheReadTokens
    m.output += turn.usage.outputTokens
    if (turn.latency !== null && turn.latency < 600) lat.set(name, [...(lat.get(name) ?? []), turn.latency])
  }
  for (const [name, n] of Object.entries(t.apiErrors)) {
    const m = models[name] ??= { provider: provider(name), turns: 0, cost_usd: 0, latency_s: null, api_errors: 0,
      input: 0, cache_write: 0, cache_read: 0, output: 0 }
    m.api_errors += n
  }
  for (const [name, xs] of lat) models[name].latency_s = Math.round(median(xs) * 10) / 10
  return { agents, models }
}

