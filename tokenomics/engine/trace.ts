/**
 * Trace: what an agent actually did in a session, read from a Claude Code transcript (JSONL).
 *
 * Shared by the helpers that look at behaviour rather than just totals: bangforbuck (outcomes),
 * sherlock (forensics), groundhog (loops), haggle (spend since a contract started) and tastetest.
 * Platform-specific only in the file format; everything downstream works on Steps and Turns.
 *
 * Streamed assistant messages repeat their id with one content block per record, and usage is
 * repeated on each: tool calls are taken from every record, usage once per message id (last wins).
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'

import { int, isObj, parseTs, sha1, type Obj } from '../util.ts'
import { tokenUsage, type TokenUsage } from './evidence.ts'
import { usageCostUsd } from './pricing.ts'

export type Step = {
  id: string
  name: string
  input: Obj
  ts: number | null
  turn: number                 // index into Trace.turns of the message that made the call
  resultText: string
  resultChars: number
  isError: boolean | null      // null = no result seen (yet)
  sidechain: boolean           // made inside a subagent
  key: string                  // name + input, hashed: identical calls share a key
  agent: string                // 'main', or the subagent type that made the call
}

export type Turn = {
  id: string
  ts: number | null
  model: string
  usage: TokenUsage
  ctx: number                  // context size of this request: input + cache write + cache read
  costUsd: number
  text: string                 // the assistant's prose in this message
  sidechain: boolean           // made inside a subagent
  agent: string                // 'main', or the subagent type (Task/Agent subagent_type) it ran for
  latency: number | null       // seconds from the request's input (prompt or tool result) to the first reply record
}

export type UserPrompt = { text: string, ts: number | null, turn: number }

export type Trace = {
  path: string
  sessionId: string | null
  cwd: string | null
  steps: Step[]
  turns: Turn[]
  prompts: UserPrompt[]
  bytes: number                // offset just after the last complete line read (to resume from)
  apiErrors: Record<string, number>   // API error messages (overloaded, rate limited ...) per model
  interrupts: number[]         // turn index at each "[Request interrupted by user]"
}

const NOT_PROMPT = ['<command-', '<system-reminder', '<local-command', '<user-prompt-submit-hook', 'Caveat:', '[Request interrupted']

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((p) => (isObj(p) ? (p.type === 'text' ? String(p.text ?? '') : '') : String(p))).join('\n')
  }
  return ''
}

/** Text of a tool_result's content (string, or a list of text/image parts). */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((p) => (isObj(p) ? String(p.text ?? '') : String(p))).join('\n')
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

function toUsage(u: Obj): TokenUsage {
  const cc = isObj(u.cache_creation) ? u.cache_creation : {}
  return tokenUsage({ inputTokens: int(u.input_tokens), outputTokens: int(u.output_tokens),
    cacheCreationTokens: int(u.cache_creation_input_tokens), cacheReadTokens: int(u.cache_read_input_tokens),
    cacheCreation1hTokens: int(cc.ephemeral_1h_input_tokens), fast: u.speed === 'fast' })
}

/** A stable key for "the same call": tool name plus its input with keys sorted. */
export function callKey(name: string, input: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]))
    return v
  }
  return sha1(`${name}\u0000${JSON.stringify(norm(input ?? {}))}`).slice(0, 16)
}

/** Complete lines of a file from byte `from` (or only its last `tail` bytes). A line cut by the start
 *  is dropped, and so is an unfinished last line (still being written). Returns [text, end], where
 *  end is the byte offset just after the last complete line: pass it as `from` to read on later. */
export function readText(path: string, opts: { from?: number, tail?: number } = {}): [string, number] {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    let start = Math.max(0, Math.min(opts.from ?? 0, size))
    if (opts.tail !== undefined) start = Math.max(start, size - opts.tail)
    const lead = start > 0 ? 1 : 0                     // one byte before: was `start` already a line start?
    const buf = Buffer.alloc(size - start + lead)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start - lead + got)
      if (n <= 0) break
      got += n
    }
    let from = 0
    if (lead) {
      const nl = buf.indexOf(10)
      if (nl < 0 || nl >= got) return ['', start]
      from = nl + 1                                    // 0 + 1 when the byte before `start` was a newline
    }
    const last = buf.lastIndexOf(10, got - 1)
    if (last < from) return ['', start - lead + from]
    return [buf.subarray(from, last + 1).toString('utf8'), start - lead + last + 1]
  } finally {
    closeSync(fd)
  }
}

/** Parse a transcript (or part of it: `from` a byte offset, or only the last `tail` bytes). */
export function parse(path: string, opts: { from?: number, tail?: number, config?: Obj } = {}): Trace {
  const [text, size] = readText(path, opts)
  return parseText(text, path, size, opts.config)
}

export function parseText(text: string, path = '', size = text.length, config?: Obj): Trace {
  const trace: Trace = { path, sessionId: null, cwd: null, steps: [], turns: [], prompts: [], bytes: size, apiErrors: {}, interrupts: [] }
  const turnIndex = new Map<string, number>()
  const byToolId = new Map<string, Step>()
  const openAgents: Step[] = []           // Task/Agent calls still running: sidechain turns belong to the newest
  let lastInput: number | null = null     // when the last prompt or tool result arrived
  const agentOf = (sidechain: boolean) => {
    if (!sidechain) return 'main'
    const a = openAgents[openAgents.length - 1]
    return a ? String(a.input.subagent_type || a.input.description || 'subagent').slice(0, 60) : 'subagent'
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev: Obj
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(ev)) continue
    if (!trace.sessionId && ev.sessionId) trace.sessionId = String(ev.sessionId)
    if (!trace.cwd && ev.cwd) trace.cwd = String(ev.cwd)
    const msg: Obj = isObj(ev.message) ? ev.message : {}
    const ts = parseTs(ev.timestamp)
    const sidechain = Boolean(ev.isSidechain)
    if (ev.type === 'assistant' && ev.isApiErrorMessage) {
      const last = trace.turns.at(-1)?.model || 'unknown'
      trace.apiErrors[last] = (trace.apiErrors[last] ?? 0) + 1
      continue
    }
    if (ev.type === 'assistant') {
      const id = String(msg.id || ev.uuid || `t${trace.turns.length}`)
      let ti = turnIndex.get(id)
      if (ti === undefined) {
        ti = trace.turns.length
        turnIndex.set(id, ti)
        const latency = ts !== null && lastInput !== null && ts >= lastInput ? Math.round((ts - lastInput) * 10) / 10 : null
        trace.turns.push({ id, ts, model: '', usage: tokenUsage(), ctx: 0, costUsd: 0, text: '', sidechain, agent: agentOf(sidechain), latency })
      }
      const turn = trace.turns[ti]
      if (msg.model && !String(msg.model).startsWith('<')) turn.model = String(msg.model)
      if (isObj(msg.usage)) {
        turn.usage = toUsage(msg.usage)
        turn.ctx = turn.usage.inputTokens + turn.usage.cacheCreationTokens + turn.usage.cacheReadTokens
      }
      for (const part of Array.isArray(msg.content) ? msg.content : []) {
        if (!isObj(part)) continue
        if (part.type === 'text' && part.text) turn.text += (turn.text ? '\n' : '') + String(part.text)
        if (part.type === 'tool_use') {
          const input: Obj = isObj(part.input) ? part.input : {}
          const step: Step = { id: String(part.id ?? `s${trace.steps.length}`), name: String(part.name ?? ''), input, ts,
            turn: ti, resultText: '', resultChars: 0, isError: null, sidechain, key: callKey(String(part.name ?? ''), input),
            agent: turn.agent }
          trace.steps.push(step)
          byToolId.set(step.id, step)
          if (AGENT_TOOLS.has(step.name) && !sidechain) openAgents.push(step)
        }
      }
    } else if (ev.type === 'user') {
      const content = msg.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (!(isObj(part) && part.type === 'tool_result')) continue
          const step = byToolId.get(String(part.tool_use_id))
          if (!step) continue
          step.resultText = resultText(part.content)
          step.resultChars = step.resultText.length
          step.isError = Boolean(part.is_error) || /^\s*<tool_use_error>/.test(step.resultText)
          const at = openAgents.indexOf(step)
          if (at >= 0) openAgents.splice(at, 1)
        }
      }
      if (ts !== null) lastInput = ts
      if (ev.isMeta || sidechain) continue
      const txt = textOf(content).trim()
      if (txt.startsWith('[Request interrupted')) trace.interrupts.push(Math.max(0, trace.turns.length - 1))
      if (txt && !NOT_PROMPT.some((p) => txt.startsWith(p))) trace.prompts.push({ text: txt, ts, turn: trace.turns.length })
    }
  }
  for (const t of trace.turns) t.costUsd = usageCostUsd(t.usage, t.model, config)
  return trace
}

export function costUsd(t: Trace): number {
  return t.turns.reduce((a, x) => a + x.costUsd, 0)
}

export function peakContext(t: Trace): number {
  return t.turns.reduce((m, x) => Math.max(m, x.ctx), 0)
}

export function lastModel(t: Trace): string | null {
  for (let i = t.turns.length - 1; i >= 0; i--) if (t.turns[i].model) return t.turns[i].model
  return null
}

/** Rough token count of some text (about 4 characters a token). */
export const approxTokens = (chars: number) => Math.ceil(chars / 4)

/** The shell command of a step ('' for other tools). */
export function command(s: Step): string {
  return s.name === 'Bash' || s.name === 'bash' || s.name === 'shell' ? String(s.input.command ?? '') : ''
}

/** File path a step touches ('' when none). */
export function filePath(s: Step): string {
  return String(s.input.file_path ?? s.input.path ?? s.input.notebook_path ?? '')
}

export const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit', 'create', 'write'])
export const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch', 'grep', 'glob', 'search', 'ToolSearch'])
export const AGENT_TOOLS = new Set(['Task', 'Agent'])
