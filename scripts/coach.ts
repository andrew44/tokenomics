#!/usr/bin/env node
/**
 * coach: analyse a Claude Code session's prompts and prompt-cache usage.
 *
 * Usage:
 *   coach.ts                    # newest transcript for the current directory
 *   coach.ts --session <id>     # a specific session
 *   coach.ts --transcript <p>   # a specific .jsonl
 *   coach.ts --json             # machine-readable output
 * Read-only: never modifies the transcript or the database.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { score as opexCapexScore } from '../tokenomics/engine/classifier.ts'   // the shared opex/capex scorer
import { argValue, fmt, int, isMain, isObj, parseTs, type Obj } from '../tokenomics/util.ts'

const CACHE_TTL_S = 300          // default 5-minute prompt-cache TTL
const BIG_CTX = 100_000          // tokens: context size worth a /compact or /clear
const REBUILD_MIN = 10_000       // cache_creation tokens below this are not "rebuilds"
const CORRECTION_RE = new RegExp(String.raw`^\s*(no\b|nope|actually|wait\b|that'?s (not|wrong)|still\b|you (didn'?t|missed|forgot)|` +
  String.raw`why did you|undo|revert|not what|try again|that didn'?t)`, 'i')
const NOT_PROMPT = ['<command-', '<system-reminder', '<local-command', '<user-prompt-submit-hook', 'Caveat:']

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function jsonl(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f))
  } catch {
    return []
  }
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

export function findTranscript(a: { transcript?: string | null, session?: string | null }): string | null {
  if (a.transcript) return a.transcript
  const base = join(homedir(), '.claude', 'projects')
  if (a.session) {
    for (const d of subdirs(base)) {
      const p = join(d, `${a.session}.jsonl`)
      if (mtime(p)) return p
    }
    return null
  }
  const munged = process.cwd().replace(/[^A-Za-z0-9]/g, '-')
  let files = jsonl(join(base, munged))
  if (!files.length) files = subdirs(base).flatMap(jsonl)
  return files.length ? files.reduce((a, b) => (mtime(b) > mtime(a) ? b : a)) : null
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((p) => isObj(p) && p.type === 'text').map((p) => p.text ?? '').join(' ')
  return ''
}

function sizeOf(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) {
    return content.reduce((n: number, p) => n + (isObj(p) ? String(p.text ?? '').length : String(p).length), 0)
  }
  return String(content ?? 'None').length
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

export function analyse(path: string): Obj {
  const turns = new Map<unknown, [number | null, Obj, string | null]>()
  const prompts: string[] = []
  const toolNames = new Map<unknown, string>()
  const results: [string, number][] = []
  const reads = new Map<string, number>()
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
    const t = parseTs(ev.timestamp)
    if (kind === 'assistant') {
      if (isObj(msg.usage)) turns.set(msg.id || ev.uuid || turns.size, [t, msg.usage, msg.model ?? null])
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (isObj(part) && part.type === 'tool_use') {
          toolNames.set(part.id, part.name)
          const inp: Obj = isObj(part.input) ? part.input : {}
          if (part.name === 'Read' && inp.file_path) reads.set(inp.file_path, (reads.get(inp.file_path) ?? 0) + 1)
        }
      }
    } else if (kind === 'user' && !ev.isMeta) {
      const content = msg.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (isObj(part) && part.type === 'tool_result') results.push([toolNames.get(part.tool_use_id) ?? '?', sizeOf(part.content)])
        }
      }
      const txt = textOf(content).trim()
      if (txt && !NOT_PROMPT.some((p) => txt.startsWith(p))) prompts.push(txt)
    }
  }

  const rows = [...turns.values()].map(([t, u, model]) => {
    const i = int(u.input_tokens)
    const cc = int(u.cache_creation_input_tokens)
    const cr = int(u.cache_read_input_tokens)
    return { t, in: i, out: int(u.output_tokens), cc, cr, ctx: i + cc + cr, model }
  })
  rows.sort((a, b) => (a.t || 0) - (b.t || 0))

  const tot = { in: 0, out: 0, cc: 0, cr: 0 }
  for (const r of rows) {
    tot.in += r.in
    tot.out += r.out
    tot.cc += r.cc
    tot.cr += r.cr
  }
  const denom = tot.in + tot.cc + tot.cr
  const hit = denom ? tot.cr / denom : null

  const rebuilds: { tokens: number, reason: string }[] = []
  let prev: typeof rows[number] | null = null
  for (const r of rows) {
    if (prev && r.cc >= REBUILD_MIN && r.cc > 0.5 * r.ctx) {
      const gap = r.t && prev.t ? r.t - prev.t : null
      let why: string
      if (gap !== null && gap > CACHE_TTL_S) why = `idle ${Math.floor(gap / 60)} min (cache expired)`
      else if (prev.model && r.model && prev.model !== r.model) why = `model switched ${prev.model} -> ${r.model}`
      else why = 'prefix changed (system/tool/CLAUDE.md/MCP change or earlier-context edit)'
      rebuilds.push({ tokens: r.cc, reason: why })
    }
    prev = r
  }

  const words = (s: string) => s.split(/\s+/).filter(Boolean).length
  const vague = prompts.filter((p) => words(p) <= 4 && !/[/\\.]\w|`/.test(p)).map((p) => p.slice(0, 60))
  const corrections = prompts.filter((p) => CORRECTION_RE.test(p)).map((p) => p.slice(0, 60))
  const long = prompts.filter((p) => p.length > 4000).map((p) => [Math.floor(p.length / 4), p.slice(0, 60)])
  const seen = new Map<string, number>()
  for (const p of prompts) {
    const k = p.toLowerCase().replace(/\s+/g, ' ')
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  const dup = [...seen].filter(([, n]) => n > 1).map(([p]) => p.slice(0, 60))
  const side: Record<string, number> = {}
  for (const p of prompts) {
    const [o, c] = opexCapexScore(p)
    if (o > c) side.opex = (side.opex ?? 0) + 1
    else if (c > o) side.capex = (side.capex ?? 0) + 1
  }
  const big = [...results].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const peak = rows.reduce((m, r) => Math.max(m, r.ctx), 0)
  const flags: string[] = []
  if (hit !== null && hit < 0.6 && rows.length >= 5) flags.push('low_cache_hit_ratio')
  if (rebuilds.length) flags.push('cache_rebuilds')
  if (rows.length && peak > BIG_CTX) flags.push('large_context')
  if (prompts.length && vague.length / prompts.length >= 0.25) flags.push('vague_prompts')
  if (prompts.length && corrections.length / prompts.length >= 0.2) flags.push('many_corrections')
  if (long.length) flags.push('large_pasted_prompts')
  if (dup.length) flags.push('repeated_prompts')
  if ((side.opex ?? 0) >= 2 && (side.capex ?? 0) >= 2) flags.push('mixed_topics_in_one_session')
  if ([...reads.values()].some((n) => n >= 3)) flags.push('repeated_file_reads')
  if (big.length && big[0][1] > 40_000) flags.push('huge_tool_results')
  if (new Set(rows.map((r) => r.model).filter(Boolean)).size > 1) flags.push('model_switched')
  return {
    transcript: path, turns: rows.length, prompts: prompts.length,
    tokens: { input: tot.in, output: tot.out, cache_creation: tot.cc, cache_read: tot.cr },
    cache_hit_ratio: hit === null ? null : round(hit, 3),
    peak_context_tokens: peak,
    cache_rebuilds: rebuilds, wasted_rebuild_tokens: rebuilds.reduce((n, r) => n + r.tokens, 0),
    prompt_stats: {
      avg_words: prompts.length ? round(prompts.reduce((n, p) => n + words(p), 0) / prompts.length, 1) : 0,
      vague: vague.slice(0, 5), corrections: corrections.slice(0, 5), large_pastes_tokens: long.slice(0, 5),
      repeated: dup.slice(0, 5), leaning: side },
    repeated_reads: Object.fromEntries([...reads].filter(([, v]) => v >= 3)),
    biggest_tool_results: big.map(([n, c]) => ({ tool: n, approx_tokens: Math.floor(c / 4) })),
    flags,
  }
}

function main(args: string[]): number {
  const p = findTranscript({ transcript: argValue(args, '--transcript'), session: argValue(args, '--session') })
  if (!p || !mtime(p) || !statSync(p).isFile()) {
    process.stderr.write('No transcript found. Pass --transcript <file.jsonl> or --session <id>.\n')
    return 1
  }
  const r = analyse(p)
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n')
    return 0
  }
  const t = r.tokens
  const out = [
    `Transcript: ${r.transcript}\nTurns: ${r.turns}  Prompts: ${r.prompts}  Peak context: ${fmt(r.peak_context_tokens)} tokens`,
    `Tokens  in=${fmt(t.input)} out=${fmt(t.output)} cache_write=${fmt(t.cache_creation)} cache_read=${fmt(t.cache_read)}`,
    `Cache hit ratio: ${r.cache_hit_ratio ?? 'None'}`,
    ...r.cache_rebuilds.map((b: Obj) => `  rebuild ${fmt(b.tokens)} tok: ${b.reason}`),
    `Prompt stats: ${JSON.stringify(r.prompt_stats)}`,
    `Repeated reads: ${JSON.stringify(r.repeated_reads)}`,
    `Biggest tool results: ${JSON.stringify(r.biggest_tool_results)}`,
    `FLAGS: ${r.flags.join(', ') || 'none'}`,
  ]
  process.stdout.write(out.join('\n') + '\n')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
