/**
 * SQLite through Node's built-in node:sqlite (no packages). Statements run in autocommit mode.
 *
 * node:sqlite is still marked experimental on Node 22 and prints a warning when it loads; hooks
 * must stay silent, so that one warning is filtered out while the module loads.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

type Sqlite = typeof import('node:sqlite')
let sqliteModule: Sqlite | undefined

export function sqlite(): Sqlite {
  if (!sqliteModule) {
    const emit = process.emitWarning
    process.emitWarning = function (this: unknown, warning: string | Error, ...rest: unknown[]) {
      const text = typeof warning === 'string' ? warning : warning?.message
      if (/SQLite/i.test(String(text))) return
      return (emit as (...a: unknown[]) => void).call(process, warning, ...rest)
    } as typeof process.emitWarning
    try {
      sqliteModule = process.getBuiltinModule('node:sqlite') as Sqlite
    } finally {
      process.emitWarning = emit
    }
  }
  return sqliteModule
}

export type Row = Record<string, any>
type Param = SQLInputValue | boolean | undefined

const bind = (params: Param[]): SQLInputValue[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p))

export class Db {
  readonly raw: DatabaseSync

  constructor(path: string, opts: { readOnly?: boolean } = {}) {
    if (!opts.readOnly) mkdirSync(dirname(path), { recursive: true })
    this.raw = new (sqlite().DatabaseSync)(path, { readOnly: Boolean(opts.readOnly), timeout: 5000 })
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  run(sql: string, ...params: Param[]): void {
    this.raw.prepare(sql).run(...bind(params))
  }

  get(sql: string, ...params: Param[]): Row | undefined {
    return this.raw.prepare(sql).get(...bind(params)) as Row | undefined
  }

  all(sql: string, ...params: Param[]): Row[] {
    return this.raw.prepare(sql).all(...bind(params)) as Row[]
  }

  /** Run `fn` as one transaction: one disk sync for all its writes instead of one per statement. */
  transaction<T>(fn: () => T): T {
    this.raw.exec('BEGIN')
    try {
      const out = fn()
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK')
      } catch {
        // nothing to roll back
      }
      throw e
    }
  }

  /** Column names of a table (empty when the table doesn't exist). */
  columns(table: string): Set<string> {
    return new Set(this.all(`PRAGMA table_info(${table})`).map((r) => String(r.name)))
  }

  tables(): Set<string> {
    return new Set(this.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => String(r.name)))
  }

  close(): void {
    try {
      this.raw.close()
    } catch {
      // already closed
    }
  }
}

/** Open, run `fn`, always close. */
export function withDb<T>(path: string, fn: (db: Db) => T, opts: { readOnly?: boolean } = {}): T {
  const db = new Db(path, opts)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
