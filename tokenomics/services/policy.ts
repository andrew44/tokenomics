/**
 * PolicyEngine: budgets, thresholds and enforcement, decided once and expressed per platform.
 *
 * Every guard (budget, diet, groundhog, haggle, blinkers) does the same three things: read its mode
 * and thresholds from settings, decide, and turn the decision into hook output the platform
 * understands. The deciding stays with each guard's rules; the reading and the enforcing live here.
 *
 *   mode()        TOKENOMICS_<NAME> = block | ask | warn | off (anything else: the default)
 *   threshold()   a numeric setting with bounds
 *   enforce()     a decision -> the adapter's hook output. When a platform can't express an action it
 *                 falls back to the nearest one it can: ask -> deny with "ask the user first",
 *                 warn -> nothing (rather than block), so a missing feature never makes a guard stricter.
 */
import type { PlatformAdapter } from '../platform/adapter.ts'
import type { Obj } from '../util.ts'
import * as events from '../engine/events.ts'

export { active as budgetActive, check as checkBudget, limits, loadLimits, type Decision as BudgetDecision, type Limits } from '../engine/budget.ts'

export type Action = 'allow' | 'warn' | 'context' | 'ask' | 'deny' | 'block' | 'interrupt'

/** TOKENOMICS_<name> as one of `allowed` (lower case), else `fallback`. */
export function mode(name: string, fallback: string, allowed: string[]): string {
  const v = (process.env[name] ?? '').trim().toLowerCase()
  return allowed.includes(v) ? v : fallback
}

/** A numeric setting; currency symbols and commas are ignored. Out of range or missing: `fallback`. */
export function threshold(name: string, fallback: number, bounds: { min?: number, max?: number } = {}): number {
  const raw = (process.env[name] ?? '').trim().replace(/^[£€$]+/, '').replaceAll(',', '').replace(/%$/, '')
  const v = raw ? Number(raw) : NaN
  if (!Number.isFinite(v)) return fallback
  if (bounds.min !== undefined && v < bounds.min) return fallback
  if (bounds.max !== undefined && v > bounds.max) return fallback
  return v
}

export const isOff = (name: string) => (process.env[name] ?? '').trim().toLowerCase() === 'off'

/** A decision as the platform's hook output (null: nothing to print). */
export function enforce(adapter: PlatformAdapter, action: Action, message: string): Obj | null {
  switch (action) {
    case 'allow':
      return null
    case 'warn':
      return adapter.notify(message)
    case 'context':
      return adapter.addContext(message) ?? adapter.notify(message)
    case 'ask':
      return adapter.askTool(message) ??
        adapter.denyTool(`${message} Ask the user to confirm before doing this; if they agree, try again.`)
    case 'deny':
      return adapter.denyTool(message)
    case 'block':
      return adapter.blockPrompt(message)
    case 'interrupt':
      return adapter.interrupt(message) ?? adapter.denyTool(message)
  }
}

/** What actually happened once the platform's limits are applied (for the event log). */
export function effective(adapter: PlatformAdapter, action: Action): Action | 'none' {
  const out = enforce(adapter, action, '')
  if (out === null) return action === 'allow' ? 'allow' : 'none'
  if (action === 'ask' && adapter.askTool('') === null) return 'deny'
  return action
}

/** Log a guard's decision to its own event table (engine/events.ts). Never throws. */
export const log = events.log
