#!/usr/bin/env node
/**
 * tokenomics / packlight: what do you carry into every request, and do you ever use it?
 *
 * Before you type a word, every request already holds the system prompt, every connected MCP server's
 * tool definitions, a line for every installed skill, and your instruction files. That fixed load is
 * re-sent with every step of every session, so a server you never call is paid for thousands of times
 * a month. packlight measures it from your own sessions and lists what to take out:
 *
 *   baseline     the context of each session's first request, less your first prompt: the fixed load
 *                you start with (median, and week by week, so a cleanup shows up as a drop)
 *   overhead     what re-reading that baseline cost across the period (cache reads at each step, one
 *                cache write per session), and its share of all spend
 *   MCP servers  every server configured for Claude Code (user, this project, plugins) and Copilot CLI,
 *                with how often its tools were called in the period
 *   skills       every installed skill (user, this project, enabled plugins), the tokens its
 *                description adds to each request, and how often it was used
 *   saving       what dropping the unused skills saves a month (exact: their description tokens);
 *                MCP servers' sizes can't be read without connecting, so packlight shows the
 *                baseline before and after you disable one
 *
 *   packlight.ts [--days 30] [--json] [--currency USD] [--dir PROJECT] [--projects ~/.claude/projects]
 *
 * Read-only: it never changes a setting. Instruction files (CLAUDE.md and friends): see springclean.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import * as trace from '../tokenomics/engine/trace.ts'
import { ratesFor } from '../tokenomics/engine/pricing.ts'
import { CostEngine } from '../tokenomics/services/index.ts'
import { argValue, frontmatterDescription, isMain, isObj, type Obj } from '../tokenomics/util.ts'
import { numArg, recentTranscripts, useCurrency, write } from './common.ts'

const round6 = (v: number) => Math.round(v * 1e6) / 1e6
const median = (xs: number[]) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

export type McpServer = { name: string, source: string, uses: number, last_used: string | null }
export type Skill = { name: string, plugin: string | null, source: string, tokens: number, uses: number, last_used: string | null }

function readJson(path: string): Obj {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'))
    return isObj(v) ? v : {}
  } catch {
    return {}
  }
}

/** Files called `name` under `dir`, at most `depth` folders down. */
function find(dir: string, name: string, depth: number, out: string[] = []): string[] {
  if (depth < 0 || out.length > 2000) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.isFile() && e.name === name) out.push(join(dir, e.name))
    else if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') find(join(dir, e.name), name, depth - 1, out)
  }
  return out
}

/** [marketplace, plugin] for a file inside ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/... */
function pluginOf(path: string, cache: string): [string, string] | null {
  const rel = path.startsWith(cache + sep) ? path.slice(cache.length + 1).split(sep) : null
  return rel && rel.length > 2 ? [rel[0], rel[1]] : null
}

/** Every configured MCP server and installed skill, for Claude Code and Copilot CLI. */
export function inventory(cwd: string, home = homedir()): { mcp: McpServer[], skills: Skill[] } {
  const mcp: McpServer[] = []
  const addServers = (servers: unknown, source: string) => {
    if (!isObj(servers)) return
    for (const name of Object.keys(servers)) {
      if (!mcp.some((m) => m.name === name && m.source === source)) mcp.push({ name, source, uses: 0, last_used: null })
    }
  }
  const claudeJson = readJson(join(home, '.claude.json'))
  addServers(claudeJson.mcpServers, 'user')
  addServers(isObj(claudeJson.projects) ? claudeJson.projects[cwd]?.mcpServers : null, 'this project (local)')
  addServers(readJson(join(cwd, '.mcp.json')).mcpServers, 'this project (.mcp.json)')
  addServers(readJson(join(home, '.copilot', 'mcp-config.json')).mcpServers, 'Copilot CLI')

  const settings = readJson(join(home, '.claude', 'settings.json'))
  const enabled: Obj = isObj(settings.enabledPlugins) ? settings.enabledPlugins : {}
  const cache = join(home, '.claude', 'plugins', 'cache')
  const isOn = (p: [string, string] | null) => !p || enabled[`${p[1]}@${p[0]}`] !== false
  for (const f of find(cache, '.mcp.json', 4)) {
    const p = pluginOf(f, cache)
    if (isOn(p)) addServers(readJson(f).mcpServers, `plugin ${p ? p[1] : basename(dirname(f))}`)
  }

  const skills: Skill[] = []
  const addSkill = (file: string, source: string, plugin: string | null) => {
    const text = (() => {
      try {
        return readFileSync(file, 'utf8').slice(0, 4000)
      } catch {
        return ''
      }
    })()
    const name = /^name:\s*(.+)$/m.exec(text)?.[1].trim().replace(/^["']|["']$/g, '') || basename(dirname(file))
    if (skills.some((s) => s.name === name && s.plugin === plugin)) return      // another cached version
    const desc = frontmatterDescription(file) ?? ''
    skills.push({ name, plugin, source, tokens: trace.approxTokens(name.length + desc.length) + 6, uses: 0, last_used: null })
  }
  for (const [root, source] of [[join(home, '.claude', 'skills'), 'user'], [join(cwd, '.claude', 'skills'), 'this project']] as const) {
    for (const f of find(root, 'SKILL.md', 2)) addSkill(f, source, null)
  }
  const pluginSkills = find(cache, 'SKILL.md', 6).sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs                         // newest version first
    } catch {
      return 0
    }
  })
  for (const f of pluginSkills) {
    const p = pluginOf(f, cache)
    if (isOn(p)) addSkill(f, `plugin ${p ? p[1] : '?'}`, p ? p[1] : null)
  }
  return { mcp, skills }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_')

type SessionStat = { baseline: number, steps: number, usdPerToken: number, spend: number, day: string }

/** One transcript: its baseline, steps, and the MCP servers and skills it used. */
export function scan(path: string, mcp: McpServer[], skills: Skill[]): SessionStat | null {
  let text: string
  try {
    text = trace.readText(path)[0]
  } catch {
    return null
  }
  const t = trace.parseText(text, path)
  const main = t.turns.filter((x) => !x.sidechain && x.ctx > 0)
  if (!main.length) return null
  const day = new Date((main[0].ts ?? statSync(path).mtimeMs / 1000) * 1000).toISOString().slice(0, 10)
  const used = (item: { uses: number, last_used: string | null }) => {
    item.uses++
    if (!item.last_used || day > item.last_used) item.last_used = day
  }
  for (const s of t.steps) {
    const m = /^mcp__(.+?)__/.exec(s.name)
    if (m) {
      const server = norm(m[1])
      const hit = mcp.filter((x) => server === norm(x.name) || server.endsWith('_' + norm(x.name)))
      hit.forEach(used)
    }
    if (s.name === 'Skill' && s.input.skill) {
      const [a, b] = String(s.input.skill).split(':')
      const name = b ?? a
      const plugin = b ? a : null
      skills.filter((k) => k.name === name && (!plugin || !k.plugin || k.plugin === plugin)).forEach(used)
    }
  }
  for (const m of text.matchAll(/<command-name>\/?([\w:.-]+)<\/command-name>/g)) {
    const [a, b] = m[1].split(':')
    skills.filter((k) => k.name === (b ?? a)).forEach(used)
  }
  const firstPrompt = t.prompts[0]?.text ?? ''
  const baseline = Math.max(0, main[0].ctx - trace.approxTokens(firstPrompt.length))
  const r = ratesFor(main[0].model)
  const usdPerToken = (main.reduce((a, x) => a + ratesFor(x.model).cache_read, 0) + r.cache_write_5m) / 1e6
  return { baseline, steps: main.length, usdPerToken, spend: trace.costUsd(t), day }
}

/** Monday of the ISO week a day falls in. */
function weekOf(day: string): string {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d.toISOString().slice(0, 10)
}

export function build(args: string[]): Obj {
  const days = Math.max(0, Math.trunc(numArg(args, '--days', 30)))
  const cwd = resolve(argValue(args, '--dir') ?? process.cwd())
  const root = argValue(args, '--projects') ?? undefined
  const { mcp, skills } = inventory(cwd)
  const stats = recentTranscripts(days, root).map((p) => scan(p, mcp, skills)).filter((s): s is SessionStat => s !== null)
  const baselines = stats.map((s) => s.baseline)
  const overhead = stats.reduce((a, s) => a + s.baseline * s.usdPerToken, 0)
  const spend = stats.reduce((a, s) => a + s.spend, 0)
  const perToken = stats.reduce((a, s) => a + s.usdPerToken, 0)              // USD per token of baseline, over the period
  const toMonth = days ? 30 / days : 1
  const weeks = new Map<string, number[]>()
  for (const s of stats) {
    const w = weekOf(s.day)
    weeks.set(w, [...(weeks.get(w) ?? []), s.baseline])
  }
  const unusedSkills = stats.length ? skills.filter((s) => !s.uses) : []
  const unusedMcp = stats.length ? mcp.filter((m) => !m.uses && m.source !== 'Copilot CLI') : []
  const skillTokens = skills.reduce((a, s) => a + s.tokens, 0)
  const unusedTokens = unusedSkills.reduce((a, s) => a + s.tokens, 0)
  return {
    days, period: days ? `last ${days} days` : 'all time', dir: cwd, sessions: stats.length,
    requests: stats.reduce((a, s) => a + s.steps, 0),
    baseline: { median: median(baselines), max: baselines.length ? Math.max(...baselines) : 0,
      by_week: [...weeks.entries()].sort().map(([week, xs]) => ({ week, median: median(xs), sessions: xs.length })) },
    overhead_usd: round6(overhead), spend_usd: round6(spend), overhead_share: spend ? Math.round(overhead / spend * 100) / 100 : 0,
    overhead_per_month_usd: round6(overhead * toMonth),
    mcp: mcp.sort((a, b) => a.uses - b.uses || a.name.localeCompare(b.name)),
    skills: skills.sort((a, b) => a.uses - b.uses || b.tokens - a.tokens),
    skill_tokens: skillTokens,
    unused: { mcp: unusedMcp.map((m) => ({ name: m.name, source: m.source })),
      skills: unusedSkills.map((s) => ({ name: s.plugin ? `${s.plugin}:${s.name}` : s.name, source: s.source, tokens: s.tokens })) },
    savings: { tokens_per_request: unusedTokens, per_month_usd: round6(unusedTokens * perToken * toMonth),
      basis: stats.length ? `${unusedTokens.toLocaleString('en-GB')} tokens of unused skill descriptions x ${stats.reduce((a, s) => a + s.steps, 0).toLocaleString('en-GB')} requests in ${days ? `${days} days` : 'all time'}, at cache-read prices` : 'no sessions in the period' },
  }
}

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const n = (v: number) => Math.round(v).toLocaleString('en-GB')
  const L = [`# packlight: what every request carries, ${r.period}`, '']
  if (!r.sessions) {
    L.push('No Claude Code sessions found in this period, so there is nothing to measure use against yet. ' +
      `Configured: ${r.mcp.length} MCP servers, ${r.skills.length} skills (${n(r.skill_tokens)} tokens of descriptions).`)
    return L.join('\n')
  }
  L.push(`**Every session starts with about ${n(r.baseline.median)} tokens** before your first word (${r.sessions === 1 ? 'one session' : `median of ${r.sessions} sessions; the largest was ${n(r.baseline.max)}`}). ` +
    `Re-reading it at each of ${n(r.requests)} requests cost **${fmt(r.overhead_usd)}** (${Math.round(r.overhead_share * 100)}% of ${fmt(r.spend_usd)}), about ${fmt(r.overhead_per_month_usd)} a month.`, '')
  if (r.baseline.by_week.length > 1) {
    L.push('**Baseline by week:** ' + r.baseline.by_week.map((w: Obj) => `${w.week} ${n(w.median)}`).join(' · '), '')
  }
  if (r.mcp.length) {
    L.push('## MCP servers', '', '| Server | Where | Tool calls |', '|---|---|---:|')
    for (const m of r.mcp) L.push(`| ${m.name} | ${m.source} | ${m.uses ? `${m.uses} (last ${m.last_used})` : m.source === 'Copilot CLI' ? 'n/a' : '**none**'} |`)
    L.push('')
  }
  const skills = r.skills.filter((s: Obj) => !s.uses).slice(0, 15)
  if (r.skills.length) {
    L.push('## Skills', '', `${r.skills.length} installed, ${n(r.skill_tokens)} tokens of descriptions in every request. ` +
      `${r.unused.skills.length} not used in this period${skills.length ? ':' : '.'}`, '')
    for (const s of skills) L.push(`- ${s.plugin ? `${s.plugin}:` : ''}${s.name} (${s.source}, ${s.tokens} tokens)`)
    if (r.unused.skills.length > skills.length) L.push(`- ...and ${r.unused.skills.length - skills.length} more (\`--json\` lists them all)`)
    L.push('')
  }
  L.push('## Pack lighter', '')
  if (r.unused.mcp.length) {
    L.push(`- **Disconnect the MCP servers you never called** (${r.unused.mcp.map((m: Obj) => m.name).join(', ')}): \`claude mcp remove <name>\`, ` +
      'or switch them off per project in `/mcp`. A plugin\'s server goes when you disable the plugin. Each one\'s tool definitions are part of the baseline above: ' +
      'run packlight again next week and the drop shows in **Baseline by week**.')
  }
  if (r.unused.skills.length) {
    L.push(`- **Remove or disable the unused skills**: saves ${n(r.savings.tokens_per_request)} tokens a request, about **${fmt(r.savings.per_month_usd)} a month** (${r.savings.basis}).`)
  }
  L.push('- **Trim instruction files**: CLAUDE.md, AGENTS.md and their imports are in the baseline too. `springclean` audits them.')
  L.push('', '_Costs are estimates from your transcripts at cache-read prices, not a bill._')
  return L.join('\n')
}

export function main(args: string[]): number {
  if (!useCurrency(args)) return 2
  const r = build(args)
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
