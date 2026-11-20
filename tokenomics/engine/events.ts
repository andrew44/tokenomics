/** Small append-only event tables for the guard hooks (diet, ...). Never throws. */
import { errText, logErr, now } from '../util.ts'
import { withDb } from './db.ts'

export const TABLES: Record<string, string> = {
  diet_events: 'session_id TEXT, source TEXT, tool TEXT, rule TEXT, est_tokens INTEGER, action TEXT',
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
