/**
 * Verbosity: what the agent wrote, and how much of it was worth paying for.
 *
 * Output tokens cost five times input tokens on every Claude model, and nothing caches them. A
 * session's output splits three ways, each estimated from the transcript:
 *
 *   prose        the reply text you read (about 4 characters a token)
 *   tool input   what the agent wrote into tool calls: edits, new files, commands
 *   thinking     the rest of the billed output tokens (extended thinking is billed, not shown)
 *
 * and the avoidable parts are:
 *
 *   long replies       a final reply longer than `long` tokens (the excess is counted)
 *   recaps             a reply that ends a task by restating it ("## Summary", "Here's what I changed")
 *   full rewrites      Write used to replace an existing file whole, instead of an Edit of the lines
 *                      that changed (the whole file is paid for as output)
 *
 * Shared by waffle (the report) and anything else that wants the split.
 */
import { ratesFor } from './pricing.ts'
import * as trace from './trace.ts'

export const DEFAULT_LONG = 500                 // prose tokens in one reply (about 375 words)
export const REWRITE_MIN_CHARS = 1500           // smaller Write calls are not worth flagging

const RECAP = /^\s*(?:#{1,4}\s*|\*\*)?(?:summary|in summary|to summari[sz]e|recap|what (?:i|we) (?:did|changed)|changes made|here(?:'|’)?s (?:a )?(?:summary|what (?:i|we) (?:did|changed)))\b/im

export type Split = { prose: number, tool_input: number, thinking: number }

export type Finding = { kind: 'long_reply' | 'recap' | 'full_rewrite', turn: number, tokens: number, usd: number, detail: string }

export type Verbosity = {
  output_tokens: number
  output_usd: number
  spend_usd: number
  output_share: number             // output cost / all cost
  split: Split                     // tokens
  split_usd: Split
  replies: number                  // main-thread final replies
  avg_reply_tokens: number
  findings: Finding[]
  avoidable_usd: number
}

const outRate = (model: string) => ratesFor(model).output / 1e6
const round6 = (v: number) => Math.round(v * 1e6) / 1e6

export function analyse(t: trace.Trace, long = DEFAULT_LONG): Verbosity {
  const toolChars = new Map<number, number>()
  for (const s of t.steps) toolChars.set(s.turn, (toolChars.get(s.turn) ?? 0) + JSON.stringify(s.input ?? {}).length)
  const split: Split = { prose: 0, tool_input: 0, thinking: 0 }
  const splitUsd: Split = { prose: 0, tool_input: 0, thinking: 0 }
  let out = 0
  let outUsd = 0
  t.turns.forEach((x, i) => {
    const o = x.usage.outputTokens
    if (!o) return
    const rate = outRate(x.model) * (x.usage.fast ? 2 : 1)
    const prose = Math.min(o, trace.approxTokens(x.text.length))
    const tool = Math.min(o - prose, trace.approxTokens(toolChars.get(i) ?? 0))
    const think = o - prose - tool
    split.prose += prose
    split.tool_input += tool
    split.thinking += think
    splitUsd.prose += prose * rate
    splitUsd.tool_input += tool * rate
    splitUsd.thinking += think * rate
    out += o
    outUsd += o * rate
  })

  const findings: Finding[] = []
  // A final reply: a main-thread turn with prose and no tool call (the agent handing back to you).
  const hasTool = new Set(t.steps.map((s) => s.turn))
  let replies = 0
  let replyTokens = 0
  t.turns.forEach((x, i) => {
    if (x.sidechain || hasTool.has(i) || !x.text.trim()) return
    replies++
    const tokens = Math.min(x.usage.outputTokens || Infinity, trace.approxTokens(x.text.length))
    replyTokens += tokens
    const rate = outRate(x.model)
    if (RECAP.test(x.text) && tokens > 120) {
      findings.push({ kind: 'recap', turn: i, tokens, usd: tokens * rate, detail: `a ${tokens.toLocaleString('en-GB')}-token recap of work you watched happen` })
    } else if (tokens > long) {
      const extra = tokens - long
      findings.push({ kind: 'long_reply', turn: i, tokens: extra, usd: extra * rate, detail: `a ${tokens.toLocaleString('en-GB')}-token reply (${extra.toLocaleString('en-GB')} over ${long})` })
    }
  })
  // Write over a file that already existed (read or edited earlier, or the tool said it updated it).
  const seen = new Set<string>()
  for (const s of t.steps) {
    const f = trace.filePath(s)
    if (!f) continue
    if ((s.name === 'Write' || s.name === 'write') && (seen.has(f) || /has been (updated|overwritten)/i.test(s.resultText))) {
      const chars = String(s.input.content ?? '').length
      if (chars >= REWRITE_MIN_CHARS) {
        const tokens = trace.approxTokens(chars)
        const x = t.turns[s.turn]
        findings.push({ kind: 'full_rewrite', turn: s.turn, tokens, usd: tokens * outRate(x?.model ?? ''),
          detail: `rewrote ${f.split(/[\\/]/).pop()} whole (${tokens.toLocaleString('en-GB')} tokens) instead of editing it` })
      }
    }
    seen.add(f)
  }
  const spend = trace.costUsd(t)
  const r6 = (s: Split): Split => ({ prose: round6(s.prose), tool_input: round6(s.tool_input), thinking: round6(s.thinking) })
  return {
    output_tokens: out, output_usd: round6(outUsd), spend_usd: round6(spend), output_share: spend ? Math.round(outUsd / spend * 100) / 100 : 0,
    split, split_usd: r6(splitUsd), replies, avg_reply_tokens: replies ? Math.round(replyTokens / replies) : 0,
    findings: findings.map((f) => ({ ...f, usd: round6(f.usd) })), avoidable_usd: round6(findings.reduce((a, f) => a + f.usd, 0)),
  }
}

/** Add one session's analysis into a running total. */
export function merge(into: Verbosity | null, v: Verbosity): Verbosity {
  if (!into) return { ...v, split: { ...v.split }, split_usd: { ...v.split_usd }, findings: [...v.findings] }
  const add = (a: Split, b: Split) => {
    a.prose += b.prose
    a.tool_input += b.tool_input
    a.thinking += b.thinking
  }
  const replies = into.replies + v.replies
  const avg = replies ? Math.round((into.avg_reply_tokens * into.replies + v.avg_reply_tokens * v.replies) / replies) : 0
  into.output_tokens += v.output_tokens
  into.output_usd = round6(into.output_usd + v.output_usd)
  into.spend_usd = round6(into.spend_usd + v.spend_usd)
  into.output_share = into.spend_usd ? Math.round(into.output_usd / into.spend_usd * 100) / 100 : 0
  add(into.split, v.split)
  add(into.split_usd, v.split_usd)
  into.replies = replies
  into.avg_reply_tokens = avg
  into.findings.push(...v.findings)
  into.avoidable_usd = round6(into.avoidable_usd + v.avoidable_usd)
  return into
}
