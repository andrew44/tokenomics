/**
 * Forensics: where an agent's money went that bought nothing. Used by sherlock.
 *
 * Looks at what the agent did, step by step, and finds work that added cost but no information:
 *
 *   repeated_read       the same file (same range) read again with no edit to it in between
 *   redundant_call      the same tool call with the same input and the same result, nothing edited between
 *   repeated_search     a different search that came back with exactly what an earlier one did
 *   unused_result       a big tool result nothing later refers to (probably unused)
 *   overlapping_agents  two subagents sent on largely the same job
 *   needless_agent      a subagent for a one-step lookup a single Read or Grep would have done
 *
 * Every finding carries an estimated cost. A tool result is written into the context once (a
 * cache write) and then re-read on every later request until the context is compacted (cache
 * reads): tokens x (write + reads x later turns), at the model's own rates.
 */
import { isObj, sha1, type Obj } from '../util.ts'
import { ratesFor } from './pricing.ts'
import { AGENT_TOOLS, approxTokens, command, EDIT_TOOLS, filePath, SEARCH_TOOLS, type Step, type Trace } from './trace.ts'

export const SUBAGENT_OVERHEAD_TOKENS = 12_000   // system prompt + tool definitions a fresh subagent loads
const UNUSED_MIN_CHARS = 2_000
const MIN_RESULT_CHARS = 200

export type Finding = {
  kind: string
  tool: string
  detail: string
  times: number
  tokens: number
  usd: number
  why: string
  fix: string
}

export type Investigation = {
  session_cost_usd: number
  wasted_usd: number
  wasted_tokens: number
  share: number
  findings: Finding[]
  by_kind: Record<string, { count: number, usd: number, tokens: number }>
  subagents: number
  tool_calls: number
}

const WHY: Record<string, [string, string]> = {
  repeated_read: ['The file had not changed, so the second read added the same text to the context again.',
    'Refer back to the earlier read, or read only the lines you need (offset/limit).'],
  redundant_call: ['Same call, same input, same answer: the repeat bought no new information.',
    'Reuse the earlier result; only re-run after something has changed.'],
  repeated_search: ['A differently worded search returned exactly the same results as an earlier one.',
    'Check earlier results before searching again; widen or change the search instead of rephrasing it.'],
  unused_result: ['A large result that nothing afterwards refers to: it rode along in the context for no benefit.',
    'Ask for less (head, grep, a narrower path or query) before pulling in big output.'],
  overlapping_agents: ['Two subagents were briefed on largely the same job, so the work was done twice.',
    'Give each subagent a distinct slice of the work, or send one.'],
  needless_agent: ['A subagent loads its own system prompt and tools before doing anything; this one did a single lookup.',
    'Do one-step lookups directly with Read, Grep or Glob.'],
}

/** For each turn, how many later requests re-read its context before a compaction resets it. */
function laterReads(t: Trace): number[] {
  const n = t.turns.length
  const out = new Array<number>(n).fill(0)
  let run = 0
  for (let i = n - 1; i >= 0; i--) {
    out[i] = run
    const prev = i > 0 ? t.turns[i - 1].ctx : 0
    run = prev && t.turns[i].ctx < prev * 0.5 ? 0 : run + 1    // a big drop: compacted or cleared
  }
  return out
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** Distinctive strings from a result: identifiers and paths unlikely to appear by chance. */
function markers(text: string, max = 80): string[] {
  const seen = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_./-]{5,}/g)) {
    const w = m[0].replace(/[./-]+$/, '')
    if (w.length >= 6 && !/^(function|return|import|export|const|string|number|undefined|private|public|static)$/.test(w)) seen.add(w)
    if (seen.size >= 2_000) break
  }
  const all = [...seen]
  const step = Math.max(1, Math.floor(all.length / max))
  return all.filter((_, i) => i % step === 0).slice(0, max)
}

export function investigate(t: Trace, config?: Obj): Investigation {
  const reads = laterReads(t)
  const turnModel = (i: number) => t.turns[i]?.model || t.turns.find((x) => x.model)?.model || ''
  const costOf = (tokens: number, turn: number) => {
    const r = ratesFor(turnModel(turn), config)
    return tokens * (r.cache_write_5m + r.cache_read * (reads[turn] ?? 0)) / 1e6
  }
  const findings: Finding[] = []
  const add = (kind: string, s: Step, detail: string, tokens: number, extraUsd = 0) => {
    const existing = findings.find((f) => f.kind === kind && f.tool === s.name && f.detail === detail)
    const usd = costOf(tokens, s.turn) + extraUsd
    if (existing) {
      existing.times += 1
      existing.tokens += tokens
      existing.usd += usd
      return
    }
    const [why, fix] = WHY[kind]
    findings.push({ kind, tool: s.name, detail, times: 1, tokens, usd, why, fix })
  }

  const steps = t.steps
  const editsAfter = (i: number, j: number, path?: string) => steps.slice(i + 1, j).some((s) =>
    EDIT_TOOLS.has(s.name) && s.isError !== true && (path === undefined || filePath(s) === path))
  const resultHash = (s: Step) => sha1(s.resultText)
  const flagged = new Set<number>()

  // repeated reads and redundant calls
  const lastByKey = new Map<string, number>()
  steps.forEach((s, j) => {
    if (s.isError || EDIT_TOOLS.has(s.name) || AGENT_TOOLS.has(s.name)) return
    const i = lastByKey.get(s.key)
    lastByKey.set(s.key, j)
    if (i === undefined) return
    const prev = steps[i]
    if (s.name === 'Read') {
      const path = filePath(s)
      if (!editsAfter(i, j, path) && resultHash(prev) === resultHash(s)) {
        add('repeated_read', s, path, approxTokens(s.resultChars))
        flagged.add(j)
      }
    } else if (!editsAfter(i, j) && s.resultChars >= 1 && resultHash(prev) === resultHash(s)) {
      add('redundant_call', s, command(s) ? command(s).slice(0, 80) : summary(s), approxTokens(s.resultChars))
      flagged.add(j)
    }
  })

  // a different search returning what an earlier search already did
  const searchResults = new Map<string, number>()
  steps.forEach((s, j) => {
    if (!SEARCH_TOOLS.has(s.name) || s.isError || s.resultChars < MIN_RESULT_CHARS) return
    const h = resultHash(s)
    const i = searchResults.get(h)
    if (i === undefined) {
      searchResults.set(h, j)
    } else if (steps[i].key !== s.key && !editsAfter(i, j) && !flagged.has(j)) {
      add('repeated_search', s, `${summary(steps[i])} → ${summary(s)}`, approxTokens(s.resultChars))
      flagged.add(j)
    }
  })

  // big results nothing later refers to: one chronological string of everything the agent wrote
  // afterwards (its prose and later tool inputs), searched from just after each call
  const parts: string[] = []
  const after = new Array<number>(steps.length).fill(0)
  let pos = 0
  const push = (x: string) => {
    parts.push(x)
    pos += x.length + 1
  }
  let si = 0
  for (let ti = 0; ti < t.turns.length; ti++) {
    push(t.turns[ti].text)
    for (; si < steps.length && steps[si].turn <= ti; si++) {
      push(JSON.stringify(steps[si].input))
      after[si] = pos
    }
  }
  for (; si < steps.length; si++) after[si] = pos
  const written = parts.join('\n')
  steps.forEach((s, j) => {
    if (flagged.has(j) || s.isError || s.resultChars < UNUSED_MIN_CHARS || EDIT_TOOLS.has(s.name) || AGENT_TOOLS.has(s.name) ||
        j === steps.length - 1) return
    const ms = markers(s.resultText)
    if (ms.length >= 5 && !ms.some((m) => written.indexOf(m, after[j]) >= 0)) add('unused_result', s, summary(s), approxTokens(s.resultChars))
  })

  // subagents: overlap and needless delegation
  const agents = steps.map((s, j) => [s, j] as const).filter(([s]) => AGENT_TOOLS.has(s.name) && !s.sidechain)
  const brief = (s: Step) => `${s.input.description ?? ''} ${s.input.prompt ?? ''}`
  for (let a = 0; a < agents.length; a++) {
    for (let b = a + 1; b < agents.length; b++) {
      const [sa] = agents[a]
      const [sb] = agents[b]
      if (jaccard(words(brief(sa)), words(brief(sb))) >= 0.5) {
        add('overlapping_agents', sb, `"${String(sa.input.description ?? '').slice(0, 40)}" / "${String(sb.input.description ?? '').slice(0, 40)}"`,
          approxTokens(Math.min(sa.resultChars, sb.resultChars)), subagentOverheadUsd(turnModel(sb.turn), config))
      }
    }
  }
  for (const [s] of agents) {
    const prompt = String(s.input.prompt ?? '')
    const nWords = prompt.split(/\s+/).filter(Boolean).length
    if (nWords && nWords <= 40 && s.resultChars < 1_500 && /\b(read|find|look ?up|locate|check|what is|where is|list|show|grep|search for)\b/i.test(prompt)) {
      add('needless_agent', s, String(s.input.description ?? prompt).slice(0, 60), 0, subagentOverheadUsd(turnModel(s.turn), config))
    }
  }

  for (const f of findings) f.usd = Math.round(f.usd * 1e6) / 1e6
  findings.sort((a, b) => b.usd - a.usd)
  const session = t.turns.reduce((a, x) => a + x.costUsd, 0)
  const wasted = findings.reduce((a, f) => a + f.usd, 0)
  const byKind: Investigation['by_kind'] = {}
  for (const f of findings) {
    const k = byKind[f.kind] ??= { count: 0, usd: 0, tokens: 0 }
    k.count += f.times
    k.usd += f.usd
    k.tokens += f.tokens
  }
  return { session_cost_usd: session, wasted_usd: Math.min(wasted, session || wasted), wasted_tokens: findings.reduce((a, f) => a + f.tokens, 0),
    share: session ? Math.min(1, wasted / session) : 0, findings, by_kind: byKind, subagents: agents.length, tool_calls: steps.length }
}

function subagentOverheadUsd(model: string, config?: Obj): number {
  const r = ratesFor(model, config)
  return SUBAGENT_OVERHEAD_TOKENS * r.cache_write_5m / 1e6
}

/** A short, content-free description of a call: the path, pattern or command head. */
export function summary(s: Step): string {
  const i = s.input
  const pick = filePath(s) || command(s) || (isObj(i) ? String(i.pattern ?? i.query ?? i.url ?? i.description ?? '') : '')
  return pick.length > 70 ? pick.slice(0, 67) + '...' : pick || s.name
}
