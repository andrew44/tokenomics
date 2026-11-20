/** Small append-only event tables for the guard hooks (diet, sherlock, groundhog, ...). Never throws. */
import { errText, logErr, now } from '../util.ts'
import { withDb } from './db.ts'

export const TABLES: Record<string, string> = {
  diet_events: 'session_id TEXT, source TEXT, tool TEXT, rule TEXT, est_tokens INTEGER, action TEXT',
  sherlock_events: 'session_id TEXT, wasted_usd REAL, session_usd REAL, findings INTEGER, top_kind TEXT',
  groundhog_events: 'session_id TEXT, source TEXT, tool TEXT, rule TEXT, loop_key TEXT, action TEXT, detail TEXT',
  blinkers_events: 'session_id TEXT, source TEXT, tool TEXT, rule TEXT, path TEXT, action TEXT',
  ballast_events: 'session_id TEXT, source TEXT, rule TEXT, ctx_tokens INTEGER, step_usd REAL, band INTEGER, action TEXT',
}

export function log(dbPath: string, table: string, fields: Record<string, string | number | null>): void {
  try {
    withDb(dbPath, (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, ${TABLES[table]})`)
      const cols = ['ts', ...Object.keys(fields)]
      db.run(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`,
        now(), ...Object.values(fields))
    })
  } catch (e) {
    logErr(dbPath, `event log failed (${table}: ${errText(e).split('\n')[0]})`)
  }
}
