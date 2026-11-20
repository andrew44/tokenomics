#!/usr/bin/env node
/**
 * tokenomics / budget: daily and per-session spending limits, in your currency (GBP, USD or EUR).
 *
 * Prompt hook (Claude Code: UserPromptSubmit). Shows a notice at 80% of a limit and pauses the
 * next prompt once a limit is reached; send the same prompt again (or start it with
 * "over-budget:") to carry on. Spend is what spendlens recorded, priced like the statusline.
 * Limits are in the display currency: TOKENOMICS_CURRENCY = GBP (default) | USD | EUR.
 * Copilot bills premium requests, not tokens, so it has no spend to budget against.
 *
 * Usage (hook command):  budget.ts [source]      source = claude-code (default) | copilot
 *        budget.ts status                         print today's spend and the limits
 *
 * Env (no limit set = budget does nothing):
 *   TOKENOMICS_BUDGET_DAILY    e.g. 20     per calendar day, all sessions together
 *   TOKENOMICS_BUDGET_SESSION  e.g. 5      per session
 *   TOKENOMICS_BUDGET_WARN     80          percent of a limit at which to show a notice
 *   TOKENOMICS_BUDGET_MODE     block (default) | warn (notices only) | off
 * Always exits 0 on hook runs; a crash never blocks a prompt (errors go to <db>.err).
 */
import { defaultDbPath, loadSettings } from '../tokenomics/config.ts'
import * as budget from '../tokenomics/engine/budget.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import * as store from '../tokenomics/engine/store.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { errText, logErr, readPayload } from '../tokenomics/util.ts'

function status(): void {
  const lim = budget.loadLimits()
  const [code, symbol, rate] = currency.current()
  const db = store.connect(loadSettings().dbPath)
  let spent: number
  try {
    spent = store.dayCostUsd(db) * rate
  } finally {
    db.close()
  }
  const show = (v: number | null) => (v ? currency.formatMoney(v, symbol) : 'not set')
  process.stdout.write(`Spent today: ${currency.formatMoney(spent, symbol)} (${code})\nDaily limit: ${show(lim.daily)}\n` +
    `Session limit: ${show(lim.session)}\nMode: ${lim.mode}\n`)
}

function main(): void {
  const arg = process.argv[2] ?? 'claude-code'
  if (arg === 'status') return status()
  try {
    const limits = budget.loadLimits()
    if (!budget.active(limits)) return
    const payload = readPayload()
    const adapter = getAdapter(arg)
    const prompt = String(payload.prompt || payload.userPrompt || '')
    const db = store.connect(loadSettings().dbPath)
    let d: budget.Decision | null
    try {
      d = budget.check(db, adapter.sessionId(payload), prompt, limits)
    } finally {
      db.close()
    }
    if (d) {
      const out = d.action === 'blocked' ? adapter.blockPrompt(d.message) : adapter.notify(d.message)
      if (out) process.stdout.write(JSON.stringify(out) + '\n')
    }
  } catch (e) {
    logErr(defaultDbPath(), `budget\n${errText(e)}`)
  }
}

main()
