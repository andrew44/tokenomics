/**
 * InsightsEngine: waste detection and recommendations, on top of what the other engines measured.
 *
 *   forensics      steps that bought no information (sherlock): engine/forensics.ts
 *   loops          the agent going round in circles (groundhog): engine/loops.ts
 *   dead work      spend that produced nothing: failed, discarded and abandoned work, repeated
 *                  debugging inside work that did succeed, generated files nobody used (deadwood)
 *   scope          changes the task didn't ask for: unrequested docs, tests, dependency and config
 *                  changes, renames and reformatting, files outside the task's area (blinkers)
 *   arbitrage      the same workload priced on every equivalent offering, filtered by quality,
 *                  latency and availability, ranked by cost per successful task (bazaar)
 *   attribution    spend grouped by any dimension, with what succeeded and what was dead (splitthebill)
 */
import { basename, dirname } from 'node:path'

import type { Obj } from '../util.ts'
import { ratesFor } from '../engine/pricing.ts'
import { approxTokens, command, EDIT_TOOLS, filePath, type Trace } from '../engine/trace.ts'
import { offeringFor, TIERS, workloadCostUsd, type Offering, type Workload } from './cost.ts'
import { classifyCommand, DEAD, isTestPath, normaliseCommand, passed, type Signals, type Status } from './outcome.ts'
import { relPath } from './telemetry.ts'

export { investigate, summary, type Finding, type Investigation } from '../engine/forensics.ts'
export { detect as detectLoop, DEFAULTS as LOOP_DEFAULTS, type Loop } from '../engine/loops.ts'

const round6 = (v: number) => Math.round(v * 1e6) / 1e6

// ---- dead work ----------------------------------------------------------------------------------

export type DeadItem = { kind: string, usd: number, detail: string }
export type DeadWork = { status: Status, reason: string, dead_usd: number, items: DeadItem[] }

export const DEAD_LABELS: Record<string, string> = {
  failed: 'Failed implementations', discarded: 'Work discarded or rejected', abandoned: 'Abandoned tasks',
  debug_churn: 'Repeated debugging', unused_file: 'Generated files never used',
}

/** Spend in one session that produced nothing. A dead session counts whole; in a live one, only the
 *  debugging churn (a check failing a third time and on) and files written for nothing. */
export function deadWork(t: Trace, verdict: { status: Status, reason: string, signals: Signals }): DeadWork {
  const total = t.turns.reduce((a, x) => a + x.costUsd, 0)
  if ((DEAD as readonly string[]).includes(verdict.status)) {
    return { status: verdict.status, reason: verdict.reason, dead_usd: round6(total), items: [{ kind: verdict.status, usd: round6(total), detail: verdict.reason }] }
  }
  const items: DeadItem[] = []
  const turnCost = (from: number, to: number) => t.turns.slice(Math.max(0, from), to + 1).reduce((a, x) => a + x.costUsd, 0)

  // repeated debugging: the same check failing 3+ times in a row; after the 2nd failure it is churn
  const streaks = new Map<string, number[]>()
  const close = (key: string) => {
    const turns = streaks.get(key)
    if (turns && turns.length >= 3) {
      const usd = turnCost(turns[1] + 1, turns[turns.length - 1])
      if (usd > 0) items.push({ kind: 'debug_churn', usd: round6(usd), detail: `\`${key.slice(0, 60)}\` failed ${turns.length} times in a row` })
    }
    streaks.delete(key)
  }
  for (const s of t.steps) {
    const cmd = command(s)
    const k = classifyCommand(cmd)
    if (!(k === 'test' || k === 'build' || k === 'lint') || s.isError === null) continue
    const key = normaliseCommand(cmd)
    if (passed(s)) close(key)
    else streaks.set(key, [...(streaks.get(key) ?? []), s.turn])
  }
  for (const key of [...streaks.keys()]) close(key)

  // generated files never used: created then deleted, or (nothing shipped) never mentioned again
  const later = (from: number) => t.steps.slice(from + 1).map((x) => JSON.stringify(x.input)).join('\n') + '\n' +
    t.turns.slice(t.steps[from].turn + 1).map((x) => x.text).join('\n')
  t.steps.forEach((s, i) => {
    if (!EDIT_TOOLS.has(s.name) || s.isError !== false || (!/created successfully|file created/i.test(s.resultText) && s.name !== 'create')) return
    const path = filePath(s)
    const base = basename(path)
    if (!base) return
    const deleted = verdict.signals.deletedCreated.includes(path)
    const unreferenced = !verdict.signals.committed && !isTestPath(path) && !later(i).includes(base)
    if (!deleted && !unreferenced) return
    const chars = String(s.input.content ?? s.input.new_string ?? '').length
    const r = ratesFor(t.turns[s.turn]?.model || '')
    const usd = approxTokens(chars) * (r.output + r.cache_write_5m) / 1e6
    if (usd > 0) items.push({ kind: 'unused_file', usd: round6(usd), detail: `${path} ${deleted ? 'was created, then deleted' : 'was never used again'}` })
  })
  const dead = Math.min(total, items.reduce((a, x) => a + x.usd, 0))
  return { status: verdict.status, reason: verdict.reason, dead_usd: round6(dead), items: items.sort((a, b) => b.usd - a.usd) }
}

// ---- scope --------------------------------------------------------------------------------------

export type TaskScope = {
  paths: string[]            // files and folders the task names
  names: string[]            // identifiers it names (backticks, CamelCase, snake_case)
  broad: boolean             // "everywhere", "the whole codebase", "clean up": areas aren't policed
  wantsTests: boolean
  wantsDocs: boolean
  wantsRefactor: boolean
  wantsDeps: boolean
  wantsConfig: boolean
}

const PATH_RE = /(?:^|[\s`'"(])((?:\.{0,2}\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]{1,8}|(?:[\w@.-]+\/)+[\w@.-]*)(?=$|[\s`'"),:;!?])/g
const NAME_RE = /`([^`\s]{3,60})`|\b([a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*|[a-z0-9]+_[a-z0-9_]+)\b/g
const BROAD_RE = /\b(whole|entire|everywhere|throughout|across the (code|repo|project)|codebase|repo-?wide|project-?wide|all (files|modules|the code)|clean ?up|refactor)\b/i

export function taskScope(prompt: string): TaskScope {
  const text = String(prompt ?? '')
  const paths = new Set<string>()
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[1].replace(/^\.\//, '').replace(/[.,]+$/, '')
    if (/^https?:|^www\.|^\d+(\.\d+)+$|^e\.g|^i\.e/i.test(p) || p.length < 3) continue
    paths.add(p)
  }
  const names = new Set<string>()
  for (const m of text.matchAll(NAME_RE)) {
    const n = (m[1] ?? m[2] ?? '').replace(/\(\)$/, '')
    if (n && !paths.has(n)) names.add(n)
  }
  return {
    paths: [...paths], names: [...names], broad: BROAD_RE.test(text),
    wantsTests: /\b(tests?|testing|specs?|coverage|tdd|unit|e2e)\b/i.test(text),
    wantsDocs: /\b(readme|docs?|documentation|document|docstrings?|changelog|comments?|jsdoc)\b/i.test(text),
    wantsRefactor: /\b(refactor|clean ?up|rename|tidy|restructure|simplif(y|ication)|reformat|format|lint|prettier)\b/i.test(text),
    wantsDeps: /\b(depend\w*|packages?|upgrade|bump|install|librar(y|ies)|versions?|lockfile|npm|pip|cargo|gem)\b/i.test(text),
    wantsConfig: /\b(config\w*|ci|workflows?|pipelines?|github actions|docker\w*|tsconfig|eslint|settings?|build)\b/i.test(text),
  }
}

/** Widen a scope with a later request in the same session. */
export function mergeScope(a: TaskScope, b: TaskScope): TaskScope {
  return {
    paths: [...new Set([...a.paths, ...b.paths])], names: [...new Set([...a.names, ...b.names])], broad: a.broad || b.broad,
    wantsTests: a.wantsTests || b.wantsTests, wantsDocs: a.wantsDocs || b.wantsDocs, wantsRefactor: a.wantsRefactor || b.wantsRefactor,
    wantsDeps: a.wantsDeps || b.wantsDeps, wantsConfig: a.wantsConfig || b.wantsConfig,
  }
}

export type Change = { path: string, created: boolean, oldText: string, newText: string }
export type ScopeFinding = { rule: string, path: string, reason: string }

export const SCOPE_LABELS: Record<string, string> = {
  unrequested_docs: 'Documentation nobody asked for', unrequested_tests: 'New tests nobody asked for',
  dependency_change: 'Dependency changes', config_change: 'Build / CI / config changes', formatting_only: 'Reformatting only',
  unrelated_rename: 'Renames (unrelated refactoring)', outside_area: 'Files outside the task', file_count: 'More files than the task needs',
}

const DOC_RE = /\.(md|mdx|rst|adoc|txt)$|(^|\/)docs?\//i
const DEP_FILES = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements[\w.-]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|pom\.xml|build\.gradle(\.kts)?)$/i
const CONFIG_FILES = /(^|\/)(\.github\/|\.gitlab-ci|\.circleci\/|Jenkinsfile|Dockerfile|docker-compose|tsconfig[\w.-]*\.json|\.eslintrc|eslint\.config|\.prettierrc|prettier\.config|biome\.json|\.editorconfig|Makefile|\.env)/i

const norm = (p: string) => p.replaceAll('\\', '/').replace(/^\.\//, '')
const stem = (p: string) => basename(p).replace(/(\.(test|spec))?\.\w+$/i, '').replace(/^test_/, '').toLowerCase()
const area = (p: string) => dirname(norm(p)).split('/').filter((x) => x && x !== '.').slice(0, 2).join('/')

/** Is this path one the task named (or right next to one)? */
export function inScope(scope: TaskScope, path: string): boolean {
  const p = norm(path)
  for (const m of scope.paths.map(norm)) {
    if (p === m || p.endsWith('/' + m) || m.endsWith('/' + p)) return true
    if (!/\.\w+$/.test(m) && (p.startsWith(m.replace(/\/$/, '') + '/') || p.includes('/' + m.replace(/\/$/, '') + '/'))) return true   // a folder
    if (stem(p) && stem(p) === stem(m)) return true                              // login.ts <-> login.test.ts
  }
  return false
}

function nearScope(scope: TaskScope, path: string, text: string): boolean {
  if (inScope(scope, path)) return true
  const a = area(path)
  if (scope.paths.some((m) => /\.\w+$/.test(m) && area(m) === a && a)) return true
  return scope.names.some((n) => text.includes(n) || stem(path) === n.toLowerCase())
}

const NOT_NAMES = /^(true|false|null|undefined|None|True|False|nil|this|self|return|const|let|var|if|else|and|or|not)$/

/** [old, new] when an edit does nothing but rename one identifier, consistently, in at least two places. */
function renameOnly(a: string, b: string): [string, string] | null {
  const ta = a.match(/[A-Za-z_$][\w$]*|\S/g) ?? []
  const tb = b.match(/[A-Za-z_$][\w$]*|\S/g) ?? []
  if (!ta.length || ta.length !== tb.length) return null
  const map = new Map<string, string>()
  let changed = 0
  for (let i = 0; i < ta.length; i++) {
    if (ta[i] === tb[i]) continue
    if (!/^[A-Za-z_$]/.test(ta[i]) || !/^[A-Za-z_$]/.test(tb[i])) return null
    if (map.has(ta[i]) && map.get(ta[i]) !== tb[i]) return null
    map.set(ta[i], tb[i])
    changed++
  }
  if (map.size !== 1 || changed < 2) return null
  const [from, to] = [...map][0]
  return from.length >= 3 && to.length >= 3 && !NOT_NAMES.test(from) && !NOT_NAMES.test(to) ? [from, to] : null
}

/** Judge one change against the task. `touched` = files already changed in this task. */
export function judgeChange(scope: TaskScope, c: Change, touched: string[], opts: { maxFiles?: number } = {}): ScopeFinding | null {
  const path = norm(c.path)
  if (!path) return null
  const named = inScope(scope, path)
  const text = `${c.oldText}\n${c.newText}`
  const f = (rule: string, reason: string): ScopeFinding => ({ rule, path, reason })
  if (!named && DOC_RE.test(path) && !scope.wantsDocs) {
    return f('unrequested_docs', `${path} is documentation, and the task didn't ask for documentation.`)
  }
  if (!named && c.created && isTestPath(path) && !scope.wantsTests) {
    return f('unrequested_tests', `${path} is a new test file, and the task didn't ask for tests.`)
  }
  if (!named && DEP_FILES.test(path) && !scope.wantsDeps) {
    return f('dependency_change', `${path} changes dependencies, and the task didn't ask for that.`)
  }
  if (!named && CONFIG_FILES.test(path) && !scope.wantsConfig) {
    return f('config_change', `${path} is build, CI or tool configuration, and the task didn't ask to change it.`)
  }
  if (!c.created && c.oldText && c.newText && !scope.wantsRefactor) {
    if (c.oldText !== c.newText && c.oldText.replace(/\s+/g, '') === c.newText.replace(/\s+/g, '')) {
      return f('formatting_only', `this edit to ${path} only changes whitespace or formatting.`)
    }
    const r = renameOnly(c.oldText, c.newText)
    if (r && !scope.names.includes(r[0]) && !scope.names.includes(r[1])) {
      return f('unrelated_rename', `this edit to ${path} only renames \`${r[0]}\` to \`${r[1]}\`, which the task didn't ask for.`)
    }
  }
  const specific = !scope.broad && (scope.paths.length > 0 || scope.names.length > 0)
  const askedKind = (DOC_RE.test(path) && scope.wantsDocs) || (isTestPath(path) && scope.wantsTests) ||
    (DEP_FILES.test(path) && scope.wantsDeps) || (CONFIG_FILES.test(path) && scope.wantsConfig)
  if (specific && !askedKind && !nearScope(scope, path, text)) {
    return f('outside_area', `${path} isn't among the files or code the task named (${[...scope.paths, ...scope.names].slice(0, 4).join(', ')}).`)
  }
  const max = opts.maxFiles ?? Math.max(6, 3 * scope.paths.length)
  if (!scope.broad && !touched.includes(path) && touched.length + 1 > max) {
    return f('file_count', `this would be file number ${touched.length + 1} changed for this task (it named ${scope.paths.length || 'no'} files).`)
  }
  return null
}

export type ScopeReport = { prompts: number, files_changed: number, findings: (ScopeFinding & { usd: number, turn: number })[], out_of_scope_usd: number, session_usd: number }

/** Replay a session's edits against what was asked (each new request widens the scope). */
export function scopeReview(t: Trace, opts: { maxFiles?: number, task?: string } = {}): ScopeReport {
  let scope = taskScope(opts.task ?? '')
  const promptAt = t.prompts.map((p) => p.turn)
  let pi = 0
  const touched: string[] = []
  const findings: ScopeReport['findings'] = []
  const perTurn = new Map<number, number>()
  for (const s of t.steps) perTurn.set(s.turn, (perTurn.get(s.turn) ?? 0) + 1)
  for (const s of t.steps) {
    while (!opts.task && pi < promptAt.length && promptAt[pi] <= s.turn) scope = mergeScope(scope, taskScope(t.prompts[pi++].text))
    if (!EDIT_TOOLS.has(s.name) || s.isError === true) continue
    const path = relPath(filePath(s), t.cwd)
    const created = /created successfully|file created/i.test(s.resultText) || s.name === 'create'
    const finding = judgeChange(scope, { path, created, oldText: String(s.input.old_string ?? ''), newText: String(s.input.new_string ?? s.input.content ?? '') },
      touched, opts)
    if (finding) {
      const turn = t.turns[s.turn]
      findings.push({ ...finding, turn: s.turn, usd: round6((turn?.costUsd ?? 0) / (perTurn.get(s.turn) ?? 1)) })
    }
    if (path && !touched.includes(norm(path))) touched.push(norm(path))
  }
  return { prompts: t.prompts.length, files_changed: touched.length, findings, out_of_scope_usd: round6(findings.reduce((a, x) => a + x.usd, 0)),
    session_usd: round6(t.turns.reduce((a, x) => a + x.costUsd, 0)) }
}

// ---- arbitrage ----------------------------------------------------------------------------------

export type Observed = { sessions: number, success_rate: number | null, latency_s: number | null, availability: number | null }
export type Constraints = { minQuality?: number, maxLatencyS?: number, minAvailability?: number, anyTier?: boolean }
export type Candidate = {
  id: string, provider: string, model: string, tier: string, cost_usd: number, saving_usd: number, saving_pct: number | null,
  quality: number | null, quality_source: 'catalogue' | 'your sessions' | 'same model' | null,
  latency_s: number | null, availability: number | null, cost_per_success_usd: number | null,
  eligible: boolean, why_not: string | null, indicative: boolean, cached_prices: boolean,
}

const tierRank = (t: string) => (TIERS as readonly string[]).indexOf(t)
const family = (m: string) => (/(fable|mythos|opus|sonnet|haiku|gpt|gemini)/.exec(m.toLowerCase()) ?? [''])[0]

/** Price one workload on every offering, and rank the ones that qualify by cost per successful task.
 *  `observed` is what your own sessions measured per model id (success rate, latency, availability). */
export function arbitrage(w: Workload, currentModel: string, list: Offering[], observed: Record<string, Observed> = {}, c: Constraints = {}):
  { current: Candidate | null, candidates: Candidate[], best: Candidate | null } {
  const cur = offeringFor(currentModel, list)
  const obsFor = (o: Offering) => observed[o.model] ?? Object.entries(observed).find(([m]) => offeringFor(m, [o]) === o)?.[1] ?? null
  const curObs = cur ? obsFor(cur) : null
  const curCost = cur ? workloadCostUsd(w, cur) : 0
  const curQuality = cur?.quality ?? (curObs?.success_rate !== null && curObs?.success_rate !== undefined ? curObs.success_rate * 100 : null)
  const rows: Candidate[] = list.map((o) => {
    const obs = obsFor(o)
    const cost = workloadCostUsd(w, o)
    let quality: number | null = o.quality
    let source: Candidate['quality_source'] = quality !== null ? 'catalogue' : null
    if (quality === null && obs?.success_rate !== null && obs?.success_rate !== undefined && obs.sessions >= 3) {
      quality = Math.round(obs.success_rate * 100)
      source = 'your sessions'
    }
    if (quality === null && cur && family(o.model) === family(cur.model) && o.model === cur.model && curQuality !== null) {
      quality = curQuality
      source = 'same model'
    }
    const latency = o.latencyS ?? obs?.latency_s ?? null
    const availability = o.availability ?? obs?.availability ?? null
    let why: string | null = null
    if (!c.anyTier && cur && tierRank(o.tier) < tierRank(cur.tier)) why = `a ${o.tier} model (you use ${cur.tier})`
    else if (c.minQuality !== undefined && quality !== null && quality < c.minQuality) why = `quality ${quality} < ${c.minQuality}`
    else if (c.minQuality !== undefined && quality === null && !(cur && o.model === cur.model)) why = 'no quality evidence'
    else if (c.maxLatencyS !== undefined && latency !== null && latency > c.maxLatencyS) why = `latency ${latency}s > ${c.maxLatencyS}s`
    else if (c.minAvailability !== undefined && availability !== null && availability < c.minAvailability) why = `availability ${availability} < ${c.minAvailability}`
    const success = quality !== null ? Math.max(0.05, quality / 100) : null
    return {
      id: o.id, provider: o.provider, model: o.model, tier: o.tier, cost_usd: round6(cost), saving_usd: round6(curCost - cost),
      saving_pct: curCost ? Math.round((curCost - cost) / curCost * 1000) / 10 : null, quality, quality_source: source,
      latency_s: latency, availability, cost_per_success_usd: success ? round6(cost / success) : null,
      eligible: why === null, why_not: why, indicative: o.indicative, cached_prices: o.cacheRead !== null,
    }
  }).sort((a, b) => a.cost_usd - b.cost_usd)
  const current = cur ? rows.find((r) => r.id === cur.id) ?? null : null
  const value = (r: Candidate) => r.cost_per_success_usd ?? r.cost_usd
  const best = rows.filter((r) => r.eligible).sort((a, b) => value(a) - value(b))[0] ?? null
  return { current, candidates: rows, best }
}

// ---- attribution ----------------------------------------------------------------------------------

export type Group = { key: string, sessions: number, cost_usd: number, share: number, succeeded: number, dead_usd: number,
  cost_per_success_usd: number | null }

/** Spend grouped by `keyOf` (one row can count towards several keys, with its cost split by weight). */
export function attribute<T>(rows: T[], keyOf: (r: T) => [string, number][], costOf: (r: T) => number,
  statusOf: (r: T) => string | null = () => null, deadOf: (r: T) => number = () => 0): Group[] {
  const groups = new Map<string, Group>()
  let all = 0
  for (const r of rows) {
    const cost = costOf(r)
    all += cost
    for (const [key, weight] of keyOf(r)) {
      const g = groups.get(key) ?? { key, sessions: 0, cost_usd: 0, share: 0, succeeded: 0, dead_usd: 0, cost_per_success_usd: null }
      g.sessions += 1
      g.cost_usd += cost * weight
      g.dead_usd += deadOf(r) * weight
      if (statusOf(r) === 'succeeded') g.succeeded += 1
      groups.set(key, g)
    }
  }
  return [...groups.values()].map((g) => ({ ...g, cost_usd: round6(g.cost_usd), dead_usd: round6(g.dead_usd), share: all ? Math.round(g.cost_usd / all * 1000) / 1000 : 0,
    cost_per_success_usd: g.succeeded ? round6(g.cost_usd / g.succeeded) : null })).sort((a, b) => b.cost_usd - a.cost_usd || b.sessions - a.sessions)
}

/** Weight split of an object of {key: {cost_usd}} (agents or models in one session), or [[fallback, 1]]. */
export function weights(parts: Obj | null | undefined, fallback: string): [string, number][] {
  const entries = Object.entries(parts ?? {}).map(([k, v]) => [k, Number((v as Obj)?.cost_usd) || 0] as [string, number])
  const sum = entries.reduce((a, [, v]) => a + v, 0)
  if (!entries.length || sum <= 0) return [[fallback, 1]]
  return entries.filter(([, v]) => v > 0).map(([k, v]) => [k, v / sum])
}
