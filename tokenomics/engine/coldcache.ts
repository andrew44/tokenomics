/**
 * Cold cache: every time a conversation's prompt cache had to be written again, why, and what it cost.
 *
 * While the cache is warm, re-sending the conversation is billed at cache-read prices (a tenth of the
 * input price). When it goes cold the whole context is written to the cache again, at 1.25x the input
 * price (2x for the 1-hour cache): twelve to twenty times what the warm read would have cost. A
 * rebuild is a main-thread request (not the session's first) whose cache write is at least
 * REBUILD_MIN tokens and more than half its context. Its cause, from the transcript alone:
 *
 *   idle           the gap since the previous request was longer than the cache lives (5 min, or
 *                  1 hour when the session writes the 1-hour cache, or TOKENOMICS_CACHE_TTL)
 *   model switch   the model changed: each model has its own cache
 *   compaction     the context shrank by more than 40% (/compact, or auto-compact): expected, and
 *                  cheaper than carrying on, so never counted as avoidable
 *   prefix change  none of those: something early in the context changed (CLAUDE.md, an MCP server
 *                  or skill added or removed, settings, an edited earlier message)
 *
 * The cost of a rebuild is its premium over a warm read: tokens x (write rate - read rate).
 * Shared by coldsnap (the report). Words and numbers only, no model call, nothing stored.
 */
import { ratesFor } from './pricing.ts'
import * as trace from './trace.ts'

export const REBUILD_MIN = 10_000
export const SHRINK = 0.6                       // ctx below 60% of the previous request: compacted

export type Cause = 'idle' | 'model_switch' | 'compaction' | 'prefix_change'

export type Rebuild = {
  turn: number
  ts: number | null
  cause: Cause
  tokens: number                                // written to the cache again
  usd: number                                   // premium over a warm read
  gap_s: number | null                          // seconds since the previous main-thread request
  model: string
  from_model: string | null                     // model_switch: the one before
  avoidable: boolean
  detail: string
}

export type ColdCache = {
  requests: number
  input_tokens: number                          // uncached input
  cache_write_tokens: number
  cache_read_tokens: number
  hit_ratio: number | null                      // cache read / all input
  rebuilds: Rebuild[]
  rebuild_usd: number
  avoidable_usd: number
  /** What the 1-hour cache would have changed, for a session on the 5-minute cache: idle rebuilds after
   *  breaks of 5 to 60 minutes become warm reads, and every cache write costs 2x instead of 1.25x. */
  ttl_1h: { saved_usd: number, extra_usd: number, net_usd: number } | null
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6
const mins = (s: number) => `${Math.round(s / 60)} min`

/** Seconds the cache lives for this session: TOKENOMICS_CACHE_TTL, else 1 hour if it ever wrote the 1-hour cache. */
export function ttlFor(t: trace.Trace): number {
  const env = Number(process.env.TOKENOMICS_CACHE_TTL)
  if (Number.isFinite(env) && env > 0) return env
  return t.turns.some((x) => x.usage.cacheCreation1hTokens > 0) ? 3600 : 300
}

export function analyse(t: trace.Trace): ColdCache {
  const ttl = ttlFor(t)
  const main = t.turns.map((x, i) => ({ x, i })).filter(({ x }) => !x.sidechain && x.ctx > 0)
  const rebuilds: Rebuild[] = []
  let write = 0
  let read = 0
  let input = 0
  let write5mUsd = 0
  for (const { x } of main) {
    write += x.usage.cacheCreationTokens
    read += x.usage.cacheReadTokens
    input += x.usage.inputTokens
    const r = ratesFor(x.model)
    write5mUsd += (x.usage.cacheCreationTokens - x.usage.cacheCreation1hTokens) * (r.cache_write_1h - r.cache_write_5m) / 1e6
  }
  let idleWithinHourUsd = 0
  for (let k = 1; k < main.length; k++) {
    const { x, i } = main[k]
    const prev = main[k - 1].x
    const cc = x.usage.cacheCreationTokens
    if (cc < REBUILD_MIN || cc <= 0.5 * x.ctx) continue
    const r = ratesFor(x.model)
    const oneHour = x.usage.cacheCreation1hTokens > cc / 2
    const usd = cc * ((oneHour ? r.cache_write_1h : r.cache_write_5m) - r.cache_read) / 1e6
    const gap = x.ts !== null && prev.ts !== null ? Math.max(0, x.ts - prev.ts) : null
    let cause: Cause
    let detail: string
    if (x.ctx < prev.ctx * SHRINK) {
      cause = 'compaction'
      detail = `context compacted from ${prev.ctx.toLocaleString('en-GB')} to ${x.ctx.toLocaleString('en-GB')} tokens (expected)`
    } else if (gap !== null && gap > ttl) {
      cause = 'idle'
      detail = `${mins(gap)} since the last request; the cache lives ${mins(ttl)}`
      if (gap <= 3600 && ttl < 3600) idleWithinHourUsd += usd
    } else if (prev.model && x.model && prev.model !== x.model) {
      cause = 'model_switch'
      detail = `model changed from ${prev.model} to ${x.model}`
    } else {
      cause = 'prefix_change'
      detail = 'the start of the context changed (instruction file, MCP server, skill, settings or an edited message)'
    }
    rebuilds.push({ turn: i, ts: x.ts, cause, tokens: cc, usd: round6(usd), gap_s: gap === null ? null : Math.round(gap),
      model: x.model, from_model: cause === 'model_switch' ? prev.model : null, avoidable: cause !== 'compaction', detail })
  }
  const all = input + write + read
  const usesOneHour = ttl >= 3600
  return {
    requests: main.length, input_tokens: input, cache_write_tokens: write, cache_read_tokens: read,
    hit_ratio: all ? Math.round(read / all * 1000) / 1000 : null,
    rebuilds,
    rebuild_usd: round6(rebuilds.reduce((a, r) => a + r.usd, 0)),
    avoidable_usd: round6(rebuilds.filter((r) => r.avoidable).reduce((a, r) => a + r.usd, 0)),
    ttl_1h: usesOneHour || !main.length ? null
      : { saved_usd: round6(idleWithinHourUsd), extra_usd: round6(write5mUsd), net_usd: round6(idleWithinHourUsd - write5mUsd) },
  }
}

/** Add one session's analysis into a running total. */
export function merge(into: ColdCache | null, c: ColdCache): ColdCache {
  if (!into) return { ...c, rebuilds: [...c.rebuilds], ttl_1h: c.ttl_1h ? { ...c.ttl_1h } : null }
  into.requests += c.requests
  into.input_tokens += c.input_tokens
  into.cache_write_tokens += c.cache_write_tokens
  into.cache_read_tokens += c.cache_read_tokens
  const all = into.input_tokens + into.cache_write_tokens + into.cache_read_tokens
  into.hit_ratio = all ? Math.round(into.cache_read_tokens / all * 1000) / 1000 : null
  into.rebuilds.push(...c.rebuilds)
  into.rebuild_usd = round6(into.rebuild_usd + c.rebuild_usd)
  into.avoidable_usd = round6(into.avoidable_usd + c.avoidable_usd)
  if (c.ttl_1h) {
    const t = into.ttl_1h ??= { saved_usd: 0, extra_usd: 0, net_usd: 0 }
    t.saved_usd = round6(t.saved_usd + c.ttl_1h.saved_usd)
    t.extra_usd = round6(t.extra_usd + c.ttl_1h.extra_usd)
    t.net_usd = round6(t.saved_usd - t.extra_usd)
  }
  return into
}
