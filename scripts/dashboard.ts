#!/usr/bin/env node
/**
 * tokenomics / dashboard: a local web UI over the spendlens SQLite database.
 *
 *   node scripts/dashboard.ts                 # serve http://127.0.0.1:8765
 *   node scripts/dashboard.ts --port 9000 --db /path/to/spendlens.db
 *   node scripts/dashboard.ts --demo          # seeded fake data, to preview the UI
 *   node scripts/dashboard.ts --background    # start it in the background and return
 *   node scripts/dashboard.ts --stop          # stop a background dashboard
 *
 * Read-only: the DB is opened read-only and never written to (except --demo, which uses a
 * temp file). Binds to 127.0.0.1 only.
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect as netConnect } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb, type Row } from '../tokenomics/engine/db.ts'
import * as store from '../tokenomics/engine/store.ts'
import { argValue, isMain, today, type Obj } from '../tokenomics/util.ts'

const HERE = import.meta.dirname
const INDEX = join(HERE, '..', 'dashboard', 'index.html')
const LABELS = ['opex', 'capex', 'mixed', 'unknown'] as const

const zero = () => ({ sessions: 0, prompts: 0, tokens: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0 })
const byLabel = () => Object.fromEntries(LABELS.map((k) => [k, zero()])) as Record<string, ReturnType<typeof zero>>

function add(acc: ReturnType<typeof zero>, r: Row): void {
  const inp = r.input_tokens || 0
  const out = r.output_tokens || 0
  acc.sessions += 1
  acc.prompts += r.prompt_count || 0
  acc.tokens += inp + out
  acc.input += inp
  acc.output += out
  acc.cache_read += r.cache_read_tokens || 0
  acc.cache_creation += r.cache_creation_tokens || 0
}

function shiftDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function build(dbPath: string, days: number): Obj {
  if (!(existsSync(dbPath) && statSync(dbPath).isFile())) return { empty: true, db_path: dbPath, reason: 'no-database' }
  let rows = withDb(dbPath, (db) => {
    const cols = db.columns('sessions')
    if (!cols.size) return null
    const want = ['session_id', 'source', 'cwd', 'label', 'prompt_count', 'first_seen', 'updated_at',
      'input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'skills', 'skill_detail']
    return db.all(`SELECT ${want.map((c) => (cols.has(c) ? c : `NULL AS ${c}`)).join(', ')} FROM sessions ORDER BY first_seen`)
  }, { readOnly: true })                               // the server is long-running: never leak handles
  if (rows === null) return { empty: true, db_path: dbPath, reason: 'no-table' }

  const cutoff = days ? today(shiftDays(new Date(), -(days - 1))) : null
  rows = rows.filter((r) => !cutoff || String(r.first_seen || '').slice(0, 10) >= cutoff)

  const totals = byLabel()
  const daily = new Map<string, ReturnType<typeof byLabel>>()
  const projects = new Map<string, ReturnType<typeof byLabel>>()
  const skills = new Map<string, { name: string, side: string | null, sessions: number }>()
  const sources: Record<string, number> = {}
  for (const r of rows) {
    const lab = (LABELS as readonly string[]).includes(r.label) ? r.label : 'unknown'
    add(totals[lab], r)
    const day = String(r.first_seen || '').slice(0, 10) || 'unknown'
    if (!daily.has(day)) daily.set(day, byLabel())
    add(daily.get(day)![lab], r)
    const proj = String(r.cwd || 'unknown').replace(/[/\\]+$/, '')
    if (!projects.has(proj)) projects.set(proj, byLabel())
    add(projects.get(proj)![lab], r)
    const src = r.source || 'unknown'
    sources[src] = (sources[src] ?? 0) + 1
    let detail: Obj[] = []
    try {
      detail = r.skill_detail ? JSON.parse(r.skill_detail) : []
    } catch {
      detail = []
    }
    for (const s of Array.isArray(detail) ? detail : []) {
      const k = s?.name
      if (!k) continue
      if (!skills.has(k)) skills.set(k, { name: k, side: s.side ?? null, sessions: 0 })
      skills.get(k)!.sessions += 1
    }
  }

  // dense daily series so quiet days show as gaps, not as missing bars
  const series: Obj[] = []
  const dated = [...daily.keys()].filter((d) => d !== 'unknown').sort()
  if (cutoff || dated.length) {
    const startKey = cutoff || dated[0]
    const [y, mo, d] = startKey.split('-').map(Number)
    const end = today()
    for (let day = new Date(y, mo - 1, d); today(day) <= end; day = shiftDays(day, 1)) {
      const key = today(day)
      series.push({ date: key, ...(daily.get(key) ?? byLabel()) })
    }
  }

  const recent = [...rows].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 12)
    .map((r) => ({ session_id: r.session_id, source: r.source, cwd: r.cwd, label: r.label, prompts: r.prompt_count || 0,
      tokens: (r.input_tokens || 0) + (r.output_tokens || 0), updated_at: r.updated_at }))
  return {
    empty: !rows.length, reason: rows.length ? null : 'no-rows',
    db_path: dbPath, days,
    generated: new Date().toISOString(),
    totals, daily: series, projects: [...projects].map(([cwd, by]) => ({ cwd, by })),
    skills: [...skills.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 10),
    sources, recent,
  }
}

/** A small seeded PRNG, so the demo data is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0
  const next = () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const gauss = (mu: number, sigma: number) => mu + sigma * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())
  return {
    random: next,
    int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)),
    choice: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    uniform: (a: number, b: number) => a + (b - a) * next(),
    gauss,
    lognorm: (mu: number, sigma: number) => Math.exp(gauss(mu, sigma)),
  }
}

export function seedDemo(path: string): void {
  const db = store.connect(path)
  const rnd = rng(7)
  const projects = ['/work/payments-api', '/work/platform-infra', '/work/web-app', '/work/observability', '/work/data-pipeline']
  const bias: Record<string, number> = { '/work/payments-api': 0.25, '/work/platform-infra': 0.7, '/work/web-app': 0.1,
    '/work/observability': 0.92, '/work/data-pipeline': 0.35 }
  const skills: [string, string][] = [['grafana-triage', 'opex'], ['incident-review', 'opex'], ['loki-queries', 'opex'],
    ['frontend-design', 'capex'], ['unit-tests', 'capex'], ['skill-creator', 'capex']]
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  try {
    for (let i = 0; i < 190; i++) {
      let age = Math.floor(Math.abs(rnd.gauss(0, 24)))
      if (age > 59) age = rnd.int(0, 59)
      const ts = new Date(now.getTime() - ((age * 24 + rnd.int(0, 9)) * 60 + rnd.int(0, 59)) * 60_000)
      if ((ts.getDay() === 0 || ts.getDay() === 6) && rnd.random() < 0.7) continue
      const proj = rnd.choice(projects)
      let side = rnd.random() < bias[proj] ? 'opex' : 'capex'
      if (rnd.random() < 0.12) side = 'mixed'
      if (rnd.random() < 0.05) side = 'unknown'
      const inp = Math.floor(rnd.lognorm(10.4, 0.8))
      let out = Math.floor(inp * rnd.uniform(0.15, 0.6))
      if (side === 'capex') out = Math.floor(out * 1.8)
      const cr = Math.floor(inp * rnd.uniform(6, 40))
      const cc = Math.floor(inp * rnd.uniform(0.6, 2.5))
      const sk = skills.filter((s) => s[1] === side && rnd.random() < 0.35).slice(0, 2)
      const detail = sk.map(([n, sd]) => ({ name: n, side: sd, basis: 'name', description: '' }))
      const when = `${today(ts)}T${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}+0000`
      db.run(`INSERT INTO sessions(session_id,source,cwd,label,opex_score,capex_score,prompt_count,
              first_seen,updated_at,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
              total_tokens,skills,skill_opex,skill_capex,skill_detail)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      `demo-${String(i).padStart(4, '0')}`, rnd.choice(['claude-code', 'claude-code', 'claude-code', 'claude-code', 'copilot']),
      proj, side, rnd.int(0, 30), rnd.int(0, 30), rnd.int(2, 40), when, when, inp, out, cc, cr, inp + out + cc + cr,
      JSON.stringify(sk.map(([n]) => n)), sk.filter(([, sd]) => sd === 'opex').length,
      sk.filter(([, sd]) => sd === 'capex').length, JSON.stringify(detail))
    }
  } finally {
    db.close()
  }
}

export function serve(dbPath: string, port: number, onListening?: () => void) {
  const srv = createServer((req, res) => {
    const send = (code: number, body: string | Buffer, ctype: string) => {
      const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
      res.writeHead(code, { 'Content-Type': ctype, 'Content-Length': data.length, 'Cache-Control': 'no-store' })
      res.end(data)
    }
    const u = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET') return send(405, 'method not allowed', 'text/plain')
    if (u.pathname === '/' || u.pathname === '/index.html') {
      try {
        send(200, readFileSync(INDEX), 'text/html; charset=utf-8')
      } catch {
        send(500, 'dashboard/index.html is missing', 'text/plain')
      }
    } else if (u.pathname === '/api/data') {
      try {
        const n = Number.parseInt(u.searchParams.get('days') ?? '30', 10)
        const days = Math.max(0, Math.min(Number.isNaN(n) ? 30 : n, 3650))
        send(200, JSON.stringify(build(dbPath, days)), 'application/json')
      } catch (e) {                                 // never crash the server on a bad DB
        send(500, JSON.stringify({ error: String(e instanceof Error ? e.message : e) }), 'application/json')
      }
    } else {
      send(404, 'not found', 'text/plain')
    }
  })
  srv.listen(port, '127.0.0.1', onListening)
  return srv
}

const PID_FILE = join(process.env.TOKENOMICS_HOME || join(homedir(), '.tokenomics'), 'dashboard.pid')

export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = netConnect({ host: '127.0.0.1', port })
    const done = (v: boolean) => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(300, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

function openBrowser(url: string, noOpen: boolean): void {
  if (noOpen) return
  try {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  } catch {
    // no browser: the URL is printed anyway
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Start the server as a detached process, wait until it answers, open the browser, return. */
async function background(port: number, demo: boolean, noOpen: boolean, argv: string[]): Promise<number> {
  const url = `http://127.0.0.1:${port}/`
  if (await portBusy(port)) {
    process.stdout.write(`tokenomics dashboard is already running on ${url}\n`)
    openBrowser(url, noOpen)
    return 0
  }
  const args = [...argv.filter((x) => x !== '--background'), '--no-open']
  mkdirSync(join(PID_FILE, '..'), { recursive: true })
  const logPath = join(PID_FILE, '..', 'dashboard.log')
  const log = openSync(logPath, 'a')
  const proc = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...args],
    { stdio: ['ignore', log, log], detached: true, windowsHide: true })
  closeSync(log)
  let exited = false
  proc.on('exit', () => { exited = true })
  proc.unref()
  writeFileSync(PID_FILE, String(proc.pid), 'utf8')
  const deadline = Date.now() + 20_000                   // a cold start on a busy Mac can be slow
  while (!(await portBusy(port))) {
    if (exited || Date.now() > deadline) {
      let tail = ''
      try {
        tail = readFileSync(logPath, 'utf8').slice(-2000)
      } catch {
        // no log
      }
      process.stderr.write(`The dashboard didn't start (see ${logPath}).\n${tail}\n`)
      return 1
    }
    await sleep(100)
  }
  process.stdout.write(`tokenomics dashboard running on ${url}${demo ? '  (demo data)' : ''}\n` +
    '  stop it with: tokenomics dashboard --stop\n')
  openBrowser(url, noOpen)
  return 0
}

function stop(): number {
  let pid: number
  try {
    pid = Number.parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10)
    if (Number.isNaN(pid)) throw new Error('bad pid')
  } catch {
    process.stdout.write('No background dashboard is running.\n')
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
    process.stdout.write(`Stopped the dashboard (pid ${pid}).\n`)
  } catch {
    process.stdout.write('No background dashboard is running.\n')
  }
  try {
    unlinkSync(PID_FILE)
  } catch {
    // already gone
  }
  return 0
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write('usage: dashboard.ts [--db PATH] [--port N] [--demo] [--no-open] [--background] [--stop]\n')
    return 0
  }
  const port = Number.parseInt(argValue(argv, '--port') ?? '8765', 10)
  const demo = argv.includes('--demo')
  const noOpen = argv.includes('--no-open')
  if (argv.includes('--stop')) return stop()
  if (argv.includes('--background')) return background(port, demo, noOpen, argv)
  let dbPath = argValue(argv, '--db') ?? defaultDbPath()
  if (demo) {
    dbPath = join(mkdtempSync(join(tmpdir(), 'tokenomics-demo-')), 'spendlens.db')
    seedDemo(dbPath)
  }
  const url = `http://127.0.0.1:${port}/`
  serve(dbPath, port, () => {
    process.stdout.write(`tokenomics dashboard on ${url}\n  db: ${dbPath}${demo ? '  (demo data)' : ''}\n  Ctrl+C to stop\n`)
    openBrowser(url, noOpen)
  }).on('error', (e) => {
    process.stderr.write(`tokenomics dashboard: ${e.message}\n`)
    process.exitCode = 1
  })
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
