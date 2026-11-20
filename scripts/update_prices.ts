#!/usr/bin/env node
/**
 * tokenomics / update_prices: refresh data/model-prices.json from Claude's official pricing page.
 *
 * Reads the "Model pricing" table on https://platform.claude.com/docs/en/about-claude/pricing (the
 * docs serve Markdown when the URL ends in .md), turns each row into a price entry keyed by API
 * model id, and merges it into data/model-prices.json:
 *
 *   * models on the page get their latest prices (USD per million tokens);
 *   * models no longer on the page (retired, e.g. Claude Haiku 3.5) keep their last known prices
 *     and are marked "listed": false, so old transcripts can still be priced;
 *   * only models from Claude Haiku 3.5 onwards are kept (see MIN_VERSION).
 *
 * Run by .github/workflows/update-prices.yml on a schedule.
 *
 * Usage
 *   update_prices.ts                 fetch and update the JSON in place
 *   update_prices.ts --check         exit 1 if the JSON is out of date (writes nothing)
 *   update_prices.ts --source FILE   parse a saved copy of the page instead of fetching
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { argValue, isMain, type Obj } from '../tokenomics/util.ts'

export const PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing.md'
export const PRICES_FILE = join(import.meta.dirname, '..', 'data', 'model-prices.json')

// Oldest model version tracked: Claude Haiku 3.5. Everything from 3.5 up to the newest is kept.
const MIN_VERSION: [number, number] = [3, 5]

const COLUMNS: Record<string, string> = {  // header text on the page -> key in the JSON
  'base input tokens': 'input',
  '5m cache writes': 'cache_write_5m',
  '1h cache writes': 'cache_write_1h',
  'cache hits and refreshes': 'cache_read',
  'output tokens': 'output',
}
const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku']

// Retired models that have dropped off the pricing page: last published prices, so transcripts
// that used them can still be priced. Entries already in the JSON win over these.
const LEGACY: Record<string, Obj> = {
  'claude-3-7-sonnet': { name: 'Claude Sonnet 3.7', family: 'sonnet', version: '3.7', input: 3.0,
    cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.3, output: 15.0 },
  'claude-3-5-sonnet': { name: 'Claude Sonnet 3.5', family: 'sonnet', version: '3.5', input: 3.0,
    cache_write_5m: 3.75, cache_write_1h: 6.0, cache_read: 0.3, output: 15.0 },
  'claude-3-5-haiku': { name: 'Claude Haiku 3.5', family: 'haiku', version: '3.5', input: 0.8,
    cache_write_5m: 1.0, cache_write_1h: 1.6, cache_read: 0.08, output: 4.0 },
}

const ROW_NAME = /^Claude\s+(Fable|Mythos|Opus|Sonnet|Haiku)\s+(\d+)(?:\.(\d+))?\b(.*)$/i
const PRICE = /\$\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*MTok/i
const OVER = /over\s+([0-9][0-9,]*)\s+tokens/i

/** API id for a model, e.g. ('opus', 4, 8) -> claude-opus-4-8, ('haiku', 3, 5) -> claude-3-5-haiku. */
export function modelId(family: string, major: number, minor: number): string {
  const ver = minor ? `${major}-${minor}` : `${major}`
  return major < 4 ? `claude-${ver}-${family}` : `claude-${family}-${ver}`   // Claude 3.x ids put the version first
}

function stripMd(cell: string): string {
  return cell.replace(/<sup>.*?<\/sup>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()   // [text](link) -> text
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')

/** [header, rows] for every Markdown table in the page. */
function* tableRows(markdown: string): Generator<[string[], string[][]]> {
  const lines = markdown.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    if (lines[i].trimStart().startsWith('|') && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = cells(lines[i]).map((c) => stripMd(c).toLowerCase())
      const rows: string[][] = []
      i += 2
      while (i < lines.length && lines[i].trimStart().startsWith('|')) {
        rows.push(cells(lines[i]).map((c) => c.trim()))
        i++
      }
      yield [header, rows]
    } else {
      i++
    }
  }
}

const below = (a: [number, number], b: [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** {modelId: entry} from the page's model pricing table. */
export function parsePricing(markdown: string): Record<string, Obj> {
  for (const [header, rows] of tableRows(markdown)) {
    if (!header.length || header[0] !== 'model' || !Object.keys(COLUMNS).every((c) => header.includes(c))) continue
    const idx = Object.fromEntries(Object.entries(COLUMNS).map(([c, key]) => [key, header.indexOf(c)]))
    const models: Record<string, Obj> = {}
    for (const row of rows) {
      const m = ROW_NAME.exec(stripMd(row[0]))
      if (!m) continue
      const family = m[1].toLowerCase()
      const major = Number(m[2])
      const minor = Number(m[3] || 0)
      const rest = m[4]
      if (below([major, minor], MIN_VERSION)) continue
      const prices: Record<string, number> = {}
      for (const [key, col] of Object.entries(idx)) {
        const p = col < row.length ? PRICE.exec(row[col]) : null
        if (!p) break
        prices[key] = Number(p[1])
      }
      if (Object.keys(prices).length !== Object.keys(COLUMNS).length) continue
      const mid = modelId(family, major, minor)
      const over = OVER.exec(rest)
      models[mid] ??= {}
      if (over) {                                   // long-prompt tier (e.g. Haiku 5.5 over 100,000 tokens)
        models[mid].long_context = { threshold: Number(over[1].replaceAll(',', '')), ...prices }
        continue
      }
      Object.assign(models[mid], {
        name: `Claude ${cap(family)} ${major}${minor ? '.' + minor : ''}`,
        family,
        version: minor ? `${major}.${minor}` : String(major),
        ...prices,
      })
      if (rest.toLowerCase().includes('retired')) models[mid].retired = true   // still sold on some clouds, retired on the API
    }
    if (Object.keys(models).length) return models
  }
  return {}
}

function versionKey(entry: Obj): [number, number, number] {
  const [major, minor] = String(entry.version ?? '0').split('.')
  return [Number(major) || 0, Number(minor || 0) || 0, -FAMILIES.indexOf(entry.family ?? 'haiku')]
}

/** Merge freshly parsed prices into the existing file contents; keep unlisted models. */
export function merge(current: Obj | null, fresh: Record<string, Obj>): Obj {
  const old: Record<string, Obj> = Object.fromEntries(Object.entries(LEGACY).map(([mid, e]) => [mid, { ...e, retired: true }]))
  Object.assign(old, current?.models ?? {})
  const merged: Record<string, Obj> = {}
  for (const [mid, entry] of Object.entries(old)) if (!(mid in fresh)) merged[mid] = { ...entry, listed: false }
  for (const [mid, entry] of Object.entries(fresh)) merged[mid] = { ...entry, listed: true }
  const ordered = Object.entries(merged).sort((a, b) => {
    const ka = versionKey(a[1])
    const kb = versionKey(b[1])
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i]   // newest first
    return 0
  })
  return {
    source: PRICING_URL.endsWith('.md') ? PRICING_URL.slice(0, -'.md'.length) : PRICING_URL,
    currency: 'USD',
    unit: 'per million tokens',
    updated: current?.updated ?? null,
    models: Object.fromEntries(ordered),
  }
}

async function fetchPage(url = PRICING_URL): Promise<string> {
  const r = await fetch(url, { headers: { 'User-Agent': 'tokenomics-price-updater' }, signal: AbortSignal.timeout(30_000) })
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`)
  return r.text()
}

export async function main(argv: string[]): Promise<number> {
  const source = argValue(argv, '--source')
  const outPath = argValue(argv, '--out') ?? PRICES_FILE
  const page = source ? readFileSync(source, 'utf8') : await fetchPage()
  const fresh = parsePricing(page)
  if (Object.keys(fresh).length < 5) {               // the page layout changed: refuse to wipe good data
    process.stderr.write(`error: parsed only ${Object.keys(fresh).length} models from the pricing page\n`)
    return 2
  }
  let current: Obj | null = null
  try {
    current = JSON.parse(readFileSync(outPath, 'utf8'))
  } catch {
    current = null
  }
  const data = merge(current, fresh)
  if (current !== null && isDeepStrictEqual({ ...data, updated: null }, { ...current, updated: null })) {
    process.stdout.write(`prices unchanged (${Object.keys(fresh).length} models listed)\n`)
    return 0
  }
  if (argv.includes('--check')) {
    process.stdout.write('prices are out of date\n')
    return 1
  }
  data.updated = new Date().toISOString().slice(0, 10)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8')
  process.stdout.write(`updated ${outPath} (${Object.keys(fresh).length} models listed, ${Object.keys(data.models).length} total)\n`)
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
