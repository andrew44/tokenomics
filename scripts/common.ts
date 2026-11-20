/** Small command-line helpers shared by the intelligence-engine tools (splitthebill, bazaar, crystalball, deadwood, blinkers). */
import { currencyCode } from '../tokenomics/services/cost.ts'
import { argValue, today } from '../tokenomics/util.ts'
import { shiftDay } from '../tokenomics/engine/ledger.ts'

/** --currency USD|EUR|GBP for this run. False (and a message) for an unknown currency. */
export function useCurrency(args: string[]): boolean {
  const cur = argValue(args, '--currency')
  if (!cur) return true
  const c = currencyCode(cur)
  if (!c) {
    process.stderr.write(`unknown currency ${JSON.stringify(cur)}: use GBP, USD or EUR\n`)
    return false
  }
  process.env.TOKENOMICS_CURRENCY = c
  return true
}

/** A number option (`--devs 10`), or the fallback when missing or not a number. */
export function numArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)
  if (raw === null) return fallback
  const v = Number(String(raw).replace(/[,_£€$%]/g, '').replace(/k$/i, '000').replace(/m$/i, '000000'))
  return Number.isFinite(v) ? v : fallback
}

/** Every value of a repeatable option (`--db a --db b`). */
export function allArgs(args: string[], name: string): string[] {
  const out: string[] = []
  args.forEach((a, i) => {
    if (a === name && i + 1 < args.length) out.push(args[i + 1])
    else if (a.startsWith(name + '=')) out.push(a.slice(name.length + 1))
  })
  return out
}

/** [since, until] for --month YYYY-MM, else the last --days N (default `days`; 0 = all time). */
export function period(args: string[], days = 30): { since: string, until: string, label: string, days: number } {
  const month = argValue(args, '--month')
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number)
    const last = new Date(y, m, 0).getDate()
    return { since: `${month}-01`, until: `${month}-${String(last).padStart(2, '0')}`, label: month, days: last }
  }
  const n = Math.max(0, Math.trunc(numArg(args, '--days', days)))
  const end = today()
  return { since: n ? shiftDay(end, n - 1) : '0000-00-00', until: end, label: n ? `last ${n} days` : 'all time', days: n }
}

/** The period of the same length just before (the calendar month before, for --month). */
export function previous(p: { since: string, days: number, label: string }): { since: string, until: string } | null {
  if (!p.days || p.since === '0000-00-00') return null
  if (/^\d{4}-\d{2}$/.test(p.label)) {
    const [y, m] = p.label.split('-').map(Number)
    const d = new Date(y, m - 2, 1)
    const prev = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return { since: `${prev}-01`, until: shiftDay(`${p.label}-01`, 1) }
  }
  return { since: shiftDay(p.since, p.days), until: shiftDay(p.since, 1) }
}

export const round2 = (v: number) => Math.round(v * 100) / 100
export const pctChange = (a: number, b: number) => (b ? Math.round((a - b) / b * 1000) / 10 : null)
export const write = (s: string) => process.stdout.write(s.endsWith('\n') ? s : s + '\n')
