/** Shared utilities used by the engine and by both adapters. */
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Obj = Record<string, any>

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0')

/** Local time as 2026-01-31T09:15:00+0000 (the same shape as Python's %Y-%m-%dT%H:%M:%S%z). */
export function now(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  return `${today(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.abs(off) / 60)}${pad(Math.abs(off) % 60)}`
}

/** Local calendar day, YYYY-MM-DD (budgets reset at local midnight). */
export function today(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** Errors go to <db>.err, never to the screen: hooks must stay silent. */
export function logErr(dbPath: string, msg: string): void {
  try {
    mkdirSync(dirname(dbPath), { recursive: true })
    appendFileSync(dbPath + '.err', `${now()} ${msg}\n`)
  } catch {
    // nowhere left to report it
  }
}

export function errText(e: unknown): string {
  if (e instanceof Error) return e.stack || `${e.name}: ${e.message}`
  return String(e)
}

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** First present, non-empty value among several key spellings (camelCase / snake_case). */
export function first(d: Obj, keys: string[], fallback: any = undefined): any {
  for (const k of keys) {
    const v = d?.[k]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return fallback
}

/** Python-style truthiness, for values that came out of JSON. */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (isObj(v)) return Object.keys(v).length > 0
  return Boolean(v)
}

/** int(x or 0) for token counts that may be missing, null or strings. */
export function int(v: unknown): number {
  const n = Math.trunc(Number(v ?? 0))
  return Number.isFinite(n) ? n : 0
}

/** Fallback when a platform sends no session id: stable per folder per day. */
export function anonSessionId(cwd: string | null | undefined): string {
  return 'anon-' + sha1(`${cwd ?? ''}${today().replaceAll('-', '')}`).slice(0, 16)
}

/** Tool arguments arrive as an object or as a JSON string depending on the platform. */
export function asDict(value: unknown): Obj {
  if (isObj(value)) return value
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try {
      const v = JSON.parse(value)
      return isObj(v) ? v : {}
    } catch {
      return {}
    }
  }
  return {}
}

export function* walkStrings(obj: unknown, depth = 0): Generator<string> {
  if (depth > 6) return
  if (typeof obj === 'string') yield obj
  else if (Array.isArray(obj)) for (const v of obj) yield* walkStrings(v, depth + 1)
  else if (isObj(obj)) for (const v of Object.values(obj)) yield* walkStrings(v, depth + 1)
}

/** `description:` from a SKILL.md / command .md YAML front matter (folded blocks supported). */
export function frontmatterDescription(path: string): string | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8').slice(0, 6000)
  } catch {
    return null
  }
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(text)
  if (!m) return null
  const lines = m[1].split('\n')
  for (let i = 0; i < lines.length; i++) {
    const mm = /^description:\s*(.*)$/.exec(lines[i])
    if (!mm) continue
    let val = mm[1].trim()
    if (['>', '|', '>-', '|-', '>+', '|+', ''].includes(val)) {
      const block: string[] = []
      for (const nxt of lines.slice(i + 1)) {
        if (nxt.startsWith(' ') || nxt.startsWith('\t')) block.push(nxt.trim())
        else break
      }
      val = block.join(' ')
    }
    return val.replace(/^["']+|["']+$/g, '') || null
  }
  return null
}

/** The hook payload on stdin, or '' when there is none (a terminal, or a closed stdin). */
export function readStdin(): string {
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** The stdin JSON object, or {} for anything else (empty, not JSON, not an object). */
export function readPayload(): Obj {
  const raw = readStdin()
  if (!raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

/** Number formatting the way Python's format spec does it: fmt(1234.5, 2) -> '1,234.50'. */
export function fmt(n: number, decimals = 0, grouping = true): string {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping,
  })
}

/** Parse a timestamp (ISO string, epoch seconds or epoch milliseconds) to epoch seconds. */
export function parseTs(s: unknown): number | null {
  if (s === null || s === undefined || s === '' || s === 0) return null
  if (typeof s === 'number') return s > 1e11 ? s / 1000 : s
  const t = Date.parse(String(s))
  return Number.isNaN(t) ? null : t / 1000
}

/** True when the module at `url` (pass import.meta.url) is the script node was started with. */
export function isMain(url: string): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url))
  } catch {
    return false
  }
}


/** The value after `name` in args (`--days 7`), or null. */
export function argValue(args: string[], name: string): string | null {
  const i = args.indexOf(name)
  if (i >= 0 && i < args.length - 1) return args[i + 1]
  const eq = args.find((a) => a.startsWith(name + '='))
  return eq ? eq.slice(name.length + 1) : null
}
