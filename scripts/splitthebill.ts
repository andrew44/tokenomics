#!/usr/bin/env node
/**
 * tokenomics / splitthebill: who or what is consuming the budget? AI spend split the way engineering
 * managers and finance teams ask about it, not just OPEX / CAPEX:
 *
 *   project      the repository (or folder) the work was in
 *   developer    who did it (TOKENOMICS_DEVELOPER, else the computer's user name; never an email)
 *   agent        the main agent and each subagent type, from the transcript (a session's cost is split
 *                by what each agent actually spent)
 *   category     feature, bug fix, refactor, tests, docs, ops, research (from the request; only the
 *                category is kept)
 *   model        and provider (Anthropic API, Bedrock, Vertex ...), split by what each model spent
 *   status       succeeded vs failed, discarded, abandoned, unverified, no change (OutcomeEngine)
 *   worktype     OPEX (running things) vs CAPEX (building things), from spendlens
 *
 *   splitthebill.ts [--days 30 | --month 2026-11] [--by project,developer,agent,...] [--json] [--currency USD]
 *   splitthebill.ts --csv [--days 30]          one row per session, for a spreadsheet or the finance team
 *   splitthebill.ts --db a.db --db b.db        combine several people's databases into one team view
 *
 * Copilot sessions are counted (prompts, i.e. premium requests, and their status from hook events) but
 * never priced: Copilot reports no tokens or money to hooks.
 */
import { existsSync } from 'node:fs'
import { basename } from 'node:path'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import { CostEngine, InsightsEngine } from '../tokenomics/services/index.ts'
import { eventSessions, type EventSession } from '../tokenomics/services/value.ts'
import { argValue, isMain, type Obj } from '../tokenomics/util.ts'
import { allArgs, period, previous, round2, useCurrency, write } from './common.ts'

export const DIMENSIONS = ['project', 'developer', 'agent', 'category', 'model', 'provider', 'status', 'worktype'] as const
export type Dimension = typeof DIMENSIONS[number]

export const DIM_TITLES: Record<string, string> = {
  project: 'By project', developer: 'By developer', agent: 'By agent and subagent', category: 'By task category',
  model: 'By model', provider: 'By provider', status: 'Successful vs unsuccessful work', worktype: 'OPEX (run) vs CAPEX (build)',
}

const keyOf = (dim: Dimension) => (r: ledger.LedgerRow): [string, number][] => {
  switch (dim) {
    case 'project': return [[r.project || basename(r.cwd || '') || 'unknown', 1]]
    case 'developer': return [[r.developer || 'unknown', 1]]
    case 'agent': return InsightsEngine.weights(r.agents, 'main')
    case 'category': return [[r.category || 'unknown', 1]]
    case 'model': return InsightsEngine.weights(r.models, r.model || 'unknown')
    case 'provider': {
      const by = new Map<string, number>()
      for (const [m, w] of InsightsEngine.weights(r.models, r.model || 'unknown')) {
        const p = String((r.models as Obj | null)?.[m]?.provider ?? CostEngine.provider(m))
        by.set(p, (by.get(p) ?? 0) + w)
      }
      return [...by]
    }
    case 'status': return [[r.status || (r.primary !== 'none' ? 'succeeded' : 'unverified'), 1]]
    case 'worktype': return [[r.label ? r.label.toUpperCase() : 'unlabelled', 1]]
  }
}

type Source = { rows: ledger.LedgerRow[], copilot: EventSession[] }

export function load(dbs: string[], since: string, until: string): Source {
  const seen = new Set<string>()
  const out: Source = { rows: [], copilot: [] }
  for (const path of dbs) {
    if (!existsSync(path)) continue
    withDb(path, (db) => {
      for (const r of ledger.rows(db, since, until)) {
        if (seen.has(r.session_id)) continue
        seen.add(r.session_id)
        out.rows.push(r)
      }
      for (const c of eventSessions(db, since)) {
        if (seen.has(c.session_id) || c.last.slice(0, 10) > until) continue
        seen.add(c.session_id)
        out.copilot.push(c)
      }
    }, { readOnly: true })
  }
  return out
}

export function build(args: string[], dbs?: string[]): Obj {
  const p = period(args, 30)
  const paths = dbs ?? (allArgs(args, '--db').length ? allArgs(args, '--db') : [defaultDbPath()])
  const src = load(paths, p.since, p.until)
  const prev = previous(p)
  const before = prev ? load(paths, prev.since, prev.until).rows : []
  const wanted = (argValue(args, '--by') ?? DIMENSIONS.join(',')).split(',').map((d) => d.trim().toLowerCase())
    .filter((d): d is Dimension => (DIMENSIONS as readonly string[]).includes(d))
  const spend = src.rows.reduce((a, r) => a + r.cost_usd, 0)
  const succeeded = src.rows.filter((r) => r.status === 'succeeded').length
  const dims: Obj = {}
  for (const d of wanted) {
    const groups = InsightsEngine.attribute(src.rows, keyOf(d), (r) => r.cost_usd, (r) => r.status ?? null, (r) => r.dead_usd ?? 0)
    const prevGroups = Object.fromEntries(InsightsEngine.attribute(before, keyOf(d), (r) => r.cost_usd).map((g) => [g.key, g.cost_usd]))
    dims[d] = groups.map((g) => ({ ...g, previous_usd: prevGroups[g.key] ?? null,
      change_pct: prevGroups[g.key] ? Math.round((g.cost_usd - prevGroups[g.key]) / prevGroups[g.key] * 1000) / 10 : null }))
  }
  const copilot = src.copilot.length ? {
    sessions: src.copilot.length, prompts: src.copilot.reduce((a, c) => a + c.prompts, 0),
    by_project: InsightsEngine.attribute(src.copilot, (c) => [[c.project || 'unknown', 1]], (c) => c.prompts, (c) => c.status)
      .map((g) => ({ key: g.key, sessions: g.sessions, prompts: g.cost_usd, succeeded: g.succeeded })),
    by_developer: InsightsEngine.attribute(src.copilot, (c) => [[c.developer || 'unknown', 1]], (c) => c.prompts, (c) => c.status)
      .map((g) => ({ key: g.key, sessions: g.sessions, prompts: g.cost_usd, succeeded: g.succeeded })),
    by_status: Object.fromEntries(InsightsEngine.attribute(src.copilot, (c) => [[c.status, 1]], () => 1).map((g) => [g.key, g.sessions])),
  } : null
  return { period: p.label, since: p.since, until: p.until, databases: paths.length, sessions: src.rows.length, spend_usd: round6(spend),
    previous_spend_usd: prev ? round6(before.reduce((a, r) => a + r.cost_usd, 0)) : null,
    succeeded, success_rate: src.rows.length ? round2(succeeded / src.rows.length) : null,
    dead_usd: round6(src.rows.reduce((a, r) => a + (r.dead_usd ?? 0), 0)), dimensions: dims, copilot }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const L = [`# splitthebill: who and what spent the budget, ${r.period}`, '']
  if (!r.sessions && !r.copilot) {
    return [...L, 'Nothing recorded for this window yet. The ledger fills in at the end of every Claude Code turn; ' +
      'backfill with `bangforbuck.ts ingest ~/.claude/projects`.'].join('\n')
  }
  const ch = r.previous_spend_usd ? ` (${r.spend_usd >= r.previous_spend_usd ? '+' : ''}${Math.round((r.spend_usd - r.previous_spend_usd) / r.previous_spend_usd * 100)}% vs the period before)` : ''
  L.push(`**${fmt(r.spend_usd)} across ${r.sessions} sessions${ch}.** ${r.succeeded} succeeded` +
    `${r.dead_usd ? `; ${fmt(r.dead_usd)} went on work that produced nothing (see deadwood)` : ''}.`, '')
  for (const [dim, groups] of Object.entries(r.dimensions as Record<string, Obj[]>)) {
    if (!groups.length) continue
    L.push(`## ${DIM_TITLES[dim] ?? dim}`, '', '| | Sessions | Spend | Share | Succeeded | Per success | Dead | Change |', '|---|---:|---:|---:|---:|---:|---:|---:|')
    for (const g of groups.slice(0, 12)) {
      L.push(`| ${g.key} | ${g.sessions} | ${fmt(g.cost_usd)} | ${Math.round(g.share * 100)}% | ${g.succeeded} | ${fmt(g.cost_per_success_usd)} | ` +
        `${g.dead_usd ? fmt(g.dead_usd) : ''} | ${g.change_pct === null ? '' : `${g.change_pct > 0 ? '+' : ''}${g.change_pct}%`} |`)
    }
    if (groups.length > 12) L.push(`| _${groups.length - 12} more_ | | | | | | | |`)
    L.push('')
  }
  if (r.copilot) {
    const c = r.copilot
    L.push('## Copilot CLI (premium requests, not priced)', '',
      `${c.sessions} sessions, ${c.prompts} prompts. By project: ${c.by_project.map((g: Obj) => `${g.key} ${g.prompts}`).join(', ')}. ` +
      `Status: ${Object.entries(c.by_status).map(([k, v]) => `${v} ${k}`).join(', ')}.`, '')
  }
  L.push('_Agent and model rows split each session by what each actually spent; other rows count each session once. ' +
    '"Per success" = spend ÷ sessions that succeeded (tests green, committed, PR, or accepted)._')
  return L.join('\n')
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}

export function csv(args: string[]): string {
  const p = period(args, 30)
  const paths = allArgs(args, '--db').length ? allArgs(args, '--db') : [defaultDbPath()]
  const src = load(paths, p.since, p.until)
  const { code, rate } = CostEngine.display()
  const head = ['day', 'session_id', 'platform', 'project', 'developer', 'worktype', 'category', 'model', 'provider', 'agents', 'status',
    `cost_${code.toLowerCase()}`, `dead_${code.toLowerCase()}`, 'outcomes', 'prompts']
  const lines = [head.join(',')]
  for (const r of src.rows) {
    lines.push([r.day, r.session_id, 'claude-code', r.project || basename(r.cwd || ''), r.developer, r.label?.toUpperCase(), r.category, r.model,
      r.provider, Object.keys(r.agents ?? {}).join(' '), r.status, (r.cost_usd * rate).toFixed(4), ((r.dead_usd ?? 0) * rate).toFixed(4),
      Object.entries(r.outcomes).map(([k, v]) => `${k}:${v}`).join(' '), r.prompts].map(csvCell).join(','))
  }
  for (const c of src.copilot) {
    lines.push([c.last.slice(0, 10), c.session_id, c.platform, c.project, c.developer, '', '', '', 'github-copilot', '', c.status, '', '', '', c.prompts]
      .map(csvCell).join(','))
  }
  return lines.join('\n')
}

export function main(args: string[]): number {
  if (args.includes('-h') || args.includes('--help')) {
    write('Usage: splitthebill.ts [--days 30 | --month YYYY-MM] [--by project,developer,agent,category,model,provider,status,worktype]\n' +
      '                       [--db FILE]... [--csv | --json] [--currency USD|EUR|GBP]')
    return 0
  }
  if (!useCurrency(args)) return 2
  if (args.includes('--csv')) {
    write(csv(args))
    return 0
  }
  const r = build(args)
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
