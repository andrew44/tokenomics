/**
 * CostEngine: every price and cost calculation, for every platform and provider.
 *
 *   rates / usage cost      per-model Claude prices (engine/pricing.ts, data/model-prices.json)
 *   display currency        GBP / USD / EUR (engine/currency.ts)
 *   provider                which provider served a model (Anthropic API, Bedrock, Vertex, ...)
 *   offerings               equivalent models across providers (data/providers.json + your overrides)
 *   workload cost           what a token workload (fresh input, cache writes, cache reads, output)
 *                           costs on any offering, with or without cached-token prices
 *   projection              monthly spend for a team scenario (crystalball)
 *
 * All money is computed in USD and converted only for display. Copilot bills premium requests,
 * not tokens: nothing here turns a Copilot session into money.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { isObj, type Obj } from '../util.ts'
import { formatMoney, current } from '../engine/currency.ts'
import { ratesFor } from '../engine/pricing.ts'

export { claudeModelId, modelPrices, ratesFor, sessionCostUsd, usageCostUsd, type Rates } from '../engine/pricing.ts'
export { currencyCode, current as money, formatMoney } from '../engine/currency.ts'

export const PROVIDERS_FILE = join(import.meta.dirname, '..', '..', 'data', 'providers.json')
export const TIERS = ['fast', 'balanced', 'frontier'] as const
export type Tier = typeof TIERS[number]

/** Tokens a piece of work used (or will use), split by how each is billed. */
export type Workload = { input: number, cacheWrite: number, cacheRead: number, output: number }

export function workload(w: Partial<Workload> = {}): Workload {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, ...w }
}

export function addWorkload(into: Workload, w: Partial<Workload>): Workload {
  into.input += w.input ?? 0
  into.cacheWrite += w.cacheWrite ?? 0
  into.cacheRead += w.cacheRead ?? 0
  into.output += w.output ?? 0
  return into
}

export function scaleWorkload(w: Workload, k: number): Workload {
  return { input: w.input * k, cacheWrite: w.cacheWrite * k, cacheRead: w.cacheRead * k, output: w.output * k }
}

export type Offering = {
  id: string
  provider: string
  providerName: string
  model: string
  tier: Tier
  input: number
  output: number
  cacheWrite: number | null      // null: the provider lists no cached-token price (billed as input)
  cacheRead: number | null
  quality: number | null         // 0-100, a benchmark score you trust (none shipped)
  latencyS: number | null        // seconds to a reply
  availability: number | null    // 0-1
  indicative: boolean
  note: string | null
}

// ---- provider ---------------------------------------------------------------------------------

/** Which provider served a model id. Claude ids name their cloud (Bedrock: `us.anthropic.claude-...`,
 *  Vertex: `claude-...@20251001`); otherwise Claude Code's own switches say. */
export function provider(model: string | null | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const m = String(model ?? '').toLowerCase()
  if (!m) return 'unknown'
  if (/^(?:[a-z]{2,6}\.)?anthropic\.|^arn:aws:bedrock|bedrock/.test(m)) return 'bedrock'
  if (/claude[\w.-]*@\d{6,8}$|vertex/.test(m)) return 'vertex'
  if (/claude|opus|sonnet|haiku|fable|mythos/.test(m)) {
    if (env.CLAUDE_CODE_USE_BEDROCK === '1') return 'bedrock'
    if (env.CLAUDE_CODE_USE_VERTEX === '1') return 'vertex'
    return 'anthropic'
  }
  if (/gpt|^o\d|openai|codex/.test(m)) return 'openai'
  if (/gemini|google/.test(m)) return 'google'
  return 'unknown'
}

/** fast / balanced / frontier, from the model family. */
export function tierOf(model: string | null | undefined): Tier | null {
  const m = String(model ?? '').toLowerCase()
  if (/haiku|mini|flash|nano|lite/.test(m)) return 'fast'
  if (/opus|fable|mythos/.test(m)) return 'frontier'
  if (/sonnet|gpt|gemini/.test(m)) return 'balanced'
  return null
}

// ---- offerings --------------------------------------------------------------------------------

const userFile = () => join(process.env.TOKENOMICS_HOME || join(homedir(), '.tokenomics'), 'providers.json')

function readJson(path: string): Obj {
  try {
    if (!existsSync(path)) return {}
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

const numOrNull = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))

function resolve(row: Obj, providers: Obj): Offering | null {
  const id = String(row.id ?? '')
  const prov = String(row.provider ?? id.split('/')[0] ?? 'unknown')
  if (!id) return null
  const meta: Obj = isObj(providers[prov]) ? providers[prov] : {}
  const k = numOrNull(row.price_multiplier) ?? 1
  let input = numOrNull(row.input)
  let output = numOrNull(row.output)
  let cacheWrite = numOrNull(row.cache_write)
  let cacheRead = numOrNull(row.cache_read)
  if (row.prices_from && (input === null || output === null)) {
    const r = ratesFor(String(row.prices_from))
    input ??= r.input * k
    output ??= r.output * k
    cacheWrite ??= r.cache_write_5m * k
    cacheRead ??= r.cache_read * k
  }
  if (input === null || output === null) return null
  const caching = meta.caching !== false
  return {
    id, provider: prov, providerName: String(meta.name ?? prov), model: String(row.model ?? id),
    tier: (TIERS as readonly string[]).includes(row.tier) ? row.tier : tierOf(row.model ?? id) ?? 'balanced',
    input, output, cacheWrite: caching ? cacheWrite : null, cacheRead: caching ? cacheRead : null,
    quality: numOrNull(row.quality), latencyS: numOrNull(row.latency_s), availability: numOrNull(row.availability),
    indicative: Boolean(row.indicative), note: row.note ? String(row.note) : null,
  }
}

/** The catalogue: shipped offerings, then ~/.tokenomics/providers.json (rows with the same id replace
 *  shipped ones; `"disabled": true` removes one). Pass `extra` to use a catalogue object directly. */
export function offerings(extra?: Obj): Offering[] {
  const base = readJson(PROVIDERS_FILE)
  const user = extra ?? readJson(userFile())
  const providers = { ...(isObj(base.providers) ? base.providers : {}), ...(isObj(user.providers) ? user.providers : {}) }
  const rows = new Map<string, Obj>()
  for (const src of [base, user]) {
    for (const r of Array.isArray(src.offerings) ? src.offerings : []) {
      if (!isObj(r) || !r.id) continue
      rows.set(String(r.id), { ...(rows.get(String(r.id)) ?? {}), ...r })
    }
  }
  return [...rows.values()].filter((r) => !r.disabled).map((r) => resolve(r, providers)).filter((o): o is Offering => o !== null)
}

/** The catalogue offering that matches a model a session actually used (same provider first). */
export function offeringFor(model: string, list: Offering[] = offerings()): Offering | null {
  const id = String(model).toLowerCase()
  const prov = provider(model)
  const fam = (s: string) => (/(fable|mythos|opus|sonnet|haiku)[\s_-]*(\d+(?:[.-]\d)?)?/.exec(s.toLowerCase()) ?? [])[0]?.replace('.', '-') ?? ''
  const f = fam(id)
  return list.find((o) => o.provider === prov && (o.model === id || (f && fam(o.model) === f))) ??
    list.find((o) => o.model === id || (f && fam(o.model) === f)) ?? null
}

// ---- workload cost ----------------------------------------------------------------------------

/** USD for a workload on an offering. Where the offering lists no cached-token prices, cache writes
 *  and reads are billed as fresh input (no discount): the honest worst case. */
export function workloadCostUsd(w: Workload, o: Offering): number {
  const cw = o.cacheWrite ?? o.input
  const cr = o.cacheRead ?? o.input
  return (w.input * o.input + w.cacheWrite * cw + w.cacheRead * cr + w.output * o.output) / 1e6
}

/** Split of a workload's cost into what it is spent on. */
export function workloadBreakdown(w: Workload, o: Offering): { input: number, cache_write: number, cache_read: number, output: number } {
  return { input: w.input * o.input / 1e6, cache_write: w.cacheWrite * (o.cacheWrite ?? o.input) / 1e6,
    cache_read: w.cacheRead * (o.cacheRead ?? o.input) / 1e6, output: w.output * o.output / 1e6 }
}

// ---- projection (crystalball) -----------------------------------------------------------------

export type Scenario = {
  developers: number
  tasksPerDay: number           // per developer
  workingDays: number           // per month
  inputPerTask: number          // tokens the model reads per task, summed over its requests
  outputPerTask: number
  cacheHit: number              // 0-1: share of input served from the prompt cache (0 = no caching)
}

export function scenario(s: Partial<Scenario> = {}): Scenario {
  return { developers: 1, tasksPerDay: 10, workingDays: 21, inputPerTask: 50_000, outputPerTask: 5_000, cacheHit: 0.7, ...s }
}

/** The tokens of one task: with caching, input not read from the cache is written to it (as agents do);
 *  with no caching (cacheHit 0) it is all plain input. */
export function taskWorkload(s: Scenario): Workload {
  const hit = Math.min(1, Math.max(0, s.cacheHit))
  if (!hit) return workload({ input: s.inputPerTask, output: s.outputPerTask })
  return workload({ cacheWrite: s.inputPerTask * (1 - hit), cacheRead: s.inputPerTask * hit, output: s.outputPerTask })
}

export const tasksPerMonth = (s: Scenario) => s.developers * s.tasksPerDay * s.workingDays

export type Projection = { offering: Offering, perTaskUsd: number, monthlyUsd: number, perDeveloperUsd: number, yearlyUsd: number }

export function project(s: Scenario, o: Offering): Projection {
  const perTask = workloadCostUsd(taskWorkload(s), o)
  const monthly = perTask * tasksPerMonth(s)
  return { offering: o, perTaskUsd: perTask, monthlyUsd: monthly, perDeveloperUsd: s.developers ? monthly / s.developers : 0, yearlyUsd: monthly * 12 }
}

/** The display currency ([code, symbol, units per USD]) and a formatter that converts from USD. */
export function display(): { code: string, symbol: string, rate: number, fmt: (usd: number | null, wholeAbove?: number | null) => string } {
  const [c, symbol, rate] = current()
  return { code: c, symbol, rate, fmt: (usd, wholeAbove = null) => (usd === null ? 'n/a' : formatMoney(usd * rate, symbol, wholeAbove)) }
}
