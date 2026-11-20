/**
 * Cost calculation for token-billed platforms (Anthropic). Platform-independent.
 *
 * Overrides come from the same place as the statusline's: "prices" in ~/.tokenomics/statusline.json
 * (or $TOKENOMICS_HOME/statusline.json; statusbar.json, its name before v1.4, until it is renamed).
 * Converting to the display currency: engine/currency.ts.
 *
 * Copilot bills premium requests, not tokens: nothing here is ever applied to Copilot sessions.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isObj, type Obj } from '../util.ts'
import type { TokenUsage } from './evidence.ts'

export function cfg(): Obj {
  const home = process.env.TOKENOMICS_HOME || join(homedir(), '.tokenomics')
  let path = join(home, 'statusline.json')
  if (!existsSync(path)) path = join(home, 'statusbar.json')                   // before v1.4
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(data) ? data : {}
  } catch {
    return {}
  }
}

// Per-model prices come from data/model-prices.json (refreshed weekly from Claude's pricing page
// by .github/workflows/update-prices.yml). The lookup below mirrors scripts/statusline.ts, which
// must stay a single file and so has its own copy; tests/features.test.ts checks they agree.
export const MODEL_PRICES_FILE = join(import.meta.dirname, '..', '..', 'data', 'model-prices.json')
export const FAST_MULTIPLIER = 2.0             // usage.speed == "fast": fast mode bills 2x the standard rates
const CACHE_WRITE_5M = 1.25                     // x input, when a model has no listed rate
const CACHE_WRITE_1H = 2.0
const CACHE_READ = 0.1
// Rough fallbacks (input, output) for models not in the file.
export const PRICES: Record<string, [number, number]> = {
  opus: [5.0, 25.0], sonnet: [3.0, 15.0], haiku: [1.0, 5.0], gpt: [2.5, 10.0], gemini: [1.25, 10.0],
}
export const DEFAULT_PRICE: [number, number] = [3.0, 15.0]
const FAMILIES = 'fable|mythos|opus|sonnet|haiku'
const FAMILY_FIRST = new RegExp(String.raw`(${FAMILIES})[\s_-]*(\d+)(?:[.-](\d)(?!\d))?`)
const VERSION_FIRST = new RegExp(String.raw`(\d+)[.-](\d)(?!\d)[\s_-]*(${FAMILIES})`)
let priceCache: Obj | null = null

export type Rates = {
  input: number, output: number, cache_write_5m: number, cache_write_1h: number, cache_read: number,
  long_context?: Obj
}

export function modelPrices(): Obj {
  if (priceCache === null) {
    try {
      const data = JSON.parse(readFileSync(MODEL_PRICES_FILE, 'utf8'))
      priceCache = isObj(data?.models) ? data.models : {}
    } catch {
      priceCache = {}
    }
  }
  return priceCache!
}

/** 'Opus 5.5' / 'claude-opus-5-5[1m]' -> 'claude-opus-5-5'; 'claude-3-5-haiku-2024..' -> 'claude-3-5-haiku'. */
export function claudeModelId(model: string | null | undefined): string | null {
  const m = (model || '').toLowerCase()
  let hit = VERSION_FIRST.exec(m)
  if (hit) return `claude-${hit[1]}-${hit[2]}-${hit[3]}`
  hit = FAMILY_FIRST.exec(m)
  if (!hit) return null
  const family = hit[1]
  const major = Number(hit[2])
  const minor = hit[3]
  const ver = minor && minor !== '0' ? `${major}-${minor}` : `${major}`
  return major < 4 ? `claude-${ver}-${family}` : `claude-${family}-${ver}`
}

function flat(pin: number, pout: number, pread: number | null = null): Rates {
  return { input: pin, output: pout, cache_write_5m: pin * CACHE_WRITE_5M, cache_write_1h: pin * CACHE_WRITE_1H,
    cache_read: pread === null ? pin * CACHE_READ : pread }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dashed = (s: string) => s.toLowerCase().replace(/[\s._]+/g, '-')
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new TypeError(`not a number: ${String(v)}`)
  return n
}

/** Per-million-token USD rates: input, output, cache_write_5m, cache_write_1h, cache_read
 *  (and long_context when the model has a long-prompt tier). Order: user overrides in
 *  statusline.json ("prices", most specific key wins), then the data file, then family fallbacks. */
export function ratesFor(model: string | null | undefined, config?: Obj | null): Rates {
  const c = config ?? cfg()
  const m = dashed(model || '')
  let best: [string, number, number, number | null] | null = null
  for (const [k, v] of Object.entries(isObj(c.prices) ? c.prices : {})) {
    try {
      const key = dashed(String(k))
      if (key && Array.isArray(v) && new RegExp(`(?<![a-z0-9])${escapeRe(key)}(?![0-9])`).test(m) &&
          (best === null || key.length > best[0].length)) {
        best = [key, num(v[0]), num(v[1]), v.length > 2 ? num(v[2]) : null]
      }
    } catch {
      // a malformed override is ignored
    }
  }
  if (best) return flat(best[1], best[2], best[3])
  const entry = modelPrices()[claudeModelId(model) || '']
  if (isObj(entry)) {
    try {
      const pin = num(entry.input)
      const rates: Rates = { input: pin, output: num(entry.output),
        cache_write_5m: num(entry.cache_write_5m ?? pin * CACHE_WRITE_5M),
        cache_write_1h: num(entry.cache_write_1h ?? pin * CACHE_WRITE_1H),
        cache_read: num(entry.cache_read ?? pin * CACHE_READ) }
      if (isObj(entry.long_context)) rates.long_context = entry.long_context
      return rates
    } catch {
      // fall through to the family prices
    }
  }
  let [pin, pout] = DEFAULT_PRICE
  for (const [key, val] of Object.entries(PRICES)) {
    if (m.includes(key)) {
      [pin, pout] = val
      break
    }
  }
  return flat(pin, pout)
}

/** Cost in USD of one request's usage (same rules as scripts/statusline.ts usageCostUsd). */
export function usageCostUsd(u: TokenUsage, model: string | null | undefined, config?: Obj | null): number {
  let r: Rates = ratesFor(model, config)
  const w1h = Math.min(u.cacheCreation1hTokens, u.cacheCreationTokens)
  const w5m = u.cacheCreationTokens - w1h
  const lc = r.long_context
  if (lc && u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens > Math.trunc(Number(lc.threshold) || 0)) {
    r = { ...r, ...Object.fromEntries(Object.entries(lc).filter(([k]) => k !== 'threshold').map(([k, v]) => [k, Number(v)])) }
  }
  const usd = (u.inputTokens * r.input + u.outputTokens * r.output + w5m * r.cache_write_5m +
    w1h * r.cache_write_1h + u.cacheReadTokens * r.cache_read) / 1e6
  return u.fast ? usd * FAST_MULTIPLIER : usd
}

/** Sum over (model, usage) per request: rates depend on the model and on the request size. */
export function sessionCostUsd(records: Iterable<[string, TokenUsage]>, config?: Obj | null): number {
  const c = config ?? cfg()
  let total = 0
  for (const [m, u] of records) total += usageCostUsd(u, m, c)
  return total
}
