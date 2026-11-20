#!/usr/bin/env node
/**
 * tokenomics / blinkers: keep the agent on the job you asked for. Scope creep costs money twice: the
 * tokens to write the extra change, and the review time to read it. blinkers doesn't tell the agent to
 * write less code; it compares each change with the task and asks before it wanders:
 *
 *   unrequested docs        README / docs edits the task didn't ask for
 *   unrequested tests       new test files the task didn't ask for
 *   dependency changes      package.json, lockfiles, requirements, Cargo.toml, go.mod ...
 *   config changes          CI workflows, Dockerfiles, tsconfig, linters ...
 *   unrelated refactoring   whitespace-only edits, and edits that only rename something
 *   outside the task        a file away from everything the task named
 *   too many files          more files than the task plausibly needs
 *
 * Every request in the session widens the scope (ask for docs later and docs are in scope).
 *
 *   blinkers.ts prompt [source]     hook (UserPromptSubmit / userPromptSubmitted): note what was asked.
 *                                   Only the paths, names and kinds of work it mentions are kept, never the text.
 *   blinkers.ts guard [source]      hook (PreToolUse on edits / preToolUse): judge the change
 *   blinkers.ts check [--session ID | --transcript FILE] [--task "..."] [--json]
 *                                   replay a session: which changes went beyond the request, and their cost
 *   blinkers.ts diff --task "fix the login redirect" [--base main] [--json] [--ci]
 *                                   judge a branch's changed files against a task (PR review, CI)
 *
 * TOKENOMICS_BLINKERS: ask (default: the agent must ask you first; Claude Code shows a confirm prompt,
 * Copilot refuses the call and tells it to ask), block (refuse; the agent must ask in chat), warn (tell
 * you, never stop anything) or off. TOKENOMICS_BLINKERS_FILES: most files a task may change before
 * blinkers asks (default: 3 per named file, at least 6). Say "blinkers off" / "blinkers on" in a prompt to
 * switch it for the session. Each file is asked about once per session. Always exits 0 as a hook.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'

import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb, type Db } from '../tokenomics/engine/db.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { TOOL_CODE_EDIT } from '../tokenomics/engine/evidence.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { CostEngine, InsightsEngine, PolicyEngine, TelemetryEngine } from '../tokenomics/services/index.ts'
import { argValue, asDict, errText, first, isMain, isObj, logErr, now, readPayload, type Obj } from '../tokenomics/util.ts'
import { numArg, write } from './common.ts'

const MODES = ['ask', 'block', 'warn', 'off']
const mode = () => PolicyEngine.mode('TOKENOMICS_BLINKERS', 'ask', MODES)

function ensure(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS blinkers_scope(session_id TEXT PRIMARY KEY, ts TEXT, scope TEXT, enabled INTEGER DEFAULT 1);
    CREATE TABLE IF NOT EXISTS blinkers_touched(session_id TEXT, path TEXT, PRIMARY KEY(session_id, path));`)
}

function loadScope(db: Db, sid: string): { scope: InsightsEngine.TaskScope, enabled: boolean } | null {
  const r = db.get('SELECT scope, enabled FROM blinkers_scope WHERE session_id=?', sid)
  if (!r) return null
  try {
    return { scope: JSON.parse(String(r.scope)), enabled: Boolean(r.enabled) }
  } catch {
    return null
  }
}

/** The prompt hook: widen this session's scope with the new request. */
export function onPrompt(source: string, payload: Obj, dbPath = defaultDbPath()): void {
  const adapter = getAdapter(source)
  const sid = adapter.sessionId(payload)
  const text = String(first(payload, ['prompt', 'userPrompt'], '') ?? '')
  if (!text.trim()) return
  withDb(dbPath, (db) => {
    ensure(db)
    const cur = loadScope(db, sid)
    let enabled = cur?.enabled ?? true
    if (/\bblinkers\s+off\b/i.test(text)) enabled = false
    if (/\bblinkers\s+on\b/i.test(text)) enabled = true
    const scope = cur ? InsightsEngine.mergeScope(cur.scope, InsightsEngine.taskScope(text)) : InsightsEngine.taskScope(text)
    db.run(`INSERT INTO blinkers_scope(session_id, ts, scope, enabled) VALUES(?,?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET ts=excluded.ts, scope=excluded.scope, enabled=excluded.enabled`,
    sid, now(), JSON.stringify(scope), enabled ? 1 : 0)
  })
}

/** The text an edit removes and adds, for Claude Code and Copilot tool inputs. */
export function editTexts(input: Obj): { oldText: string, newText: string } {
  if (Array.isArray(input.edits)) {
    const es = input.edits.filter(isObj)
    return { oldText: es.map((e) => String(e.old_string ?? '')).join('\n'), newText: es.map((e) => String(e.new_string ?? '')).join('\n') }
  }
  return { oldText: String(input.old_string ?? input.old_str ?? input.oldString ?? ''),
    newText: String(input.new_string ?? input.new_str ?? input.newString ?? input.content ?? input.file_text ?? input.new_source ?? '') }
}

/** The pre-tool hook: decide on one edit. Returns the hook output to print (or null). */
export function onTool(source: string, payload: Obj, dbPath = defaultDbPath()): Obj | null {
  const m = mode()
  if (m === 'off') return null
  const adapter = getAdapter(source)
  const call = adapter.toolCall(payload)
  if (!call || call.kind !== TOOL_CODE_EDIT || !call.path) return null
  const sid = adapter.sessionId(payload)
  const cwd = payload.cwd ? String(payload.cwd) : null
  const input = isObj(payload.tool_input) ? payload.tool_input : asDict(first(payload, ['toolArgs', 'toolInput'], {}))
  const rel = TelemetryEngine.relPath(call.path, cwd)
  const abs = isAbsolute(call.path) ? call.path : join(cwd ?? process.cwd(), call.path)
  const created = !existsSync(abs)
  return withDb(dbPath, (db) => {
    ensure(db)
    const s = loadScope(db, sid)
    if (!s || !s.enabled) return null                    // no task seen for this session: nothing to compare with
    const touched = db.all('SELECT path FROM blinkers_touched WHERE session_id=?', sid).map((r) => String(r.path))
    const maxFiles = PolicyEngine.threshold('TOKENOMICS_BLINKERS_FILES', 0, { min: 1 }) || undefined
    const finding = InsightsEngine.judgeChange(s.scope, { path: rel, created, ...editTexts(input) }, touched, { maxFiles })
    const remember = () => db.run('INSERT OR IGNORE INTO blinkers_touched(session_id, path) VALUES(?,?)', sid, rel)
    if (!finding) {
      remember()
      return null
    }
    const before = db.tables().has('blinkers_events')
      ? db.all('SELECT action FROM blinkers_events WHERE session_id=? AND path=?', sid, rel).map((r) => String(r.action)) : []
    const label = InsightsEngine.SCOPE_LABELS[finding.rule] ?? finding.rule
    let action: PolicyEngine.Action
    let message: string
    if (before.length) {                                  // asked once already: the user decided
      remember()
      action = 'allow'
      message = ''
    } else if (m === 'warn') {
      remember()
      action = 'warn'
      message = `blinkers: possible scope creep (${label.toLowerCase()}): ${finding.reason}`
    } else {
      action = m === 'block' ? 'deny' : 'ask'
      message = `blinkers: this looks like more than the task asked for (${label.toLowerCase()}): ${finding.reason} ` +
        'Stay on the requested change. If this really is needed, ask the user before expanding the scope.'
    }
    PolicyEngine.log(dbPath, 'blinkers_events', { session_id: sid, source: adapter.name, tool: call.name, rule: finding.rule, path: rel,
      action: action === 'allow' ? 'allowed' : action === 'warn' ? 'warned' : PolicyEngine.effective(adapter, action) === 'ask' ? 'asked' : 'denied' })
    return PolicyEngine.enforce(adapter, action, message)
  })
}

function hook(kind: 'prompt' | 'guard', source: string): void {
  if (mode() === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    if (kind === 'prompt') onPrompt(source, payload, dbPath)
    else {
      const out = onTool(source, payload, dbPath)
      if (out) process.stdout.write(JSON.stringify(out) + '\n')
    }
  } catch (e) {
    logErr(dbPath, `blinkers\n${errText(e)}`)
  }
}

// ---- after the fact --------------------------------------------------------------------------------

export function check(args: string[]): Obj | null {
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p) return null
  const t = trace.parse(p)
  const task = argValue(args, '--task') ?? undefined
  const r = InsightsEngine.scopeReview(t, { task, maxFiles: argValue(args, '--max-files') ? numArg(args, '--max-files', 6) : undefined })
  return { session_id: t.sessionId || basename(p, '.jsonl'), ...r, share: r.session_usd ? Math.round(r.out_of_scope_usd / r.session_usd * 1000) / 1000 : 0 }
}

export function diff(args: string[], cwd = process.cwd()): Obj {
  const task = argValue(args, '--task') ?? ''
  const base = argValue(args, '--base')
  const git = (...a: string[]) => spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', timeout: 15_000 })
  const range = base ? [`${base}...HEAD`] : ['HEAD']
  const lines = [...git('diff', '--name-status', ...range).stdout.split('\n'), ...(base ? [] : git('status', '--porcelain').stdout.split('\n')
    .filter((l) => l.startsWith('??')).map((l) => `A\t${l.slice(3)}`))].filter(Boolean)
  const scope = InsightsEngine.taskScope(task)
  const touched: string[] = []
  const findings: InsightsEngine.ScopeFinding[] = []
  for (const l of lines) {
    const [st, ...rest] = l.split('\t')
    const path = rest[rest.length - 1]
    if (!path || touched.includes(path)) continue
    const f = InsightsEngine.judgeChange(scope, { path, created: st.startsWith('A'), oldText: '', newText: '' }, touched,
      { maxFiles: argValue(args, '--max-files') ? numArg(args, '--max-files', 6) : undefined })
    if (f) findings.push(f)
    touched.push(path)
  }
  return { task_scope: scope, files_changed: touched.length, findings }
}

function markdown(r: Obj, title: string): string {
  const { fmt } = CostEngine.display()
  const L = [`# blinkers: ${title}`, '']
  if (!r.findings.length) return [...L, `Everything stayed within what was asked (${r.files_changed} files changed).`].join('\n')
  L.push(r.out_of_scope_usd !== undefined
    ? `**${r.findings.length} change${r.findings.length === 1 ? '' : 's'} went beyond the request**, about ${fmt(r.out_of_scope_usd)} of ${fmt(r.session_usd)} (${Math.round(r.share * 100)}%).`
    : `**${r.findings.length} of ${r.files_changed} changed files look beyond the task.**`, '')
  const by: Record<string, Obj[]> = {}
  for (const f of r.findings) (by[f.rule] ??= []).push(f)
  for (const [rule, fs] of Object.entries(by)) {
    L.push(`- **${InsightsEngine.SCOPE_LABELS[rule] ?? rule}** (${fs.length}): ${fs.slice(0, 4).map((f) => `\`${f.path}\``).join(', ')}` +
      `${fs[0].usd !== undefined ? `, about ${fmt(fs.reduce((a, f) => a + f.usd, 0))}` : ''}`)
  }
  L.push('', '_A heuristic: a flagged change may still be right. Ask whether it belonged in this task, or in a separate one._')
  return L.join('\n')
}

export function main(argv: string[]): number {
  const [cmd = 'check', ...rest] = argv
  if (cmd === 'prompt' || cmd === 'guard') {
    hook(cmd, rest[0] ?? 'claude-code')
    return 0
  }
  if (cmd === 'diff') {
    if (!argValue(rest, '--task')) {
      process.stderr.write('Usage: blinkers.ts diff --task "what was asked" [--base main] [--json] [--ci]\n')
      return 2
    }
    const r = diff(rest)
    write(rest.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r, 'changes vs the task'))
    return rest.includes('--ci') && r.findings.length ? 1 : 0
  }
  const args = cmd === 'check' ? rest : argv
  const r = check(args)
  if (!r) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r, `session ${String(r.session_id).slice(0, 8)}`))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
