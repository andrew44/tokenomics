#!/usr/bin/env node
/**
 * tokenomics / statusline: a live status line for Claude Code and GitHub Copilot CLI.
 *
 * Shows, on one line:
 *   * model
 *   * context gauge   (smooth green -> yellow at 75% -> red at 90%, with the percentage)
 *   * total tokens    (compact: 950, 12.3K, 8.5M)
 *   * session cost    (in GBP, USD or EUR, e.g. £1.37)
 *   * prompt-cache expiry countdown (MM:ss) with an egg-timer that empties as the cache goes cold
 *
 * Two places show it:
 *   * the statusline: the CLIs' own status line (settings.json "statusLine"), in the terminal. Both
 *     CLIs run this script as a command, pipe a JSON payload on stdin and print what we write.
 *   * the band: Claude Code's apps don't draw a status line, so hooks/band.tsx (a mod) draws the
 *     same line in the desktop app's band above the prompt box (VS Code: the plugin's line above
 *     the prompt box), from --json. Where mods can't run, --message posts it after each reply.
 * A single self-contained file (Node.js built-ins only): --install copies it to
 * ~/.tokenomics/statusline.mts. Never throws: on any problem it prints a minimal line and exits 0.
 *
 * Usage
 *   statusline.ts                     render once from the stdin JSON (what the CLIs do)
 *   statusline.ts --install [claude|copilot|both]  wire the statusline into the CLI settings (backs
 *                                     them up); add --keep-existing to skip a CLI that has another
 *   statusline.ts --uninstall [claude|copilot|both]
 *   statusline.ts --status            say where the statusline is installed, and if the band is on
 *   statusline.ts --sync              SessionStart hook (plugin): refresh the installed copy after a
 *                                     plugin update; install it if no status line is set
 *                                     (TOKENOMICS_STATUSLINE=ask only suggests it once, =off stays quiet)
 *   statusline.ts --band-on / --band-off   show or hide the band in the apps (saved in the config)
 *   statusline.ts --json              the line's numbers as JSON, from the stdin JSON (for the band)
 *   statusline.ts --message           Stop hook (plugin): where mods can't run (older Claude Code)
 *                                     in the desktop app or VS Code, post the line after each reply
 *   statusline.ts --watch [--path FILE]  live-refresh every second (for terminals/CLIs that only
 *                                     redraw on activity, so the timer keeps ticking)
 *   statusline.ts --demo              preview every state (use with --theme light|dark)
 *   statusline.ts --update-rate       fetch today's USD->GBP and USD->EUR rates and save them
 *   statusline.ts --set-currency GBP|USD|EUR   save the display currency
 *   Flags: --theme light|dark|system   --currency GBP|USD|EUR   --ascii   --no-color
 *
 * Config: ~/.tokenomics/statusline.json (or $TOKENOMICS_HOME/statusline.json), all optional:
 *   {"theme": "system", "currency": "GBP", "usd_gbp": 0.76, "usd_eur": 0.86, "cache_ttl": null,
 *    "width": 12, "warn": 75, "crit": 90, "band": true}
 *   (statusbar.json, its name before v1.4, is still read and is renamed at the next session start.)
 * Env overrides: TOKENOMICS_THEME, TOKENOMICS_CURRENCY, TOKENOMICS_USD_GBP, TOKENOMICS_USD_EUR,
 *   TOKENOMICS_CACHE_TTL (seconds), TOKENOMICS_STATUSLINE (auto|ask|off), TOKENOMICS_BAND (on|off),
 *   TOKENOMICS_ASCII=1, TOKENOMICS_TIMER_ICONS="full,half,empty", NO_COLOR.
 *   (TOKENOMICS_STATUSBAR, the old name of TOKENOMICS_STATUSLINE, still works.)
 */
import { spawnSync } from 'node:child_process'
import {
  closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Obj = Record<string, any>
type RGB = [number, number, number]

const HOME = homedir()
const CFG_DIR = process.env.TOKENOMICS_HOME || join(HOME, '.tokenomics')
const CFG_FILE = join(CFG_DIR, 'statusline.json')
const STATE_FILE = join(CFG_DIR, 'statusline-state.json')
// Before v1.4 this was the "statusbar"; before v2.0 it was a Python script (statusline.py). Those
// names are still recognised, and migrate() moves them to the current ones.
const OLD_CFG_FILE = join(CFG_DIR, 'statusbar.json')
const COPY_NAME = 'statusline.mts'
const OLD_NAMES = ['statusbar.py', 'statusline.py']
const SELF = fileURLToPath(import.meta.url)
const HERE = dirname(SELF)

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const int = (v: unknown) => {
  const n = Math.trunc(Number(v ?? 0))
  return Number.isFinite(n) ? n : 0
}
const nowS = () => Date.now() / 1000

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Python's round(): halves go to the even neighbour. */
function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** The config to read: statusline.json, or statusbar.json until it has been renamed. */
export function cfgFile(): string {
  return existsSync(CFG_FILE) || !existsSync(OLD_CFG_FILE) ? CFG_FILE : OLD_CFG_FILE
}

export const DEFAULT_CFG: Obj = { theme: 'system', cache_ttl: null, width: 12, warn: 75, crit: 90 }

// ---- currency: keep identical to tokenomics/engine/currency.ts (tests/features.test.ts checks) ---
// BEGIN CURRENCY
// Display currency: USD, EUR or GBP (default). Chosen by TOKENOMICS_CURRENCY, then "currency" in
// statusline.json; "$", "€", "£", "usd", "euro", "pounds" ... are accepted too. Prices are in USD
// and converted at the rate in TOKENOMICS_USD_EUR / TOKENOMICS_USD_GBP, then "usd_eur" /
// "usd_gbp" in statusline.json, then the defaults below (`statusline.ts --update-rate` saves
// today's rates).
export const CURRENCIES: Record<string, [symbol: string, key: string | null, rate: number]> = {
  USD: ['$', null, 1.0], EUR: ['€', 'usd_eur', 0.86], GBP: ['£', 'usd_gbp', 0.76],
}
export const DEFAULT_CURRENCY = 'GBP'
export const CURRENCY_ALIASES: Record<string, string> = {
  $: 'USD', US$: 'USD', DOLLAR: 'USD', DOLLARS: 'USD', '€': 'EUR', EURO: 'EUR',
  EUROS: 'EUR', '£': 'GBP', POUND: 'GBP', POUNDS: 'GBP', STERLING: 'GBP',
}

/** 'eur', '€', 'Euro' ... -> 'EUR'; null if not a supported currency. */
export function currencyCode(value: unknown): string | null {
  let v = String(value ?? '').trim().toUpperCase()
  v = Object.hasOwn(CURRENCY_ALIASES, v) ? CURRENCY_ALIASES[v] : v
  return Object.hasOwn(CURRENCIES, v) ? v : null
}

/** -> [code, symbol, units of that currency per US dollar]. */
export function currency(cfg: Record<string, any> | null | undefined): [string, string, number] {
  const c = cfg ?? {}
  const code = currencyCode(process.env.TOKENOMICS_CURRENCY) ?? currencyCode(c.currency) ?? DEFAULT_CURRENCY
  let [symbol, key, rate] = CURRENCIES[code]
  if (key) {
    for (const v of [process.env['TOKENOMICS_' + key.toUpperCase()], c[key]]) {
      if (v !== undefined && v !== null && v !== '' && Number(v) > 0) {
        rate = Number(v)
        break
      }
    }
  }
  return [code, symbol, rate]
}

/** '£1,234.50'; with wholeAbove=100, amounts from 100 up drop the pence/cents. */
export function formatMoney(amount: unknown, symbol: string, wholeAbove: number | null = null): string {
  const a = Number(amount) || 0
  const sign = a < 0 ? '-' : ''
  const digits = wholeAbove !== null && Math.abs(a) >= wholeAbove ? 0 : 2
  return sign + symbol + Math.abs(a).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
// END CURRENCY

// Price tables (USD per million tokens). Only used when the CLI does not report a cost itself
// (Copilot, or older Claude Code). Marked with "~" on screen.
//  1. {"prices": {"opus": [5, 25], "sonnet": [3, 15]}} in statusline.json wins (substring match);
//  2. then data/model-prices.json, per Claude model id, kept current by
//     .github/workflows/update-prices.yml from Claude's pricing page;
//  3. then this per-family fallback.
export const PRICES: Record<string, [number, number]> = {
  opus: [5.0, 25.0], sonnet: [3.0, 15.0], haiku: [1.0, 5.0], gpt: [2.5, 10.0], gemini: [1.25, 10.0],
}
export const DEFAULT_PRICE: [number, number] = [3.0, 15.0]
const FAST_MULTIPLIER = 2.0             // usage.speed == "fast": fast mode bills 2x the standard rates
const CACHE_WRITE_5M = 1.25             // x input, when a model has no listed rate
const CACHE_WRITE_1H = 2.0
const CACHE_READ = 0.1
// data/model-prices.json sits two levels up in the repo; `--install` copies it next to the installed script.
const MODEL_PRICES_FILES = [join(HERE, 'model-prices.json'), join(HERE, '..', 'data', 'model-prices.json')]
const CLAUDE_FAMILIES = 'fable|mythos|opus|sonnet|haiku'
const FAMILY_FIRST = new RegExp(String.raw`(${CLAUDE_FAMILIES})[\s_-]*(\d+)(?:[.-](\d)(?!\d))?`)
const VERSION_FIRST = new RegExp(String.raw`(\d+)[.-](\d)(?!\d)[\s_-]*(${CLAUDE_FAMILIES})`)
let modelPricesCache: Obj | null = null

// ----------------------------------------------------------------------------- config ---

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function loadCfg(): Obj {
  const cfg: Obj = { ...DEFAULT_CFG }
  try {
    const data = readJson(cfgFile())
    if (isObj(data)) Object.assign(cfg, data)
  } catch {
    // no config: the defaults
  }
  const env = process.env
  if (env.TOKENOMICS_THEME) cfg.theme = env.TOKENOMICS_THEME.toLowerCase()
  if (env.TOKENOMICS_CACHE_TTL && /^\s*[+-]?\d+\s*$/.test(env.TOKENOMICS_CACHE_TTL)) cfg.cache_ttl = Number.parseInt(env.TOKENOMICS_CACHE_TTL, 10)
  return cfg
}

export function loadState(): Obj {
  try {
    const s = readJson(STATE_FILE)
    return isObj(s) ? s : {}
  } catch {
    return {}
  }
}

export function saveState(state: Obj): void {
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    const tmp = STATE_FILE.replace(/\.json$/, '.tmp')
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, STATE_FILE)
  } catch {
    // the state is only a cache
  }
}

// ----------------------------------------------------------------------------- themes ----

function run(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  return r.status === 0 || r.stdout ? String(r.stdout ?? '') : ''
}

/** Best-effort light/dark detection. Terminal hint first, then the OS. Cached for 60s. */
export function systemTheme(state: Obj): string {
  const cached = isObj(state.theme_cache) ? state.theme_cache : {}
  if (nowS() - (cached.at ?? 0) < 60 && cached.value) return cached.value
  let value: string | null = null
  const fgbg = process.env.COLORFGBG ?? ''             // "15;0" = light fg on dark bg (xterm, rxvt, ...)
  const last = fgbg.split(';').at(-1) ?? ''
  if (fgbg && /^\d+$/.test(last)) value = ['7', '15'].includes(String(Number(last))) ? 'light' : 'dark'
  if (value === null) {
    try {
      if (process.platform === 'darwin') {
        value = run('defaults', ['read', '-g', 'AppleInterfaceStyle']).toLowerCase().includes('dark') ? 'dark' : 'light'
      } else if (process.platform === 'win32') {
        const out = run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'])
        const m = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out)
        if (m) value = Number.parseInt(m[1], 16) ? 'light' : 'dark'
      } else {
        const out = run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme']).trim()
        if (out) value = out.toLowerCase().includes('dark') ? 'dark' : 'light'
      }
    } catch {
      value = null
    }
  }
  value = value || 'dark'
  state.theme_cache = { at: nowS(), value }
  return value
}

const PALETTE: Record<string, Record<string, RGB>> = {
  dark: { text: [205, 214, 244], dim: [127, 132, 156], track: [69, 71, 90],
    accent: [137, 180, 250], sep: [88, 91, 112],
    green: [46, 204, 113], yellow: [249, 205, 52], red: [240, 82, 82] },
  light: { text: [36, 41, 47], dim: [101, 109, 118], track: [208, 215, 222],
    accent: [9, 105, 218], sep: [175, 184, 193],
    green: [26, 150, 70], yellow: [190, 130, 0], red: [207, 34, 46] },
}

export class Style {
  p: Record<string, RGB>
  theme: string
  color: boolean
  ascii: boolean
  truecolor: boolean

  constructor(theme: string, color = true, asciiOnly = false) {
    this.p = PALETTE[theme]
    this.theme = theme
    this.color = color
    this.ascii = asciiOnly
    const ct = (process.env.COLORTERM ?? '').toLowerCase()
    this.truecolor = ct === 'truecolor' || ct === '24bit' || Boolean(process.env.WT_SESSION)
  }

  fg(rgb: RGB): string {
    if (!this.color) return ''
    const [r, g, b] = rgb.map(roundHalfEven)
    return this.truecolor ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256(r, g, b)}m`
  }

  paint(text: string, keyOrRgb: string | RGB, bold = false): string {
    const rgb = typeof keyOrRgb === 'string' ? this.p[keyOrRgb] : keyOrRgb
    if (!this.color) return text
    return `${bold ? '\x1b[1m' : ''}${this.fg(rgb)}${text}\x1b[0m`
  }
}

export function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16
    if (r > 248) return 231
    return roundHalfEven((r - 8) / 247 * 24) + 232
  }
  return 16 + 36 * roundHalfEven(r / 255 * 5) + 6 * roundHalfEven(g / 255 * 5) + roundHalfEven(b / 255 * 5)
}

function lerp(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t))
  return [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * k) as RGB
}

/** Green (held to 50%) -> yellow at `warn` -> red at `crit`, blended smoothly in between. */
export function levelColor(style: Style, pct: number, warn: number, crit: number): RGB {
  const { green: g, yellow: y, red: r } = style.p
  const hold = Math.min(50, warn - 1)
  if (pct <= hold) return g
  if (pct <= warn) return lerp(g, y, (pct - hold) / (warn - hold))
  if (pct <= crit) return lerp(y, r, (pct - warn) / (crit - warn))
  return r
}

// ----------------------------------------------------------------------------- numbers ---

export function human(n: unknown): string {
  const v0 = Number(n) || 0
  for (const [unit, size] of [['B', 1e9], ['M', 1e6], ['K', 1e3]] as [string, number][]) {
    if (v0 >= size) {
      const v = v0 / size
      const s = v < 100 ? v.toFixed(1) : v.toFixed(0)
      return (s.endsWith('.0') ? s.slice(0, -2) : s) + unit
    }
  }
  return String(Math.trunc(v0))
}

export function money(amount: number, symbol = '£'): string {
  return formatMoney(amount, symbol, 100)
}

export function mmss(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** {modelId: entry} from data/model-prices.json ({} if missing or unreadable). */
export function loadModelPrices(): Obj {
  if (modelPricesCache === null) {
    modelPricesCache = {}
    for (const path of MODEL_PRICES_FILES) {
      try {
        const data = readJson(path) as Obj
        modelPricesCache = isObj(data?.models) ? data.models : {}
        break
      } catch {
        continue
      }
    }
  }
  return modelPricesCache!
}

/** Canonical id for a Claude model name or id, e.g. 'Opus 5.5' or 'claude-opus-5-5[1m]' ->
 *  'claude-opus-5-5'; 'claude-3-5-haiku-20241022' -> 'claude-3-5-haiku'. null if not Claude. */
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

export type Rates = { input: number, output: number, cache_write_5m: number, cache_write_1h: number, cache_read: number, long_context?: Obj }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const dashed = (s: string) => s.toLowerCase().replace(/[\s._]+/g, '-')
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) throw new TypeError(`not a number: ${String(v)}`)
  return n
}

/** Per-million-token USD rates: input, output, cache_write_5m, cache_write_1h, cache_read
 *  (plus long_context when the model has a long-prompt tier). */
export function ratesFor(model: string | null | undefined, cfg: Obj): Rates {
  const m = (model || '').toLowerCase()
  let best: [string, number, number, number | null] | null = null
  for (const [k, v] of Object.entries(isObj(cfg.prices) ? cfg.prices : {})) {   // user overrides: most specific key wins
    try {
      const key = dashed(String(k))
      if (key && Array.isArray(v) && new RegExp(`(?<![a-z0-9])${escapeRe(key)}(?![0-9])`).test(dashed(m)) &&
          (best === null || key.length > best[0].length)) {
        best = [key, num(v[0]), num(v[1]), v.length > 2 ? num(v[2]) : null]
      }
    } catch {
      // a malformed override is ignored
    }
  }
  if (best) {
    const [, pin, pout, pread] = best
    return { input: pin, output: pout, cache_write_5m: pin * CACHE_WRITE_5M, cache_write_1h: pin * CACHE_WRITE_1H,
      cache_read: pread === null ? pin * CACHE_READ : pread }
  }
  const entry = loadModelPrices()[claudeModelId(m) || '']
  if (isObj(entry)) {
    try {
      const pin = num(entry.input)
      const rates: Rates = { input: pin, output: num(entry.output),
        cache_write_5m: num(entry.cache_write_5m ?? pin * 1.25),
        cache_write_1h: num(entry.cache_write_1h ?? pin * 2.0),
        cache_read: num(entry.cache_read ?? pin * 0.1) }
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
  return { input: pin, output: pout, cache_write_5m: pin * 1.25, cache_write_1h: pin * 2.0, cache_read: pin * 0.1 }
}

/** [input, output] USD per million tokens. */
export function priceFor(model: string | null | undefined, cfg: Obj): [number, number] {
  const r = ratesFor(model, cfg)
  return [r.input, r.output]
}

/** Cost of one usage object (one request) in USD: the model's input, output, cache-write and
 *  cache-read rates, Haiku-style long-prompt tiers, and fast mode at 2x. */
export function usageCostUsd(u: Obj, model: string | null | undefined, cfg: Obj): number {
  let r = ratesFor(model, cfg)
  const cc = isObj(u.cache_creation) ? u.cache_creation : {}
  const w1h = int(cc.ephemeral_1h_input_tokens)
  let w5m = int(cc.ephemeral_5m_input_tokens)
  if (!(w1h || w5m)) w5m = int(u.cache_creation_input_tokens)
  const inp = int(u.input_tokens)
  const read = int(u.cache_read_input_tokens)
  const lc = r.long_context
  if (lc && inp + w5m + w1h + read > int(lc.threshold)) {
    r = { ...r, ...Object.fromEntries(Object.entries(lc).filter(([k]) => k !== 'threshold').map(([k, v]) => [k, Number(v)])) }
  }
  const usd = (inp * r.input + int(u.output_tokens) * r.output + w5m * r.cache_write_5m + w1h * r.cache_write_1h +
    read * r.cache_read) / 1e6
  return u.speed === 'fast' ? usd * FAST_MULTIPLIER : usd
}

// ----------------------------------------------------------------------------- transcript

export function parseTs(s: unknown): number | null {
  if (s === null || s === undefined || s === '' || s === 0) return null
  if (typeof s === 'number') return s > 1e11 ? s / 1000 : s
  const t = Date.parse(String(s))
  return Number.isNaN(t) ? null : t / 1000
}

function mtime(p: string): number {
  try {
    return statSync(p).mtimeMs / 1000
  } catch {
    return 0
  }
}

function newestJsonl(directory: string): string | null {
  let best: string | null = null
  let bestM = 0
  try {
    for (const f of readdirSync(directory)) {
      if (!f.endsWith('.jsonl')) continue
      const m = mtime(join(directory, f))
      if (m > bestM) [best, bestM] = [join(directory, f), m]
    }
  } catch {
    // unreadable folder
  }
  return best
}

const tok = (u: Obj) => [int(u.input_tokens), int(u.output_tokens), int(u.cache_creation_input_tokens), int(u.cache_read_input_tokens)]

/** Incrementally read a Claude-style JSONL transcript. Returns an object of running totals.
 *
 *  Streamed assistant entries repeat the same message id, so the latest usage for an id replaces
 *  the earlier one (the repeats are consecutive, so remembering the last id is enough). */
export function scanTranscript(path: string, state: Obj, cfg: Obj): Obj | null {
  if (!isFile(path)) return null
  state.transcripts = isObj(state.transcripts) ? state.transcripts : {}
  const cache: Obj = state.transcripts
  let st: Obj = cache[path]
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (!isObj(st) || (st.offset ?? 0) > size) {
      st = { offset: 0, tok: { input: 0, output: 0, cw: 0, cr: 0 }, cost: 0.0, last_id: null, last_u: null,
        last_cost: 0.0, last_cache_ts: null, ttl_1h: false, ctx: 0, model: null, msgs: 0 }
    }
    if (size > st.offset) {
      const chunk = Buffer.alloc(size - st.offset)
      let got = 0
      while (got < chunk.length) {
        const n = readSync(fd, chunk, got, chunk.length - got, st.offset + got)
        if (n <= 0) break
        got += n
      }
      const end = chunk.subarray(0, got).lastIndexOf(0x0a)
      if (end >= 0) {
        for (const raw of chunk.subarray(0, end + 1).toString('utf8').split(/\r?\n/)) {
          if (!raw.includes('"usage"')) continue
          let ev: Obj
          try {
            ev = JSON.parse(raw)
          } catch {
            continue
          }
          const msg: Obj = isObj(ev?.message) ? ev.message : {}
          const u = msg.usage
          if (ev.type !== 'assistant' || !isObj(u)) continue
          const model = msg.model || st.model
          if (model && model !== '<synthetic>') st.model = model
          const mid = msg.id || ev.uuid || null
          if (mid !== null && mid === st.last_id && st.last_u) {
            const [pi, po, pw, pr] = tok(st.last_u)               // replace the earlier streamed copy
            st.tok.input -= pi
            st.tok.output -= po
            st.tok.cw -= pw
            st.tok.cr -= pr
            st.cost -= st.last_cost
          } else {
            st.msgs += 1
          }
          const c = usageCostUsd(u, model, cfg)
          const [i, o, w, r] = tok(u)
          st.tok.input += i
          st.tok.output += o
          st.tok.cw += w
          st.tok.cr += r
          st.cost += c
          st.last_id = mid
          st.last_u = u
          st.last_cost = c
          if (!ev.isSidechain) st.ctx = i + r + w
          if (r + w) {
            const ts = parseTs(ev.timestamp)
            if (ts) {
              st.last_cache_ts = ts
              const cc = isObj(u.cache_creation) ? u.cache_creation : {}
              if (int(cc.ephemeral_1h_input_tokens)) st.ttl_1h = true
              else if (int(cc.ephemeral_5m_input_tokens)) st.ttl_1h = false
            }
          }
        }
        st.offset += end + 1
      }
    }
  } finally {
    closeSync(fd)
  }
  st.seen = nowS()
  cache[path] = st
  const keys = Object.keys(cache)
  if (keys.length > 20) {                                  // keep the state file small: drop least recently used
    for (const k of keys.sort((a, b) => (cache[a].seen ?? 0) - (cache[b].seen ?? 0)).slice(0, keys.length - 20)) delete cache[k]
  }
  return st
}

// ----------------------------------------------------------------------------- gather ----

export type Info = { model: string, total: number, cost: number, symbol: string, estimated: boolean, pct: number,
  ttl: number, remaining: number | null }

/** Collapse whatever the CLI told us (plus the transcript) into the numbers we display. */
export function gather(payload: Obj, cfg: Obj, state: Obj): Info {
  const cw: Obj = isObj(payload.context_window) ? payload.context_window : {}
  let model: Obj = payload.model
  if (typeof model === 'string') model = { id: model }
  else if (!isObj(model)) model = {}
  const modelId: string = model.id || ''
  let name: string = model.display_name || modelId || ''
  const tpath = payload.transcript_path
  let st: Obj | null = null
  let eventsFile: string | null = null
  if (tpath) {
    const p = String(tpath)
    if (isDir(p)) {                                         // Copilot: a session-state directory
      eventsFile = newestJsonl(p)
      if (eventsFile) st = scanTranscript(eventsFile, state, cfg)
    } else if (isFile(p)) {
      eventsFile = p
      st = scanTranscript(p, state, cfg)
    }
  }
  const hasTx = Boolean(st && st.msgs)
  if (!name && hasTx && st!.model) name = st!.model

  // ---- total tokens (everything the session has processed, cache reads included)
  let total: number
  if (hasTx) {
    const t = st!.tok
    total = t.input + t.output + t.cw + t.cr
  } else {
    total = cw.total_tokens ?? ['total_input_tokens', 'total_output_tokens', 'total_cache_read_tokens',
      'total_cache_write_tokens'].reduce((a, k) => a + int(cw[k]), 0)
  }

  // ---- cost in USD -> display currency
  let costUsd = isObj(payload.cost) ? payload.cost.total_cost_usd : undefined
  let estimated = false
  if (costUsd === undefined || costUsd === null) {
    estimated = true
    if (hasTx) {
      costUsd = st!.cost
    } else {
      const u = { input_tokens: cw.total_input_tokens, output_tokens: cw.total_output_tokens,
        cache_read_input_tokens: cw.total_cache_read_tokens, cache_creation_input_tokens: cw.total_cache_write_tokens }
      costUsd = usageCostUsd(u, modelId || name, cfg)
    }
  }
  const [, symbol, rate] = currency(cfg)
  const cost = (Number(costUsd) || 0) * rate

  // ---- context percentage
  let pct = cw.current_context_used_percentage ?? cw.used_percentage
  if (pct === undefined || pct === null) {
    let window = cw.displayed_context_limit || cw.context_window_size
    if (!window) window = /1m\b|\[1m\]/.test(modelId.toLowerCase()) ? 1_000_000 : 200_000
    let used = cw.current_context_tokens
    if ((used === undefined || used === null) && hasTx) used = st!.ctx
    if (used === undefined || used === null) {
      const cu: Obj = isObj(cw.current_usage) ? cw.current_usage : {}
      used = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((a, k) => a + int(cu[k]), 0)
    }
    pct = window ? (used || 0) / window * 100 : 0
  }
  pct = Math.max(0, Math.min(100, Number(pct) || 0))

  // ---- cache expiry
  const ttl = Number(cfg.cache_ttl) || (hasTx && st!.ttl_1h ? 3600 : 300)
  let last: number | null = hasTx ? st!.last_cache_ts : null
  if ((last === null || last === undefined) && eventsFile) last = mtime(eventsFile) || null   // no usage records: use last write time
  const remaining = last === null || last === undefined ? null : Math.max(0, ttl - (nowS() - last))
  return { model: name, total, cost, symbol, estimated, pct, ttl, remaining }
}

// ----------------------------------------------------------------------------- render ----

const PARTIALS = ' ▏▎▍▌▋▊▉'

export function gauge(style: Style, pct: number, width: number, warn: number, crit: number): string {
  if (style.ascii) {
    const filled = roundHalfEven(pct / 100 * width)
    return style.paint('#'.repeat(filled) + '-'.repeat(Math.max(0, width - filled)), levelColor(style, pct, warn, crit))
  }
  const exact = pct / 100 * width
  let full = Math.trunc(exact)
  let part = roundHalfEven((exact - full) * 8)
  if (part === 8) [full, part] = [full + 1, 0]
  const out: string[] = []
  for (let i = 0; i < width; i++) {
    const col = levelColor(style, (i + 0.5) / width * 100, warn, crit)
    if (i < full) out.push(style.paint('█', col))
    else if (i === full && part) out.push(style.paint(PARTIALS[part], col))
    else out.push(style.paint('▒', 'track'))
  }
  return out.join('')
}

export function timerIcons(): string[] {
  const custom = process.env.TOKENOMICS_TIMER_ICONS
  if (custom && custom.split(',').length === 3) return custom.split(',')
  return ['⧗', '⏳︎', '⧖']          // full, half (sand flowing), empty
}

const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** One status line. isStatic=true is for a message that won't redraw: the countdown also says
 *  when (local clock time) the cache goes cold. */
export function render(info: Info, style: Style, cfg: Obj, isStatic = false): string {
  const warn = Number(cfg.warn)
  const crit = Number(cfg.crit)
  const sep = style.paint(style.ascii ? ' | ' : ' │ ', 'sep')
  const parts: string[] = []

  const brand = style.ascii ? '*' : '◆'
  parts.push(style.paint(info.model ? `${brand} ${info.model}`.trim() : brand, 'accent', true))

  const pct = info.pct
  const col = levelColor(style, pct, warn, crit)
  const flag = pct >= crit && !style.ascii ? ' ▲' : pct >= crit ? ' !' : ''
  parts.push(style.paint('ctx ', 'dim') + gauge(style, pct, Math.trunc(Number(cfg.width)), warn, crit) +
    ' ' + style.paint(`${pct.toFixed(0)}%${flag}`, col, true))

  parts.push(style.paint(style.ascii ? 'tok ' : 'Σ ', 'dim') + style.paint(human(info.total), 'text', true))

  parts.push(style.paint((info.estimated ? '~' : '') + money(info.cost, info.symbol ?? '£'), 'text', true))

  const rem = info.remaining
  const ttl = info.ttl
  let [full, half, empty] = timerIcons()
  if (style.ascii) [full, half, empty] = ['[##]', '[# ]', '[  ]']
  if (rem === null) {
    parts.push(style.paint(`${empty} --:--`, 'dim'))
  } else {
    const frac = ttl ? rem / ttl : 0
    let icon: string
    let key: string
    if (rem <= 0) [icon, key] = [empty, 'red']
    else if (frac > 0.75) [icon, key] = [full, 'green']
    else if (frac > 0.25) [icon, key] = [half, 'yellow']
    else [icon, key] = [empty, 'red']
    const when = isStatic && rem > 0 ? ` (cold at ${hhmm(new Date(Date.now() + rem * 1000))})` : ''
    parts.push(style.paint(`${icon} ${mmss(rem)}${when}`, key, true))
  }
  return parts.join(sep)
}

// ----------------------------------------------------------------------------- commands --

function makeStyle(cfg: Obj, state: Obj, args: string[]): Style {
  let theme: string = cfg.theme
  const t = flag(args, '--theme')
  if (t !== null) theme = t.toLowerCase()
  if (theme !== 'light' && theme !== 'dark') theme = systemTheme(state)
  const color = !args.includes('--no-color') && !process.env.NO_COLOR
  const asciiOnly = args.includes('--ascii') || process.env.TOKENOMICS_ASCII === '1'
  return new Style(theme, color, asciiOnly)
}

let stdinPayload: Obj | null = null

function readPayload(): Obj {
  if (stdinPayload !== null) return stdinPayload
  stdinPayload = {}
  if (process.stdin.isTTY) return stdinPayload
  try {
    const raw = readFileSync(0, 'utf8')
    const v = raw.trim() ? JSON.parse(raw) : {}
    stdinPayload = isObj(v) ? v : {}
  } catch {
    stdinPayload = {}
  }
  return stdinPayload
}

/** Newest Claude Code or Copilot transcript on this machine (for --watch). */
function discoverSession(): string | null {
  let best: string | null = null
  let bestM = 0
  for (const root of [join(HOME, '.claude', 'projects'), join(HOME, '.copilot', 'session-state')]) {
    if (!isDir(root)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(root, { recursive: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const rel of entries) {
      if (!rel.endsWith('.jsonl')) continue
      const m = mtime(join(root, rel))
      if (m > bestM) [best, bestM] = [join(root, rel), m]
    }
  }
  return best
}

function demo(args: string[]): number {
  const cfg = loadCfg()
  const style = makeStyle(cfg, {}, args)
  const lines = [`theme: ${style.theme}`, '']
  const cases: [number, number, number, number][] = [[8, 290, 12_300, 0.04], [52, 200, 480_000, 0.42],
    [76, 120, 2_100_000, 1.37], [84, 70, 5_400_000, 3.9], [92, 12, 8_500_000, 6.21], [97, 0, 12_800_000, 14.8]]
  const [, symbol, rate] = currency(cfg)
  for (const [pct, rem, total, usd] of cases) {
    lines.push(render({ model: 'Sonnet 5.5', total, cost: usd * rate, symbol, estimated: false, pct, ttl: 300, remaining: rem }, style, cfg))
  }
  lines.push(render({ model: 'gpt-5', total: 0, cost: 0, symbol, estimated: true, pct: 0, ttl: 300, remaining: null }, style, cfg))
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

function watch(args: string[]): void {
  const path = flag(args, '--path')
  const cfg = loadCfg()
  const tick = () => {
    const state = loadState()
    const style = makeStyle(cfg, state, args)
    const target = path || discoverSession()
    const line = render(gather(target ? { transcript_path: target } : {}, cfg, state), style, cfg)
    saveState(state)
    process.stdout.write('\r\x1b[2K' + line)
  }
  tick()
  setInterval(tick, 1000)
  process.on('SIGINT', () => {
    process.stdout.write('\n')
    process.exit(0)
  })
}

const BAND_FILE = join(CFG_DIR, 'band-sessions.json')

export function bandSessions(): Obj {
  try {
    const data = readJson(BAND_FILE)
    return isObj(data) ? data : {}
  } catch {
    return {}
  }
}

/** Remember that the band draws the line in this session, so --message stays quiet there. */
function bandDrawn(sessionId: string): void {
  const seen = bandSessions()
  if (sessionId in seen) return
  seen[sessionId] = nowS()
  const keep = Object.fromEntries(Object.entries(seen).sort((a, b) => a[1] - b[1]).slice(-50))   // keep the newest 50
  try {
    mkdirSync(CFG_DIR, { recursive: true })
    writeFileSync(BAND_FILE, JSON.stringify(keep), 'utf8')
  } catch {
    // only a hint for --message
  }
}

/** The band is on unless TOKENOMICS_BAND=off or "band": false in the config (--band-off).
 *  It doesn't depend on the CLI statusline: a terminal can have its own status line set and the
 *  desktop app still gets the band. */
export function bandWanted(cfg?: Obj): boolean {
  const env = (process.env.TOKENOMICS_BAND ?? '').trim().toLowerCase()
  if (['off', '0', 'false', 'no'].includes(env)) return false
  if (['on', '1', 'true', 'yes'].includes(env)) return true
  return (cfg ?? loadCfg()).band !== false
}

/** The line's parts, already formatted, for the band (hooks/band.tsx). The band draws
 *  and ticks the countdown itself, from `cold_at` (epoch seconds; null: nothing cached yet).
 *  {"show": false} when the band is off. `--band SESSION_ID`: the band is showing it
 *  in that session, so the after-reply message stays quiet there. */
function asJson(args: string[]): number {
  try {
    if (!bandWanted()) {
      process.stdout.write(JSON.stringify({ show: false }))   // --band-off / TOKENOMICS_BAND=off
      return 0
    }
    const sid = flag(args, '--band')
    if (sid !== null) bandDrawn(sid)
    const cfg = loadCfg()
    const state = loadState()
    const info = gather(readPayload(), cfg, state)
    saveState(state)
    const warn = Number(cfg.warn)
    const crit = Number(cfg.crit)
    const pct = info.pct
    const style = new Style('dark', false, args.includes('--ascii'))
    const rem = info.remaining
    process.stdout.write(JSON.stringify({
      show: true, model: info.model, pct: Math.round(pct * 10) / 10,
      level: pct >= crit ? 'red' : pct >= warn ? 'yellow' : 'green',
      gauge: gauge(style, pct, Math.trunc(Number(cfg.width)), warn, crit),
      tokens: human(info.total),
      cost: (info.estimated ? '~' : '') + money(info.cost, info.symbol ?? '£'),
      ttl: info.ttl, cold_at: rem === null ? null : nowS() + rem,
      icons: timerIcons(),
    }))
  } catch {
    process.stdout.write('{}')
  }
  return 0
}

// ----------------------------------------------------------------------------- apps ------
// Claude Code only draws `statusLine` in the terminal. In the apps, hooks/band.tsx (a mod) shows
// the line from --json: the desktop app's band above the prompt, VS Code's plugin status line.
// Where mods can't run (older Claude Code, mods off), the apps still show a hook's
// "systemMessage", so the Stop hook posts the line once per reply instead.
// CLAUDE_CODE_ENTRYPOINT says where Claude Code runs.

const APP_ENTRYPOINTS = ['desktop', 'vscode', 'jetbrains', 'ide']

/** True when Claude Code runs inside an app that doesn't draw status lines. */
export function inApp(): boolean {
  const entry = (process.env.CLAUDE_CODE_ENTRYPOINT ?? '').trim().toLowerCase()
  return APP_ENTRYPOINTS.some((k) => entry.includes(k))
}

/** Stop hook: the band's stand-in where mods can't run. Prints {"systemMessage": <the line as
 *  plain text>} in the desktop app or VS Code while the band is on and hasn't drawn in this
 *  session; otherwise nothing (the terminal has its statusline). Never fails. */
function message(): number {
  try {
    const payload = readPayload()
    if (!inApp() || !bandWanted()) return 0
    if (payload.stop_hook_active) return 0                 // a hook made Claude continue: wait for the real end
    if (payload.session_id in bandSessions()) return 0     // the band already shows it
    const cfg = loadCfg()
    const state = loadState()
    const style = new Style('dark', false, process.env.TOKENOMICS_ASCII === '1')
    const line = render(gather(payload, cfg, state), style, cfg, true)
    saveState(state)
    process.stdout.write(JSON.stringify({ systemMessage: line }))
  } catch {
    // never in the way
  }
  return 0
}

function saveCfg(changes: Obj): void {
  let cfg: Obj = {}
  try {
    const data = readJson(cfgFile())
    if (isObj(data)) cfg = data
  } catch {
    // start a new one
  }
  Object.assign(cfg, changes)
  mkdirSync(CFG_DIR, { recursive: true })
  writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
}

async function updateRate(): Promise<number> {
  const url = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=GBP,EUR'
  let usdGbp: number
  let usdEur: number
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const rates = ((await r.json()) as Obj).rates
    usdGbp = num(rates.GBP)
    usdEur = num(rates.EUR)
  } catch (e) {
    process.stdout.write(`Could not fetch the rates (${e instanceof Error ? e.message : e}). Set them by hand: TOKENOMICS_USD_GBP=0.76, ` +
      `TOKENOMICS_USD_EUR=0.86, or "usd_gbp" / "usd_eur" in ${CFG_FILE}\n`)
    return 1
  }
  saveCfg({ usd_gbp: usdGbp, usd_eur: usdEur })
  process.stdout.write(`USD->GBP = ${usdGbp}, USD->EUR = ${usdEur} saved to ${CFG_FILE}\n`)
  return 0
}

function setCurrency(value: string | null): number {
  const code = currencyCode(value)
  if (!code) {
    process.stdout.write(`Unknown currency ${JSON.stringify(value)}: use one of ${Object.keys(CURRENCIES).join(', ')}.\n`)
    return 1
  }
  saveCfg({ currency: code })
  process.stdout.write(`Costs will now show in ${code} (${CURRENCIES[code][0]}). Saved to ${CFG_FILE}\n`)
  return 0
}

/** Value after `name` in args, or null. */
function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name)
  return i >= 0 && i < args.length - 1 ? args[i + 1] : null
}

/** A CLI settings file that isn't valid JSON: nothing is changed. */
export class SettingsError extends Error {}

function readSettings(path: string): Obj {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const data = JSON.parse(text)
    if (!isObj(data)) throw new Error('not an object')
    return data
  } catch {
    throw new SettingsError(`${path} is not valid JSON; fix it first (nothing was changed).`)
  }
}

function writeSettings(path: string, data: Obj): void {
  if (existsSync(path)) copyFileSync(path, join(dirname(path), basename(path) + '.tokenomics.bak'))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

export function settingsPath(target: string): string {
  if (target === 'claude') return join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'settings.json')
  if (target === 'copilot') return join(process.env.COPILOT_HOME || join(HOME, '.copilot'), 'settings.json')
  throw new SettingsError('target must be claude, copilot or both')
}

export function installedCopy(): string {
  return join(CFG_DIR, COPY_NAME)
}

function samePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

/** Copy this script and the price list to a stable path that survives plugin updates. */
function copyFiles(): string {
  mkdirSync(CFG_DIR, { recursive: true })
  const dest = installedCopy()
  if (!samePath(SELF, dest)) copyFileSync(SELF, dest)
  for (const prices of MODEL_PRICES_FILES.slice(1)) {        // prices travel with it
    if (isFile(prices)) {
      copyFileSync(prices, join(CFG_DIR, 'model-prices.json'))
      break
    }
  }
  return dest
}

/** The statusLine command in a CLI's settings, or null. Never throws. */
export function statusLine(target: string): string | null {
  try {
    const line = (readJson(settingsPath(target)) as Obj).statusLine
    return isObj(line) && line.command ? String(line.command) : null
  } catch {
    return null
  }
}

export function isOurs(command: string | null): boolean {
  return Boolean(command) && command!.includes(CFG_DIR) && [COPY_NAME, ...OLD_NAMES].some((n) => command!.includes(n))
}

/** Ours, but still pointing at an older copy (the pre-v1.4 statusbar.py, or the Python statusline.py). */
function isOld(command: string | null): boolean {
  return isOurs(command) && !command!.includes(COPY_NAME)
}

/** TOKENOMICS_STATUSLINE (or its old name TOKENOMICS_STATUSBAR): auto, ask or off. */
function statuslineMode(): string {
  for (const name of ['TOKENOMICS_STATUSLINE', 'TOKENOMICS_STATUSBAR']) {
    const v = (process.env[name] ?? '').trim().toLowerCase()
    if (v) return v
  }
  return ''
}

const HINT_FILE = join(CFG_DIR, 'statusline-offered')
const quiet = () => {}

/** Move an older install to the current names. Quiet; never throws.
 *
 *  statusbar.json -> statusline.json, statusbar-offered -> statusline-offered, the CLIs'
 *  statusLine commands re-pointed at statusline.mts, and the old copies and state removed. */
export function migrate(): void {
  try {
    if (existsSync(OLD_CFG_FILE) && !existsSync(CFG_FILE)) renameSync(OLD_CFG_FILE, CFG_FILE)
    const oldHint = join(CFG_DIR, 'statusbar-offered')
    if (existsSync(oldHint) && !existsSync(HINT_FILE)) renameSync(oldHint, HINT_FILE)
    for (const t of ['claude', 'copilot']) if (isOld(statusLine(t))) install(t, { out: quiet })
    if (!['claude', 'copilot'].some((t) => isOld(statusLine(t)))) {
      for (const name of [...OLD_NAMES, 'statusbar-state.json']) {
        try {
          unlinkSync(join(CFG_DIR, name))
        } catch {
          // not there
        }
      }
    }
  } catch {
    // never in the way
  }
}

/** The command the CLIs run: this Node.js, and the installed copy. */
function command(): string {
  return `"${process.execPath}" --disable-warning=ExperimentalWarning "${installedCopy()}"`
}

export function install(target: string, opts: { remove?: boolean, keepExisting?: boolean, out?: (s: string) => void } = {}): void {
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'))
  let targets = target === 'both' ? ['claude', 'copilot'] : [target]
  for (const t of targets) settingsPath(t)                   // validate before touching anything
  if (opts.keepExisting) {                                   // never replace someone else's status line
    for (const t of targets) {
      const other = statusLine(t)
      if (other && !isOurs(other)) out(`Skipped ${t}: it already has a status line (${other}). Run --install ${t} to replace it.`)
    }
    targets = targets.filter((t) => !(statusLine(t) && !isOurs(statusLine(t))))
    if (!targets.length) return
  }
  const dest = opts.remove ? installedCopy() : copyFiles()
  for (const t of targets) {
    const path = settingsPath(t)
    const data = readSettings(path)
    if (t === 'claude') {
      if (opts.remove) delete data.statusLine
      else data.statusLine = { type: 'command', command: command(), padding: 0, refreshInterval: 1 }
    } else {
      data.feature_flags = isObj(data.feature_flags) ? data.feature_flags : {}
      data.feature_flags.enabled = Array.isArray(data.feature_flags.enabled) ? data.feature_flags.enabled : []
      if (opts.remove) {
        delete data.statusLine
      } else {
        data.statusLine = { type: 'command', command: command(), padding: 1 }
        if (!data.feature_flags.enabled.includes('STATUS_LINE')) data.feature_flags.enabled.push('STATUS_LINE')
      }
    }
    writeSettings(path, data)
    out(`${opts.remove ? 'Removed from' : 'Installed in'} ${path} (backup: settings.json.tokenomics.bak)`)
  }
  if (!opts.remove) {
    if (!['claude', 'copilot'].some((t) => isOld(statusLine(t)))) {   // older copies, if nothing points at them now
      for (const name of OLD_NAMES) {
        try {
          unlinkSync(join(CFG_DIR, name))
        } catch {
          // not there
        }
      }
    }
    out(`Restart the CLI to pick it up. Preview: node "${dest}" --demo --theme light`)
  }
}

function status(): number {
  const lines: string[] = []
  for (const t of ['claude', 'copilot']) {
    const cmd = statusLine(t)
    const where = settingsPath(t)
    if (isOurs(cmd)) lines.push(`${t} statusline: installed (${where})`)
    else if (cmd) lines.push(`${t} statusline: another status line is set in ${where}: ${cmd}`)
    else lines.push(`${t} statusline: not installed`)
  }
  lines.push('claude band (desktop app): ' + (bandWanted() ? 'on' : 'off') + (process.env.TOKENOMICS_BAND ? ' (TOKENOMICS_BAND)' : ''))
  process.stdout.write(lines.join('\n') + '\n')
  return 0
}

function setBand(on: boolean): number {
  saveCfg({ band: on })
  process.stdout.write(`The band in the Claude desktop app is now ${on ? 'on' : 'off'}; it changes at the next ` +
    `reply. Saved to ${CFG_FILE}\n`)
  return 0
}

function same(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b))
  } catch {
    return false
  }
}

/** True when the installed copy or its price list differs from the one beside this script. */
function outOfDate(): boolean {
  if (!same(installedCopy(), SELF)) return true
  const prices = MODEL_PRICES_FILES.slice(1).find(isFile)
  return Boolean(prices) && !same(join(CFG_DIR, 'model-prices.json'), prices!)
}

/** SessionStart hook. Quiet and fast; never fails the session.
 *
 *  * Installed already: refresh ~/.tokenomics/statusline.mts and the price list from the plugin, so
 *    the statusline updates whenever the plugin does.
 *  * No status line at all: install it (TOKENOMICS_STATUSLINE=ask only says once how to; =off
 *    does nothing).
 *  * Someone else's status line: leave it alone. */
function sync(): number {
  readPayload()                                             // the hook payload; not needed
  try {
    migrate()
    const mode = statuslineMode()
    const cmd = statusLine('claude')
    if (isOurs(cmd) || isOurs(statusLine('copilot'))) {
      if (outOfDate()) copyFiles()
      return 0
    }
    if (cmd || mode === 'off') return 0
    let msg: string
    if (!['ask', 'tip', 'manual'].includes(mode)) {          // default (unset / auto): install it
      install('claude', { out: quiet })
      const where = inApp() ? 'it shows at the bottom of Claude Code in a terminal; here, in the band above the prompt box'
        : 'restart Claude Code to see it'
      msg = `tokenomics: statusline installed; ${where}. Tip: to get tokenomics updates automatically, ` +
        'open /plugin > Marketplaces > tokenomics and turn on auto-update.'
    } else {
      if (existsSync(HINT_FILE)) return 0
      mkdirSync(CFG_DIR, { recursive: true })
      writeFileSync(HINT_FILE, new Date().toISOString(), 'utf8')
      msg = 'tokenomics: want the live cost and cache statusline? Run /tokenomics:statusline. This tip shows once.'
    }
    process.stdout.write(JSON.stringify({ systemMessage: msg }))
  } catch {
    // never in the way
  }
  return 0
}

async function main(args: string[]): Promise<number> {
  if (args.includes('--install') || args.includes('--uninstall')) {
    const f = args.includes('--install') ? '--install' : '--uninstall'
    const next = args[args.indexOf(f) + 1]
    const target = next && !next.startsWith('-') ? next : 'claude'
    try {
      install(target, { remove: f === '--uninstall', keepExisting: args.includes('--keep-existing') })
    } catch (e) {
      if (!(e instanceof SettingsError)) throw e
      process.stderr.write(e.message + '\n')
      return 1
    }
    return 0
  }
  if (args.includes('--sync')) return sync()
  if (args.includes('--band-on') || args.includes('--band-off')) return setBand(args.includes('--band-on'))
  if (args.includes('--message')) return message()
  if (args.includes('--json')) return asJson(args)
  if (args.includes('--status')) return status()
  if (args.includes('--update-rate')) return updateRate()
  if (args.includes('--set-currency')) return setCurrency(flag(args, '--set-currency'))
  const cur = currencyCode(flag(args, '--currency'))
  if (cur) process.env.TOKENOMICS_CURRENCY = cur              // this run only; beats env and config
  if (args.includes('--demo')) return demo(args)
  if (args.includes('--watch')) {
    watch(args)
    return 0
  }
  try {
    const cfg = loadCfg()
    const state = loadState()
    const style = makeStyle(cfg, state, args)
    const line = render(gather(readPayload(), cfg, state), style, cfg)
    saveState(state)
    process.stdout.write(line)
  } catch {
    process.stdout.write('tokenomics')
  }
  return 0
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF)
  } catch {
    return false
  }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2))
