#!/usr/bin/env node
/**
 * tokenomics / springclean: a context hygiene audit. Instruction files are sent with every
 * request of every session, so a stale line costs money for months. springclean treats context
 * as something to maintain, not a pile that only grows, and finds:
 *
 *   oversized       instruction files (and the startup total) bigger than they need to be
 *   duplicate       the same instruction in CLAUDE.md, AGENTS.md, copilot-instructions.md ...
 *   outdated        paths that no longer exist, npm/make commands that are no longer defined
 *   bloat           changelogs, long code blocks and big tables that belong in docs
 *   contradiction   instructions that disagree ("always use npm" / "use pnpm")
 *   startup         nested files, imports and MCP servers that load before any work starts
 *
 * and proposes a cleanup with the tokens and money each step saves (priced on your own sessions
 * per month from the ledger, or typical defaults). Read-only: it never edits anything.
 *
 *   springclean.ts [--dir PATH] [--json] [--currency USD]
 *
 * Env: TOKENOMICS_SPRINGCLEAN_MAX  tokens one instruction file should stay under (default 1500)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { defaultDbPath } from '../tokenomics/config.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import { ratesFor } from '../tokenomics/engine/pricing.ts'
import { argValue, isMain, today, type Obj } from '../tokenomics/util.ts'

const tokens = (s: string) => Math.ceil(s.length / 4)
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.venv', 'venv', 'target', '.next', 'coverage'])
const STOP = new Set(('a an the and or of to in on for with by is are be it this that these those you your we our as at from ' +
  'when if then than so do not dont never always must should use using prefer avoid make sure all any each its into only ' +
  'can will may also via per just please').split(' '))

export type Doc = { path: string, rel: string, tokens: number, lines: string[], startup: boolean, loads: string }
export type Finding = { kind: string, file: string, line?: number, detail: string, tokens: number, action: string }

function read(p: string): string | null {
  try {
    return statSync(p).isFile() ? readFileSync(p, 'utf8') : null
  } catch {
    return null
  }
}

function nested(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 3) return out
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
      for (const n of ['CLAUDE.md', 'AGENTS.md']) if (existsSync(join(dir, e.name, n))) out.push(join(dir, e.name, n))
      nested(join(dir, e.name), depth + 1, out)
    }
  }
  return out
}

export function collect(dir: string, home = homedir()): Doc[] {
  const docs: Doc[] = []
  const add = (path: string, startup: boolean, loads: string) => {
    if (docs.some((d) => d.path === path)) return
    const text = read(path)
    if (text === null) return
    docs.push({ path, rel: path.startsWith(dir) ? relative(dir, path) : path.replace(home, '~'), tokens: tokens(text),
      lines: text.split('\n'), startup, loads })
    for (const m of text.matchAll(/(?:^|\s)@([~\w./-]+\.\w+)/g)) {        // CLAUDE.md imports: @docs/style.md
      const target = m[1].startsWith('~') ? join(home, m[1].slice(1)) : isAbsolute(m[1]) ? m[1] : resolve(dirname(path), m[1])
      if (existsSync(target)) add(target, startup, `imported by ${path.startsWith(dir) ? relative(dir, path) : path}`)
    }
  }
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) add(join(dir, f), true, 'every Claude Code session')
  add(join(home, '.claude', 'CLAUDE.md'), true, 'every Claude Code session, every project')
  add(join(dir, 'AGENTS.md'), true, 'every Copilot / Codex session')
  add(join(dir, '.github', 'copilot-instructions.md'), true, 'every Copilot session')
  for (const f of ['GEMINI.md', '.cursorrules', '.windsurfrules']) add(join(dir, f), true, 'every session of that assistant')
  try {
    for (const f of readdirSync(join(dir, '.cursor', 'rules'))) add(join(dir, '.cursor', 'rules', f), true, 'Cursor rules')
  } catch {
    // none
  }
  for (const p of nested(dir)) add(p, false, 'when working in that folder')
  return docs
}

/** A line as an instruction: bullets and numbering stripped, lower-cased, punctuation dropped. */
const norm = (l: string) => l.toLowerCase().replace(/^\s*([-*+>]|\d+[.)])\s+/, '').replace(/[`*_"'()[\]{}:;,.!?]/g, ' ').replace(/\s+/g, ' ').trim()
const content = (l: string) => new Set(norm(l).split(' ').filter((w) => w.length > 2 && !STOP.has(w)))

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let i = 0
  for (const x of a) if (b.has(x)) i++
  return i / (a.size + b.size - i)
}

const isInstruction = (l: string) => {
  const t = l.trim()
  return t.split(/\s+/).length >= 5 && !t.startsWith('#') && !t.startsWith('|') && !t.startsWith('```') && !/^<!--/.test(t)
}

function codeLines(lines: string[]): boolean[] {
  const inCode = new Array<boolean>(lines.length).fill(false)
  let on = false
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) {
      on = !on
      inCode[i] = true
    } else {
      inCode[i] = on
    }
  })
  return inCode
}

export const NEG = /\b(never|don'?t|do not|avoid|must not|mustn'?t|no longer|stop using|not use)\b/i
const POS = /\b(always|must|use|prefer|should|make sure|run)\b/i
const FAMILIES: [string, RegExp][] = [
  ['package manager', /\b(?:use|run with|install with)\s+(npm|pnpm|yarn|bun)\b/i],
  ['indentation', /\b(tabs|spaces)\b.*\bindent|\bindent\w*\b.*\b(tabs|spaces)\b/i],
  ['quotes', /\b(single|double)\s+quotes\b/i],
  ['python runner', /\b(?:use|run with)\s+(pip|poetry|uv|pipenv|conda)\b/i],
  ['test runner', /\b(?:use|run with|tests? with)\s+(jest|vitest|mocha|pytest|unittest)\b/i],
]

export function audit(dir: string, docs: Doc[], maxTokens = 1500): Finding[] {
  const out: Finding[] = []
  const pkg = (() => {
    try {
      return JSON.parse(read(join(dir, 'package.json')) ?? '{}')
    } catch {
      return {}
    }
  })()
  const scripts = new Set(Object.keys(pkg.scripts ?? {}))
  const make = read(join(dir, 'Makefile'))
  const targets = new Set([...(make ?? '').matchAll(/^([\w.-]+)\s*:/gm)].map((m) => m[1]))

  const startup = docs.filter((d) => d.startup)
  const total = startup.reduce((a, d) => a + d.tokens, 0)
  for (const d of docs) {
    if (d.tokens > maxTokens) {
      out.push({ kind: 'oversized', file: d.rel, detail: `${d.tokens.toLocaleString('en-US')} tokens (aim for under ${maxTokens.toLocaleString('en-US')})`,
        tokens: d.tokens - maxTokens, action: 'Keep the rules the agent needs every time; move background and how-tos into docs it can open when needed.' })
    }
  }

  // duplicates, across and within files
  type Unit = { doc: Doc, line: number, text: string, words: Set<string>, key: string }
  const units: Unit[] = []
  for (const d of docs) {
    const code = codeLines(d.lines)
    d.lines.forEach((l, i) => {
      if (!code[i] && isInstruction(l)) units.push({ doc: d, line: i + 1, text: l.trim(), words: content(l), key: norm(l) })
    })
  }
  const dup = new Set<Unit>()
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i]
      const b = units[j]
      if (dup.has(b) || b.words.size < 3) continue
      if (NEG.test(a.text) !== NEG.test(b.text)) continue        // opposite instructions: a contradiction, not a repeat
      if (a.key === b.key || jaccard(a.words, b.words) >= 0.8) {
        dup.add(b)
        const where = a.doc === b.doc ? `line ${a.line}` : `${a.doc.rel}:${a.line}`
        out.push({ kind: 'duplicate', file: b.doc.rel, line: b.line, detail: `"${b.text.slice(0, 90)}" repeats ${where}`, tokens: tokens(b.text),
          action: a.doc === b.doc ? 'Delete the repeat.' : `Keep it in one file and import or link it from the other (e.g. @${a.doc.rel}).` })
      }
    }
  }

  // outdated references
  for (const d of docs) {
    const base = dirname(d.path)
    d.lines.forEach((l, i) => {
      for (const m of l.matchAll(/`([\w.@~-][\w./@-]*\/[\w./@-]*)`|(?:^|\s)((?:\.\/)?(?:src|lib|scripts|docs|tests?|app|packages|config)\/[\w./-]+)/g)) {
        const ref = (m[1] ?? m[2]).replace(/[.,:;)]+$/, '')
        if (/^(https?:|@|~|\$)|[*{}<>]/.test(ref) || !/\.\w{1,5}$|\/$/.test(ref)) continue
        if (!existsSync(resolve(dir, ref)) && !existsSync(resolve(base, ref))) {
          out.push({ kind: 'outdated', file: d.rel, line: i + 1, detail: `refers to ${ref}, which doesn't exist`, tokens: tokens(l),
            action: 'Update the path, or delete the line if the file is gone.' })
        }
      }
      for (const m of l.matchAll(/\b(?:npm|pnpm|yarn|bun) run\s+([\w:.-]+)|`(?:pnpm|yarn)\s+([\w:.-]+)/g)) {
        const name = m[1] ?? m[2]
        if (Object.keys(pkg).length && !scripts.has(name) && !['install', 'add', 'i', 'ci', 'test', 'exec', 'dlx', 'x', 'remove', 'run', 'init', 'create'].includes(name)) {
          out.push({ kind: 'outdated', file: d.rel, line: i + 1, detail: `\`${m[0].replace(/^`/, '')}\`: no "${name}" script in package.json`, tokens: tokens(l),
            action: 'Fix the command or remove it; an agent following it wastes a turn on the error.' })
        }
      }
      for (const m of l.matchAll(/\bmake\s+([a-z][\w-]*)/g)) {
        if (make !== null && !targets.has(m[1])) {
          out.push({ kind: 'outdated', file: d.rel, line: i + 1, detail: `\`make ${m[1]}\`: no such Makefile target`, tokens: tokens(l),
            action: 'Fix the command or remove it.' })
        }
      }
    })
  }

  // bloat: long code blocks, changelogs, big tables
  for (const d of docs.filter((x) => x.startup)) {
    let start = -1
    let tableRows = 0
    d.lines.forEach((l, i) => {
      if (/^\s*```/.test(l)) {
        if (start < 0) start = i
        else {
          const n = i - start - 1
          if (n > 25) {
            out.push({ kind: 'bloat', file: d.rel, line: start + 1, detail: `${n}-line code block`, tokens: tokens(d.lines.slice(start, i + 1).join('\n')),
              action: 'Move the example to a file and point to it; keep a one-line summary.' })
          }
          start = -1
        }
      }
      tableRows = /^\s*\|/.test(l) ? tableRows + 1 : 0
      if (tableRows === 21) {
        out.push({ kind: 'bloat', file: d.rel, line: i - 19, detail: 'a table of 20+ rows', tokens: tokens(d.lines.slice(i - 20, i + 1).join('\n')),
          action: 'Move reference tables into docs the agent can read on demand.' })
      }
      if (/^#{1,4}\s*(change ?log|history|release notes|what'?s new|past decisions)\b/i.test(l)) {
        let end = d.lines.findIndex((x, k) => k > i && /^#{1,4}\s/.test(x))
        if (end < 0) end = d.lines.length
        out.push({ kind: 'bloat', file: d.rel, line: i + 1, detail: `"${l.trim()}" section (${end - i} lines)`, tokens: tokens(d.lines.slice(i, end).join('\n')),
          action: 'History belongs in git and CHANGELOG.md, not in every request.' })
      }
    })
  }

  // contradictions
  const seenPairs = new Set<string>()
  for (const [family, re] of FAMILIES) {
    const hits = units.map((u) => [u, re.exec(u.text)] as const).filter(([u, m]) => m && !NEG.test(u.text))
    const values = new Map<string, Unit>()
    for (const [u, m] of hits) {
      const v = (m![1] ?? m![2] ?? '').toLowerCase()
      if (v && !values.has(v)) values.set(v, u)
    }
    if (values.size > 1) {
      const [[v1, u1], [v2, u2]] = [...values]
      out.push({ kind: 'contradiction', file: u2.doc.rel, line: u2.line, detail: `${family}: "${v1}" (${u1.doc.rel}:${u1.line}) vs "${v2}" (${u2.doc.rel}:${u2.line})`,
        tokens: 0, action: 'Decide which is right and delete the other; the agent may follow either.' })
    }
  }
  const neg = units.filter((u) => NEG.test(u.text))
  const pos = units.filter((u) => !NEG.test(u.text) && POS.test(u.text))
  for (const n of neg) {
    for (const p of pos) {
      const key = `${n.doc.rel}:${n.line}|${p.doc.rel}:${p.line}`
      if (seenPairs.has(key) || dup.has(p) || dup.has(n) || n.words.size < 2 || p.words.size < 2) continue
      if (jaccard(n.words, p.words) >= 0.6) {
        seenPairs.add(key)
        out.push({ kind: 'contradiction', file: p.doc.rel, line: p.line, detail: `"${p.text.slice(0, 70)}" vs "${n.text.slice(0, 70)}" (${n.doc.rel}:${n.line})`,
          tokens: 0, action: 'Decide which is right and delete the other; the agent may follow either.' })
      }
    }
  }

  // startup load
  if (total > maxTokens * 3) {
    out.push({ kind: 'startup', file: '(all)', detail: `${total.toLocaleString('en-US')} tokens of instructions load before any work starts`,
      tokens: 0, action: 'Trim the largest files first; nested CLAUDE.md files load only when needed, so move folder-specific rules there.' })
  }
  try {
    const mcp = JSON.parse(read(join(dir, '.mcp.json')) ?? '{}')
    const servers = Object.keys(mcp.mcpServers ?? {})
    if (servers.length >= 3) {
      out.push({ kind: 'startup', file: '.mcp.json', detail: `${servers.length} MCP servers (${servers.join(', ')}): each adds its tool definitions to every request`,
        tokens: 0, action: 'Keep project-wide only the servers most sessions use; enable the rest per session.' })
    }
  } catch {
    // no or unreadable .mcp.json
  }
  return out
}

/** Sessions a month, turns per session and the main model, from the ledger (or typical defaults). */
function usage(dbPath: string): { sessions: number, turns: number, model: string, measured: boolean } {
  const fallback = { sessions: 40, turns: 25, model: 'claude-sonnet-5-5', measured: false }
  if (!existsSync(dbPath)) return fallback
  try {
    const rows = withDb(dbPath, (db) => ledger.rows(db, ledger.shiftDay(today(), 29)), { readOnly: true })
    if (rows.length < 3) return fallback
    const models = new Map<string, number>()
    for (const r of rows) if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + r.cost_usd)
    return { sessions: rows.length, turns: Math.round(ledger.mean(rows.map((r) => r.turns))),
      model: [...models].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback.model, measured: true }
  } catch {
    return fallback
  }
}

export function build(dir: string, dbPath = defaultDbPath(), maxTokens = 1500): Obj {
  const docs = collect(dir)
  const findings = audit(dir, docs, maxTokens)
  const u = usage(dbPath)
  const r = ratesFor(u.model)
  const perTokenMonth = u.sessions * (r.cache_write_5m + r.cache_read * u.turns) / 1e6
  const startupDocs = new Set(docs.filter((d) => d.startup).map((d) => d.rel))
  const save = findings.filter((f) => startupDocs.has(f.file) || f.file === '(all)')
  const saveTokens = Math.min(save.reduce((a, f) => a + f.tokens, 0), docs.filter((d) => d.startup).reduce((a, d) => a + d.tokens, 0))
  const [code, symbol, rate] = currency.current()
  return {
    dir, currency: code, symbol,
    files: docs.map((d) => ({ file: d.rel, tokens: d.tokens, loads: d.loads, startup: d.startup })),
    startup_tokens: docs.filter((d) => d.startup).reduce((a, d) => a + d.tokens, 0),
    findings,
    by_kind: Object.fromEntries([...new Set(findings.map((f) => f.kind))].map((k) => [k, findings.filter((f) => f.kind === k).length])),
    savings: { tokens: saveTokens, per_month: Math.round(saveTokens * perTokenMonth * rate * 100) / 100,
      basis: `${u.sessions} sessions a month, ~${u.turns} turns each, on ${u.model}${u.measured ? ' (your last 30 days)' : ' (typical; no history yet)'}` },
  }
}

const KIND_TITLE: Record<string, string> = { oversized: 'Oversized', duplicate: 'Duplicated', outdated: 'Outdated', bloat: 'Bloat',
  contradiction: 'Contradictions', startup: 'Loaded at startup' }

export function markdown(r: Obj): string {
  const m = (v: number) => currency.formatMoney(v, r.symbol)
  const L = ['# springclean: context hygiene audit', '']
  if (!r.files.length) return L.concat(['No instruction files (CLAUDE.md, AGENTS.md, copilot-instructions.md ...) found here.', '']).join('\n')
  L.push(`**${r.startup_tokens.toLocaleString('en-US')} tokens** of instructions load with every session ` +
    `(${r.files.filter((f: Obj) => f.startup).map((f: Obj) => `${f.file} ${f.tokens.toLocaleString('en-US')}`).join(', ')}).`, '')
  if (!r.findings.length) return L.concat(['Nothing to clean: no duplicates, stale references, bloat or contradictions found.', '']).join('\n')
  L.push(`Proposed cleanup saves ~**${r.savings.tokens.toLocaleString('en-US')} tokens per request**, about **${m(r.savings.per_month)} a month** ` +
    `(${r.savings.basis}).`, '')
  for (const kind of Object.keys(KIND_TITLE)) {
    const fs = r.findings.filter((f: Finding) => f.kind === kind)
    if (!fs.length) continue
    L.push(`## ${KIND_TITLE[kind]} (${fs.length})`, '')
    for (const f of fs.slice(0, 8)) {
      L.push(`- \`${f.file}${f.line ? `:${f.line}` : ''}\` ${f.detail}${f.tokens ? ` (~${f.tokens.toLocaleString('en-US')} tokens)` : ''}. ${f.action}`)
    }
    if (fs.length > 8) L.push(`- ... and ${fs.length - 8} more (--json for all)`)
    L.push('')
  }
  return L.join('\n')
}

export function main(args: string[]): number {
  const cur = argValue(args, '--currency')
  if (cur) {
    const c = currency.currencyCode(cur)
    if (!c) {
      process.stderr.write(`unknown currency ${JSON.stringify(cur)}: use GBP, USD or EUR\n`)
      return 2
    }
    process.env.TOKENOMICS_CURRENCY = c
  }
  const max = Number(process.env.TOKENOMICS_SPRINGCLEAN_MAX ?? 1500)
  const r = build(resolve(argValue(args, '--dir') ?? process.cwd()), argValue(args, '--db') ?? defaultDbPath(),
    Number.isFinite(max) && max > 0 ? max : 1500)
  process.stdout.write((args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r)) + '\n')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
