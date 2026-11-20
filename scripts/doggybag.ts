#!/usr/bin/env node
/**
 * tokenomics / doggybag: pack up the session's leftovers before the prompt cache goes cold.
 *
 * When the cache goes cold, resuming the full session re-writes the whole context to the cache at a
 * premium (1.25x input price). A doggybag is a small, deterministic digest (recent prompts, last
 * reply, files touched, tasks, git state) so you can carry on from it for a fraction of the tokens.
 * No model is called to write it.
 *
 * Doggybags live with the project: <cwd>/.doggybag/<session>.md, plus latest.md (the newest one).
 * The folder carries its own .gitignore ("*"), so it is never committed, whatever the repo's rules.
 *
 * Hook commands (all read the hook JSON on stdin, exit 0):
 *   doggybag.ts arm    [source]  Stop (Claude Code) / userPromptSubmitted (Copilot): start a background
 *                                watcher that packs the doggybag LEAD seconds before the cache expires.
 *   doggybag.ts prompt [source]  UserPromptSubmit: if this session's cache already went cold, make sure
 *                                a doggybag is packed and say how to carry on cheaply.
 *   doggybag.ts end    [source]  SessionEnd: stop the watcher and pack a doggybag if none is current.
 *   doggybag.ts start  [source]  SessionStart (startup, /clear): load the folder's latest doggybag.
 *   doggybag.ts write  [source]  Pack one now (manual use; prints its path).
 * Internal: doggybag.ts watch <jobfile> <token>
 *
 * Env (the older TOKENOMICS_HANDOFF_* names still work):
 *   TOKENOMICS_DOGGYBAG          on (default) | off
 *   TOKENOMICS_DOGGYBAG_LEAD     seconds before expiry to pack (default 60)
 *   TOKENOMICS_DOGGYBAG_DIR      folder name inside the project (default .doggybag); an absolute path
 *                                puts every project's doggybags there instead
 *   TOKENOMICS_DOGGYBAG_INJECT   1 (default) = a new session or /clear loads the latest doggybag as
 *                                context; 0 = only say it exists
 *   TOKENOMICS_DOGGYBAG_COLD     warn (default) | block (pause the first cold prompt once) | off
 *   TOKENOMICS_DOGGYBAG_COLD_MIN_TOKENS  only speak up on a cold prompt above this context (default 20000)
 *   TOKENOMICS_DOGGYBAG_MAX_AGE_H  hours a doggybag is offered for (default 24)
 *   TOKENOMICS_DOGGYBAG_KEEP     doggybags kept per folder (default 10)
 *   TOKENOMICS_CACHE_TTL         cache lifetime in seconds (default: detected, 300 or 3600)
 *   TOKENOMICS_DB                SQLite path shared with spendlens (default ~/.tokenomics/spendlens.db)
 *
 * Errors go to <db>.err, never on screen.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync,
  statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { anonSessionId, errText, fmt, int, isMain, isObj, logErr, now, parseTs, readStdin, sha1, type Obj } from '../tokenomics/util.ts'
import { currency, loadCfg, usageCostUsd } from './statusline.ts'

const HOME = homedir()
const FALLBACK_DIR = join(HOME, '.tokenomics', 'doggybags')     // when the project folder is unknown or read-only
const LATEST = 'latest.md'
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TAIL_BYTES = 1_000_000
const SELF = fileURLToPath(import.meta.url)

/** TOKENOMICS_DOGGYBAG<name>, falling back to the old TOKENOMICS_HANDOFF<name>. */
function setting(name: string, fallback: string): string {
  for (const key of ['TOKENOMICS_DOGGYBAG' + name, 'TOKENOMICS_HANDOFF' + name]) {
    const v = process.env[key]
    if (v !== undefined && v !== '') return v
  }
  return fallback
}

function intSetting(v: string | undefined, fallback: number): number {
  return v !== undefined && /^\s*[+-]?\d+\s*$/.test(v) ? Number.parseInt(v, 10) : fallback
}

// Read on use, so a change to the environment applies to the next call.
const cfg = {
  dir: () => setting('_DIR', '.doggybag'),
  enabled: () => setting('', 'on').trim().toLowerCase() !== 'off',
  lead: () => intSetting(setting('_LEAD', ''), 60),
  keep: () => intSetting(setting('_KEEP', ''), 10),
  maxAgeH: () => intSetting(setting('_MAX_AGE_H', ''), 24),
  ttlOverride: () => intSetting(process.env.TOKENOMICS_CACHE_TTL, 0),
  inject: () => !['0', 'off', 'no', 'false'].includes(setting('_INJECT', '1').trim().toLowerCase()),
  coldMode: () => setting('_COLD', 'warn').trim().toLowerCase(),
  coldMinTokens: () => intSetting(setting('_COLD_MIN_TOKENS', ''), 20000),
}

const nowS = () => Date.now() / 1000

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs / 1000
  } catch {
    return 0
  }
}

function expandUser(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(HOME, p.slice(1)) : p
}

export function sessionId(d: Obj): string {
  const sid = d.session_id || d.sessionId || (isObj(d.session) ? d.session.id : null)
  return sid ? String(sid) : anonSessionId(d.cwd ?? '')
}

const safe = (sid: string) => sid.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80)

/** Where this folder's doggybags live: <cwd>/.doggybag (self-ignoring), or the fallback. */
export function bagDir(cwd: string | null | undefined, create = false): string {
  const s = expandUser(cfg.dir())
  const d = isAbsolute(s) ? s : cwd && isDir(cwd) ? join(cwd, s) : FALLBACK_DIR
  if (create) {
    try {
      mkdirSync(d, { recursive: true })
      const ign = join(d, '.gitignore')
      if (!existsSync(ign)) writeFileSync(ign, '# tokenomics doggybags: local session notes, never committed\n*\n', 'utf8')
    } catch (e) {
      if (d === FALLBACK_DIR) throw e
      return isAbsolute(s) ? d : bagDir(null, true)
    }
  }
  return d
}

/** A short way to name `path` to the user: relative to the project when it is inside it. */
function show(path: string, cwd: string): string {
  if (!cwd) return path
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : path
}

// ------------------------------------------------------------------ transcript location ----

function walkJsonl(directory: string): string[] {
  try {
    return readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jsonl')).map((f) => join(directory, f))
  } catch {
    return []
  }
}

/** Newest *.jsonl under `directory`; if `sid` is given, only files whose path names it count
 *  (falling back to any file when none does). */
function newestJsonl(directory: string, sid?: string | null): string | null {
  const files = walkJsonl(directory)
  const pick = (xs: string[]) => xs.reduce<[string | null, number]>((best, p) => {
    const m = mtime(p)
    return m > best[1] ? [p, m] : best
  }, [null, 0])[0]
  if (sid) {
    const own = pick(files.filter((p) => relative(directory, p).split(/[/\\]/).includes(sid) || basename(p, '.jsonl') === sid))
    if (own) return own
  }
  return pick(files)
}

export function resolveTranscript(d: Obj, source: string): string | null {
  let t = d.transcript_path || d.transcriptPath
  if (!t && source === 'copilot') t = join(process.env.COPILOT_HOME || join(HOME, '.copilot'), 'session-state')   // best effort
  if (!t) return null
  let p: string | null = String(t)
  if (isDir(p)) {
    const sid = d.session_id || d.sessionId
    p = newestJsonl(p, sid ? String(sid) : null)
  }
  return p && isFile(p) ? p : null
}

// ------------------------------------------------------------------ cache clock ------------

/** -> [lastCacheTs, ttlSeconds] from the tail of the transcript, or [null, ttl]. */
function cacheClock(path: string): [number | null, number] {
  let last: number | null = null
  let ttl1h = false
  try {
    const fd = openSync(path, 'r')
    let text: string
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - TAIL_BYTES)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    for (const raw of text.split(/\r?\n/).reverse()) {
      if (!raw.includes('"usage"')) continue
      let ev: Obj
      try {
        ev = JSON.parse(raw)
      } catch {
        continue
      }
      const u = ev?.message?.usage
      if (ev.type !== 'assistant' || !isObj(u)) continue
      if (int(u.cache_read_input_tokens) + int(u.cache_creation_input_tokens)) {
        const ts = parseTs(ev.timestamp)
        if (ts) {
          last = ts
          ttl1h = Boolean(int(u.cache_creation?.ephemeral_1h_input_tokens))
          break
        }
      }
    }
    if (last === null) last = mtime(path) || null
  } catch {
    // unreadable: no clock
  }
  return [last, cfg.ttlOverride() || (ttl1h ? 3600 : 300)]
}

// ------------------------------------------------------------------ digest -----------------

function cleanPrompt(text: string): string {
  return text.replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ').split(/\s+/).filter(Boolean).join(' ')
}

function msgText(msg: Obj): string {
  const c = msg?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((p) => isObj(p) && p.type === 'text').map((p) => p.text ?? '').join(' ')
  return ''
}

export type Digest = { prompts: string[], reply: string, files: string[], cmds: string[], todos: [string, string][],
  model: string | null, ctx: number, first_ts: number | null }

/** One streaming pass over the transcript -> the facts the doggybag needs. */
export function digest(path: string): Digest {
  const r: Digest = { prompts: [], reply: '', files: [], cmds: [], todos: [], model: null, ctx: 0, first_ts: null }
  const tasks = new Map<string, [string, string]>()
  let taskN = 0
  const seenFiles = new Map<string, string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let ev: Obj
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(ev)) continue
    const kind = ev.type
    const msg: Obj = isObj(ev.message) ? ev.message : {}
    r.first_ts = r.first_ts || parseTs(ev.timestamp)
    if (kind === 'user' && !ev.isMeta) {
      const t = cleanPrompt(msgText(msg))
      if (t) r.prompts.push(t)
    } else if (kind === 'assistant') {
      if (msg.model && !String(msg.model).startsWith('<')) r.model = msg.model
      const u = msg.usage
      if (isObj(u) && !ev.isSidechain) r.ctx = int(u.input_tokens) + int(u.cache_read_input_tokens) + int(u.cache_creation_input_tokens)
      const t = msgText(msg).trim()
      if (t) r.reply = t
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (!(isObj(part) && part.type === 'tool_use')) continue
        const name = part.name ?? ''
        const inp: Obj = isObj(part.input) ? part.input : {}
        if (EDIT_TOOLS.has(name)) {
          const fp = inp.file_path || inp.notebook_path
          if (fp) seenFiles.set(fp, name)
        } else if (name === 'Bash' && inp.command) {
          r.cmds.push(String(inp.command).split(/\s+/).filter(Boolean).join(' ').slice(0, 160))
        } else if (name === 'TodoWrite' && Array.isArray(inp.todos)) {
          r.todos = inp.todos.filter(isObj).map((x: Obj) => [String(x.content ?? '').slice(0, 120), x.status ?? 'pending'])
        } else if (name === 'TaskCreate') {
          taskN += 1
          tasks.set(String(taskN), [String(inp.subject ?? '').slice(0, 120), 'pending'])
        } else if (name === 'TaskUpdate' && tasks.has(String(inp.taskId))) {
          if (inp.status === 'deleted') tasks.delete(String(inp.taskId))
          else if (inp.status) tasks.get(String(inp.taskId))![1] = inp.status
        }
      }
    }
  }
  r.files = [...seenFiles.keys()].slice(-15)
  r.prompts = r.prompts.slice(-4)
  r.cmds = r.cmds.slice(-6)
  if (!r.todos.length) r.todos = [...tasks.values()]
  return r
}

function git(cwd: string, ...args: string[]): string {
  try {
    const out = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    return out.status === 0 ? String(out.stdout).trim() : ''
  } catch {
    return ''
  }
}

/** [usd, amount in the display currency, symbol] to re-write `ctx` tokens to the cache. */
function coldCost(ctx: number, model: string | null): [number | null, number | null, string | null] {
  try {
    const c = loadCfg()
    const usd = usageCostUsd({ cache_creation_input_tokens: ctx }, model, c)
    const [, symbol, rate] = currency(c)
    return [usd, usd * rate, symbol]
  } catch {
    return [null, null, null]
  }
}

function trim(s: string, n: number): string {
  const t = s.trim()
  return t.length <= n ? t : t.slice(0, n).trimEnd() + ' ...'
}

const pad2 = (n: number) => String(n).padStart(2, '0')
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('en-US') : '?')

function build(d: Obj, path: string, sid: string, reason: string): [string, Digest, number] {
  const r = digest(path)
  const cwd = d.cwd || ''
  const [, amount, symbol] = coldCost(r.ctx, r.model)
  const lines = [`# Doggybag: session ${sid}`,
    `Written ${stamp()} (${reason}). Folder: ${cwd || 'unknown'}. Model: ${r.model || 'unknown'}.`, '']
  const body: string[] = []
  if (cwd) {
    const branch = git(cwd, 'branch', '--show-current') || git(cwd, 'rev-parse', '--short', 'HEAD')
    const status = git(cwd, 'status', '--porcelain')
    const recent = git(cwd, 'log', '--oneline', '-5')
    if (branch) {
      const sl = status ? status.split('\n') : []
      body.push('## Git', `- branch \`${branch}\`, ${sl.length} uncommitted change(s)`)
      body.push(...sl.slice(0, 12).map((x) => `  - \`${x}\``), ...(sl.length > 12 ? ['  - ...'] : []))
      body.push(...(recent ? recent.split('\n') : []).map((x) => `- recent: \`${x}\``))
      body.push('')
    }
  }
  if (r.todos.length) body.push('## Tasks', ...r.todos.map(([c, s]) => `- [${s === 'completed' ? 'x' : ' '}] ${c} (${s})`), '')
  if (r.prompts.length) body.push('## Recent requests (oldest first)', ...r.prompts.map((p) => `- ${trim(p, 400)}`), '')
  if (r.reply) body.push('## Last reply', trim(r.reply, 1500), '')
  if (r.files.length) body.push('## Files edited', ...r.files.map((x) => `- \`${x}\``), '')
  if (r.cmds.length) body.push('## Recent commands', ...r.cmds.map((x) => `- \`${x}\``), '')
  const textEst = Math.max(1, Math.floor(body.reduce((a, x) => a + x.length, 0) / 4))
  const cost = amount !== null ? `, about ${symbol}${fmt(amount, 2)} at the cache-write rate (estimate)` : ''
  lines.push(`Rebuilding this session's full context on resume = about ${fmt(r.ctx)} tokens${cost}. ` +
    `This file is about ${fmt(textEst)} tokens.`, '')
  lines.push(...body)
  lines.push('## How to carry on',
    '- Cheap: `/clear` (or start a new session) in this folder; tokenomics loads this doggybag for you. ' +
    `Or say: Continue from @${show(join(bagDir(cwd), LATEST), cwd)}`,
    `- Full: \`claude --resume ${sid}\` (re-reads the whole context; the cache is cold or about to be)`, '')
  return [lines.join('\n'), r, textEst]
}

export type Meta = { session_id: string, cwd: string, source: string, reason: string, written: number,
  cache_ts: number | null, ttl: number, ctx_tokens: number, handoff_tokens: number, model: string | null, path: string }

/** Write the doggybag for this session; returns its metadata (or null without a transcript). */
export function pack(d: Obj, source: string, reason: string): Meta | null {
  const path = resolveTranscript(d, source)
  if (!path) return null
  const sid = sessionId(d)
  const cwd = d.cwd || ''
  const [lastTs, ttl] = cacheClock(path)
  const [text, r, est] = build(d, path, sid, reason)
  const outDir = bagDir(cwd, true)
  const out = join(outDir, safe(sid) + '.md')
  const tmp = join(outDir, safe(sid) + '.tmp')
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, out)
  try {
    copyFileSync(out, join(outDir, LATEST))
  } catch {
    // latest.md is a convenience
  }
  const meta: Meta = { session_id: sid, cwd, source, reason, written: nowS(), cache_ts: lastTs, ttl, ctx_tokens: r.ctx,
    handoff_tokens: est, model: r.model, path: out }
  writeFileSync(join(outDir, safe(sid) + '.json'), JSON.stringify(meta), 'utf8')
  logDb(meta)
  prune(outDir)
  return meta
}

function logDb(m: Meta): void {
  try {
    withDb(defaultDbPath(), (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS handoff_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT, reason TEXT,
        ttl INTEGER, context_tokens INTEGER, handoff_tokens INTEGER, path TEXT)`)
      db.run('INSERT INTO handoff_events(session_id,ts,reason,ttl,context_tokens,handoff_tokens,path) VALUES(?,?,?,?,?,?,?)',
        m.session_id, now(), m.reason, m.ttl, m.ctx_tokens, m.handoff_tokens, m.path)
    })
  } catch {
    // the doggybag itself is what matters
  }
}

function prune(outDir: string): void {
  try {
    const files = readdirSync(outDir).filter((f) => f.endsWith('.md') && f !== LATEST).map((f) => join(outDir, f))
      .sort((a, b) => mtime(b) - mtime(a))
    for (const p of files.slice(cfg.keep())) {
      for (const q of [p, p.replace(/\.md$/, '.json'), p.replace(/\.md$/, '.job')]) {
        try {
          unlinkSync(q)
        } catch {
          // not there
        }
      }
    }
  } catch {
    // pruning is best effort
  }
}

// ------------------------------------------------------------------ watcher ----------------

function currentMeta(sid: string, cwd: string): Meta | null {
  try {
    return JSON.parse(readFileSync(join(bagDir(cwd), safe(sid) + '.json'), 'utf8'))
  } catch {
    return null
  }
}

function arm(d: Obj, source: string): void {
  const path = resolveTranscript(d, source)
  if (!path) return
  const sid = sessionId(d)
  const token = randomUUID().replaceAll('-', '')
  const job = join(bagDir(d.cwd || '', true), safe(sid) + '.job')
  writeFileSync(job, JSON.stringify({ token, d: { session_id: sid, cwd: d.cwd ?? null, transcript_path: path }, source,
    started: nowS() }), 'utf8')
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', SELF, 'watch', job, token],
    { stdio: 'ignore', detached: true, windowsHide: true }).unref()
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000))

async function watch(jobfile: string, token: string): Promise<void> {
  const started = nowS()
  for (;;) {
    let job: Obj
    try {
      job = JSON.parse(readFileSync(jobfile, 'utf8'))
    } catch {
      return
    }
    if (job.token !== token) return                       // a newer watcher (or `end`) replaced this one
    const d: Obj = job.d
    const source = job.source || 'claude-code'
    const path = resolveTranscript(d, source)
    if (!path) return
    const [last, ttl] = cacheClock(path)
    if (last === null) return
    const due = last + ttl - cfg.lead()
    if (nowS() >= due) {
      pack(d, source, nowS() >= last + ttl ? 'cache-expired' : 'cache-expiring')
      return
    }
    if (nowS() - started > 3600 + 900) return               // never linger
    await sleep(Math.max(1, Math.min(due - nowS(), 20)) + 0.5)
  }
}

function end(d: Obj, source: string): void {
  const sid = sessionId(d)
  try {
    unlinkSync(join(bagDir(d.cwd || ''), safe(sid) + '.job'))   // invalidates the watcher's token
  } catch {
    // no watcher
  }
  const path = resolveTranscript(d, source)
  if (!path) return
  const [last] = cacheClock(path)
  const meta = currentMeta(sid, d.cwd || '')
  if (meta && last && meta.cache_ts === last) return          // already packed for the latest activity
  pack(d, source, 'session-end')
}

// ------------------------------------------------------------------ session start ----------

function newestOther(cwd: string, me: string): Meta | null {
  let best: Meta | null = null
  const dir = bagDir(cwd)
  let files: string[] = []
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'))
  } catch {
    return null
  }
  for (const f of files) {
    let m: Meta
    try {
      m = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    } catch {
      continue
    }
    if (!isObj(m) || m.cwd !== cwd || m.session_id === me) continue
    if (nowS() - (m.written || 0) > cfg.maxAgeH() * 3600) continue
    if (!best || (m.written || 0) > (best.written || 0)) best = m
  }
  return best && isFile(best.path || '') ? best : null
}

/** SessionStart: a new session or /clear in a folder with a recent doggybag picks it up. */
export function start(d: Obj): Obj | null {
  const cwd = d.cwd || ''
  if (!cwd || !['startup', 'clear'].includes(d.source || 'startup')) return null
  const best = newestOther(cwd, sessionId(d))
  if (!best) return null
  const where = show(best.path, cwd)
  const sizes = `about ${n(best.handoff_tokens)} tokens vs ${n(best.ctx_tokens)} to resume it in full`
  if (cfg.inject()) {
    const ctx = '[tokenomics doggybag] The previous session in this folder left this note of where it got to. ' +
      "Use it to carry on; don't repeat finished work, and re-read files before editing them.\n\n" + readFileSync(best.path, 'utf8')
    return { systemMessage: `doggybag: carried on from ${where} (${sizes}).`,
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }
  }
  return { systemMessage: `doggybag: a recent session in this folder left ${where} (${sizes}). ` +
    `Say 'Continue from @${where}' to pick it up cheaply.` }
}

// ------------------------------------------------------------------ cold prompt ------------

/** UserPromptSubmit: the user came back after the cache expired. Make sure the doggybag is packed
 *  (the watcher may have died with a sleeping laptop) and say how to carry on cheaply. */
export function prompt(d: Obj, source: string): Obj | null {
  const coldMode = cfg.coldMode()
  if (coldMode === 'off') return null
  const text = String(d.prompt || '').trim()
  if (!text || text.startsWith('/')) return null
  const path = resolveTranscript(d, source)
  if (!path) return null
  const [last, ttl] = cacheClock(path)
  if (last === null || nowS() < last + ttl) return null        // cache still warm: nothing to say
  const sid = sessionId(d)
  const cwd = d.cwd || ''
  let meta = currentMeta(sid, cwd)
  if (!(meta && meta.cache_ts === last && isFile(meta.path || ''))) meta = pack(d, source, 'cache-expired')
  if (!meta || (meta.ctx_tokens || 0) < cfg.coldMinTokens()) return null
  const [, amount, symbol] = coldCost(meta.ctx_tokens, meta.model)
  const cost = amount !== null ? ` (about ${symbol}${fmt(amount, 2)})` : ''
  const where = show(join(bagDir(cwd), LATEST), cwd)
  const mins = Math.floor((nowS() - last) / 60)
  const msg = `doggybag: the prompt cache went cold ${mins} min ago, so this prompt re-writes about ` +
    `${n(meta.ctx_tokens)} tokens${cost}. Cheaper: /clear and your doggybag ` +
    `(${n(meta.handoff_tokens)} tokens, ${where}) loads automatically.`
  if (coldMode === 'block') {
    const key = sha1(`${sid}:${last}`)
    const st = join(bagDir(cwd), '.cold-state.json')
    let seen: string[] = []
    try {
      seen = JSON.parse(readFileSync(st, 'utf8'))
      if (!Array.isArray(seen)) seen = []
    } catch {
      seen = []
    }
    if (!seen.includes(key)) {
      try {
        writeFileSync(st, JSON.stringify([...seen, key].slice(-50)), 'utf8')
      } catch {
        // pause anyway, once
      }
      return { decision: 'block', reason: msg + ' Send your prompt again to carry on here anyway.' }
    }
  }
  return { systemMessage: msg }
}

/** Newest Claude Code transcript for `cwd` (for a manual `write` run from a terminal). */
function guessTranscript(cwd: string): string | null {
  const base = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'projects')
  const folder = join(base, resolve(cwd).replace(/[^A-Za-z0-9]/g, '-'))
  return isDir(folder) ? newestJsonl(folder) : null
}

async function main(argv: string[]): Promise<number> {
  const mode = argv[0] ?? 'arm'
  try {
    if (mode === 'watch') {
      await watch(argv[1], argv[2])
      return 0
    }
    if (!cfg.enabled()) return 0
    const source = argv[1] ?? 'claude-code'
    const raw = readStdin()
    let d: Obj = {}
    try {
      const v = raw.trim() ? JSON.parse(raw) : {}
      d = isObj(v) ? v : {}
    } catch {
      d = {}
    }
    if (mode === 'write' && !Object.keys(d).length) {
      const t = guessTranscript(process.cwd())
      d = { cwd: process.cwd(), transcript_path: t ?? '', session_id: t ? basename(t, '.jsonl') : null }
    }
    let out: Obj | null = null
    if (mode === 'arm') arm(d, source)
    else if (mode === 'end') end(d, source)
    else if (mode === 'write') {
      const m = pack(d, source, 'manual')
      process.stdout.write((m ? m.path : 'doggybag: no transcript found for this folder') + '\n')
    } else if (mode === 'start') out = start(d)
    else if (mode === 'prompt') out = prompt(d, source)
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(defaultDbPath(), `doggybag ${mode}\n${errText(e)}`)
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
