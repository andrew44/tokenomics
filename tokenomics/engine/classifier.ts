/**
 * Work classifier: is a session OPEX (running/observing the estate) or CAPEX (building)?
 *
 * OPEX  = insights, logs, metrics, Grafana, incidents, troubleshooting live systems.
 * CAPEX = generating, changing, refactoring or testing code.
 *
 * One implementation for every platform. Input is platform-neutral SessionEvidence.
 * Tune the pattern lists below to your estate.
 */
import { TOOL_CODE_EDIT, TOOL_SHELL, TOOL_SKILL, type Prompt, type SessionEvidence, type ToolCall } from './evidence.ts'

export const LABELS = ['opex', 'capex', 'mixed', 'unknown'] as const
export type Label = typeof LABELS[number]
export type Side = 'opex' | 'capex' | null

// [pattern, weight]; patterns run against the lower-cased text
export const OPEX_PATTERNS: [string, number][] = [
  [String.raw`\bgrafana\b`, 3], [String.raw`\bloki\b`, 3], [String.raw`\bprometheus\b|\bpromql\b|\blogql\b`, 3],
  [String.raw`\bkibana\b|\bsplunk\b|\bdatadog\b|\bapp ?insights\b|\bkql\b|\bcloudwatch\b`, 3],
  [String.raw`\bdashboards?\b`, 2], [String.raw`\bmetrics?\b`, 2], [String.raw`\blogs?\b`, 2], [String.raw`\btraces?\b|\bspans?\b`, 2],
  [String.raw`\binsights?\b`, 2], [String.raw`\balerts?\b|\bincidents?\b|\bon-?call\b|\bpostmortem\b`, 2],
  [String.raw`\blatency\b|\bp9[59]\b|\berror rate\b|\bthroughput\b|\bslo\b|\bsli\b|\buptime\b`, 2],
  [String.raw`\bwhy (is|was|did|are)\b|\binvestigat\w+|\bdiagnos\w+|\btroubleshoot\w*`, 1],
  [String.raw`\bkubectl (logs|top|describe|get)\b`, 2],
]
export const CAPEX_PATTERNS: [string, number][] = [
  [String.raw`\b(implement|build|create|write|generate|scaffold|add|develop)\b.{0,40}` +
   String.raw`\b(function|class|module|endpoint|api|component|service|script|feature|test|` +
   String.raw`migration|schema|cli|app|page|hook|library)\b`, 4],
  [String.raw`\brefactor\w*|\brewrite\b|\bport (this|to)\b|\bmigrate (this|the) code\b`, 3],
  [String.raw`\bfix (the |this )?(bug|failing test|compile|build error|type error)\b`, 3],
  [String.raw`\bunit tests?\b|\bintegration tests?\b|\bwrite tests\b`, 3],
  [String.raw`\bcode\b|\bcodebase\b|\bpull request\b|\bpr\b|\bcommit\b`, 1],
  ['```', 1],
  [String.raw`\b(python|typescript|javascript|golang|rust|java|c#|terraform|dockerfile|yaml|sql)\b`, 1],
]
export const TOOL_WEIGHT = 3                   // per code-edit call (CAPEX) or observability tool call (OPEX)
const OPEX_TOOL_HINT = /grafana|loki|prometheus|datadog|kibana|splunk|cloudwatch|sentry/i

export const SKILL_WEIGHT = 6                  // per distinct skill judged OPEX or CAPEX
const SKILL_OPEX = new RegExp(
  String.raw`grafana|loki|prometheus|datadog|kibana|splunk|sentry|observab\w*|monitor\w*|telemetry|` +
  String.raw`\blogs?\b|\blogging\b|metrics?|insights?|incidents?|alerts?|traces?|tracing|dashboards?|` +
  String.raw`\bsre\b|on-?call|postmortem|usage|cost|finops|triage|diagnos\w*|troubleshoot\w*`, 'i')
const SKILL_CAPEX = new RegExp(
  String.raw`\bcode\b|coding|refactor\w*|\btests?\b|testing|frontend|backend|\bapi\b|scaffold\w*|` +
  String.raw`implement\w*|\bbuild\b|\bcommit\b|\bpr\b|pull-?request|\blint\w*|\bdebug\w*|migrat\w*|` +
  String.raw`feature|component|plugin-authoring|skill-creator|\bdesign\b|\bdocker\w*|terraform|` +
  String.raw`\bsdk\b|\bcli\b|generate|\bdev\b`, 'i')
const DESC_OPEX = new RegExp(String.raw`\banaly[sz]\w*|\binvestigat\w+|\bquer(y|ies)\b|\bmonitor\w*|\bdiagnos\w+|` +
  String.raw`\bobservab\w+|\btelemetry\b|\bkql\b|\bpromql\b|\bsla\b|\bslo\b`, 'gi')
const DESC_CAPEX = new RegExp(String.raw`\bnunit\b|\bxunit\b|\bmstest\b|\bjunit\b|\bpytest\b|\bjest\b|\bmocha\b|` +
  String.raw`\bunit tests?\b|\bcreate|\bgenerat\w+|\bimplement\w*|\bscaffold\w*|\brefactor\w*|` +
  String.raw`\bwrite (code|tests?)\b|\.net\b|\bc#|\bapi\b|\bcomponents?\b|\bsource code\b`, 'gi')

const compiled = new Map<string, RegExp>()
function rx(p: string): RegExp {
  let r = compiled.get(p)
  if (!r) compiled.set(p, (r = new RegExp(p)))
  return r
}

function count(re: RegExp, text: string): number {
  return text.match(re)?.length ?? 0
}

export function score(text: string): [number, number] {
  const t = (text || '').toLowerCase()
  let o = 0
  let c = 0
  for (const [p, w] of OPEX_PATTERNS) if (rx(p).test(t)) o += w
  for (const [p, w] of CAPEX_PATTERNS) if (rx(p).test(t)) c += w
  return [o, c]
}

export function labelFor(o: number, c: number): Label {
  if (o + c === 0) return 'unknown'
  const hi = Math.max(o, c)
  const lo = Math.min(o, c)
  if (lo && lo / hi >= 0.75) return 'mixed'
  return o > c ? 'opex' : 'capex'
}

function skillKeys(name: string): [string, string[]] {
  const n = (name || '').trim().replace(/^\/+/, '').toLowerCase()
  return [n, [n, n.split(':').at(-1)!]]
}

function mapped(keys: string[], skillMap?: Record<string, string> | null): Side {
  for (const key of keys) {
    const v = skillMap?.[key]
    if (v === 'opex' || v === 'capex') return v
  }
  return null
}

/** 'opex', 'capex' or null from the skill's name alone (user map wins). */
export function skillSide(name: string, skillMap?: Record<string, string> | null): Side {
  const [n, keys] = skillKeys(name)
  if (!n) return null
  const m = mapped(keys, skillMap)
  if (m) return m
  const o = SKILL_OPEX.test(n)
  const c = SKILL_CAPEX.test(n)
  if (o && !c) return 'opex'
  if (c && !o) return 'capex'
  return null
}

/** -> [side or null, basis]. Priority: user map > name + description evidence. */
export function classifySkill(name: string, desc: string | null | undefined,
  skillMap?: Record<string, string> | null): [Side, string] {
  const [, keys] = skillKeys(name)
  const m = mapped(keys, skillMap)
  if (m) return [m, 'map']
  let o = 0
  let c = 0
  const ns = skillSide(name, skillMap)
  if (ns === 'opex') o += 3
  else if (ns === 'capex') c += 3
  let basis = ns ? 'name' : ''
  if (desc) {
    let [dO, dC] = score(desc)
    dO += 2 * count(DESC_OPEX, desc)
    dC += 1 * count(DESC_CAPEX, desc)
    o += Math.min(dO, 8)
    c += Math.min(dC, 8)
    basis = ns ? 'name+description' : 'description'
  }
  const lab = labelFor(o, c)
  return [lab === 'opex' || lab === 'capex' ? lab : null, basis]
}

/** Evidence from what the session actually did. Arguments are never stored. */
export function scoreTool(call: ToolCall): [number, number] {
  if (call.kind === TOOL_SKILL) return [0, 0]                  // skills are scored once per distinct skill
  if (call.kind === TOOL_CODE_EDIT) return [0, TOOL_WEIGHT]
  if (OPEX_TOOL_HINT.test(call.name || '')) return [TOOL_WEIGHT, 0]
  if (call.kind === TOOL_SHELL) return [score(call.command)[0], 0]   // only OPEX-side signal from shell commands
  return [0, 0]
}

export type SkillDetail = { name: string, side: Side, basis: string, description: string }

export type Classification = {
  label: Label
  opexScore: number
  capexScore: number
  promptCount: number
  skills: string[]
  skillDetail: SkillDetail[]
  skillOpex: number
  skillCapex: number
}

/** Score a session. promptScores=[opex, capex, count] replaces scoring ev.prompts
 *  (used when prompts were scored one at a time and only their scores were kept). */
export function classify(ev: SessionEvidence, skillMap?: Record<string, string> | null,
  promptScores?: [number, number, number]): Classification {
  let o = 0
  let c = 0
  let n = 0
  if (promptScores) {
    [o, c, n] = promptScores
  } else {
    for (const p of ev.prompts) {
      const [po, pc] = score(p.text)
      o += po
      c += pc
      n += 1
    }
  }
  for (const call of ev.toolCalls) {
    const [to, tc] = scoreTool(call)
    o += to
    c += tc
  }
  let so = 0
  let sc = 0
  const names: string[] = []
  const detail: SkillDetail[] = []
  for (const sk of ev.skills) {
    if (names.includes(sk.name)) continue
    names.push(sk.name)
    const [side, basis] = classifySkill(sk.name, sk.description, skillMap)
    if (side === 'opex') so++
    else if (side === 'capex') sc++
    detail.push({ name: sk.name, side, basis: basis || 'none', description: (sk.description || '').slice(0, 200) })
  }
  o += so * SKILL_WEIGHT
  c += sc * SKILL_WEIGHT
  return { label: labelFor(o, c), opexScore: o, capexScore: c, promptCount: n, skills: names, skillDetail: detail,
    skillOpex: so, skillCapex: sc }
}

export function classifyPrompt(p: Prompt): [number, number, Label] {
  const [o, c] = score(p.text)
  return [o, c, labelFor(o, c)]
}
