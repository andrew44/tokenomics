/**
 * Display currency (USD, EUR or GBP) for every money figure tokenomics shows.
 *
 * The block below is identical to the one in scripts/statusline.ts, which must stay a single
 * self-contained file; tests/features.test.ts checks they agree. All costs are computed in USD
 * (tokenomics/engine/pricing.ts) and converted only for display or for comparing with a limit.
 */
import { cfg as loadCfg } from './pricing.ts'

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

/** [code, symbol, rate per USD] from the environment and ~/.tokenomics/statusline.json. */
export function current(config?: Record<string, any> | null): [string, string, number] {
  return currency(config === undefined || config === null ? loadCfg() : config)
}
