/**
 * Shared test helpers. Importing this first gives the whole test process a throwaway HOME,
 * TOKENOMICS_HOME and TOKENOMICS_DB, so no test ever touches the real ~/.tokenomics.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Db, type Row } from '../tokenomics/engine/db.ts'

export const ROOT = join(import.meta.dirname, '..')
export const SCRIPTS = join(ROOT, 'scripts')

const sandbox = mkdtempSync(join(tmpdir(), 'tokenomics-test-'))
for (const k of Object.keys(process.env)) if (k.startsWith('TOKENOMICS_')) delete process.env[k]
process.env.HOME = sandbox
process.env.USERPROFILE = sandbox
process.env.TOKENOMICS_HOME = join(sandbox, '.tokenomics')
process.env.TOKENOMICS_DB = join(sandbox, '.tokenomics', 'spendlens.db')
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

export const USAGE = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 1000 }

export function user(text: unknown, meta = false) {
  return { type: 'user', isMeta: meta, message: { role: 'user', content: text } }
}

export function assistant(mid: string, tools: [string, object][] = [], usage: object = USAGE): Record<string, any> {
  return { type: 'assistant', message: { id: mid, content: tools.map(([name, input]) => ({ type: 'tool_use', name, input })), usage } }
}

export function writeTranscript(directory: string, name: string, records: object[]): string {
  const p = join(directory, `${name}.jsonl`)
  writeFileSync(p, records.map((r) => JSON.stringify(r) + '\n').join(''))
  return p
}

export type Env = Record<string, string | undefined>

/** Run a script the way a hook runs it: node <script> args, with stdin. */
export function runScript(script: string, args: string[] = [], opts: { input?: string, env?: Env, timeout?: number } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [script.includes('/') || script.includes('\\') ? script : join(SCRIPTS, script), ...args], {
    input: opts.input ?? '', env: opts.env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: opts.timeout ?? 30_000,
  })
}

/** Run `fn` with some environment variables set (undefined = unset), then put them back. */
export async function withEnv<T>(vars: Env, fn: () => T | Promise<T>): Promise<T> {
  const old: Env = {}
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Isolated HOME + DB for one test. */
export class TempEnv {
  home: string
  db: string

  constructor() {
    this.home = mkdtempSync(join(tmpdir(), 'tokenomics-t-'))
    this.db = join(this.home, 'spendlens.db')
  }

  env(extra: Env = {}): Env {
    const e: Env = { ...process.env }
    for (const k of Object.keys(e)) if (k.startsWith('TOKENOMICS_')) delete e[k]
    return { ...e, HOME: this.home, USERPROFILE: this.home, TOKENOMICS_DB: this.db, ...extra }
  }

  hook(mode: string, source: string, payload: unknown, extra: Env = {}) {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
    return runScript('spendlens.ts', [mode, source], { input: data, env: this.env(extra) })
  }

  rows(sql: string, ...args: (string | number)[]): Row[] {
    const db = new Db(this.db)
    try {
      return db.all(sql, ...args).map((r) => ({ ...r }))
    } finally {
      db.close()
    }
  }

  session(sid: string): Row | null {
    return this.rows('SELECT * FROM sessions WHERE session_id=?', sid)[0] ?? null
  }

  mkdir(...parts: string[]): string {
    const p = join(this.home, ...parts)
    mkdirSync(p, { recursive: true })
    return p
  }

  cleanup(): void {
    rmSync(this.home, { recursive: true, force: true })
  }
}

/** A TempEnv per test, cleaned up afterwards. */
export function useTemp(t: { after: (fn: () => void) => void }): TempEnv {
  const e = new TempEnv()
  t.after(() => e.cleanup())
  return e
}
