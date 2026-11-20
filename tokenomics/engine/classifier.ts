/**
 * Work classifier: is a session OPEX (running/observing the estate) or CAPEX (building)?
 *
 * OPEX  = insights, logs, metrics, Grafana, incidents, troubleshooting live systems.
 * CAPEX = generating, changing, refactoring or testing code.
 *
 * One implementation for every platform. Input is platform-neutral SessionEvidence.
 * Tune the pattern lists below to your estate.
 */
import { bareCommand, classifyCommand } from './outcomes.ts'
import { TOOL_CODE_EDIT, TOOL_SHELL, TOOL_SKILL, type Prompt, type SessionEvidence, type ToolCall } from './evidence.ts'

export const LABELS = ['opex', 'capex', 'mixed', 'unknown'] as const
export type Label = typeof LABELS[number]
export type Side = 'opex' | 'capex' | null

const R = String.raw

// [pattern, weight]; patterns run against the lower-cased text after clean() has removed
// machine-generated blocks and the false friends below. Each pattern counts once per text.
export const OPEX_PATTERNS: [string, number][] = [
  // observability and incident tooling
  [R`\bgrafana\b|\bloki\b|\bprometheus\b|\bkibana\b|\bsplunk\b|\bdatadog\b|\bapp ?insights\b|\bcloudwatch\b|` +
   R`\bnew ?relic\b|\bhoneycomb\b|\bdynatrace\b|\bpagerduty\b|\bopsgenie\b|\bjaeger\b|\blog analytics\b|` +
   R`\bazure monitor\b|\bstackdriver\b|\bsentry\b|\bstatuspage\b`, 3],
  [R`\bpromql\b|\blogql\b|\bkql\b|\btraceql\b`, 4],
  [R`\bdashboards?\b`, 2], [R`\bmetrics?\b`, 2], [R`\blogs\b|\blog (file|line|entr|stream|output)\w*`, 2],
  [R`\btraces\b|\bspans?\b|\bdistributed trac`, 2],
  [R`\binsights?\b`, 2], [R`\balerts?\b|\bincidents?\b|\bon-?call\b|\bpost-?mortem\b|\bpaged?\b(?! (component|layout|title|header))`, 2],
  [R`\blatency\b|\bp9[59]\b|\berror rate\b|\bthroughput\b|\bslos?\b|\bslis?\b|\bslas?\b|\buptime\b|\bburn rate\b|` +
   R`\bdowntime\b|\boutages?\b|\bavailability\b|\berror budget\b|\b(hit|miss|error) (rate|ratio)s?\b|\berror counts?\b|` +
   R`\b[45]\d\ds\b|\b[45]xx\b|\btimeouts\b`, 2],
  [R`\bare we (seeing|getting|hitting)\b|\bis (it|this|that) (still )?(failing|up|down|healthy)\b|\bstatus of\b|\bhealth ?checks?\b|` +
   R`\b(close to|hitting|near) (the |its |our )?(limit|quota|capacity)\b|\bovernight\b|\bwhat changed\b`, 2],
  // a live environment, not a codebase
  [R`\b(in |on |to |from )?(prod|production|staging|live)( env\w*| cluster| servers?| nodes?| db| database)?\b(?! ready)`, 2],
  [R`\b(site|service|api|app|server|database|db) (is|was|went|are) (down|unreachable|slow|flapping)\b|\bis it down\b`, 3],
  [R`\bpods?\b|\bnodes\b|\bcluster\b|\breplicas?\b|\bcrashloop\w*|\boom\s?kill\w*|\bevicted\b|\bhpa\b`, 2],
  [R`\bcpu\b|\bmemory (usage|pressure)\b|\bdisk (usage|space|full)\b|\bload balancer\b|\bqueue (depth|backlog|lag)\b|` +
   R`\bbacklog is\b|\bconsumer lag\b|\bthrottl\w+|\b5xx\b|\b50[0-4]s\b|\bcron ?jobs?\b|\bbatch jobs?\b|\bnightly (job|run|batch)\b|\btls cert\w*|\bcertificates?\b`, 2],
  // operating it: run-book verbs
  [R`\b(restart|reboot|scale (up |down |out |in )?(the )?\w+|roll ?back|rollback|redeploy|fail ?over|rotate|drain|cordon|` +
   R`purge (the )?cache|flush (the )?cache|bounce)\b`, 3],
  // questions about what happened / what the numbers are
  [R`\bwhy (is|was|did|are|were|has|have)\b|\bwhat (caused|happened|is going on|is our|was our)\b|\binvestigat\w+|` +
   R`\bdiagnos\w+|\btroubleshoot\w*|\broot cause\b|\btriage\b`, 2],
  [R`\bhow (many|much|often)\b|\bwhich (pods?|nodes?|users?|endpoints?|customers?|services?|hosts?)\b|\bsigned up\b|\btraffic\b|` +
   R`\bspend\b|\bspent\b|\bbill(ing)?\b|\brevenue\b|\bconversion\b|\bkpis?\b|\busage\b|\bsummari[sz]e\b|\breport on\b`, 2],
  [R`\b(last|past) (night|hour|\d+ ?(h|hours?|m|mins?|minutes?|days?)|24h|week|month|weekend)\b|\byesterday\b|\btoday\b|\bright now\b|` +
   R`\bthis (morning|week|month)\b|\bsince \d|\bat \d{1,2} ?(am|pm)\b|\bover the weekend\b`, 1],
  [R`\b(check|look at|show me|pull|find|grep|search|query|tail)\b.{0,40}\b(logs|metrics|dashboards?|alerts?|errors?|usage|grafana|datadog|cloudwatch)\b`, 2],
  [R`\bkubectl (logs|top|describe|get|rollout|scale|events)\b|\bjournalctl\b|\bdocker logs\b`, 2],
  [R`\bquer(y|ies)\b`, 1],
  [R`\b(write|build|give me|run|create)\b.{0,25}\bquer(y|ies)\b`, 3],   // an ad-hoc query is asking, not building
]
export const CAPEX_PATTERNS: [string, number][] = [
  // building something
  [R`\b(implement|build|create|write|generate|scaffold|add|develop|introduce|instrument|wire( up)?|set up|setup|support)\b.{0,40}` +
   R`\b(function|class|method|module|endpoint|api|component|service|script|feature|tests?|specs?|migration|schema|cli|` +
   R`app|page|hook|library|flag|option|field|column|button|form|modal|dialog|table|pagination|retr(y|ies)|handler|` +
   R`validation|types?|interface|route|middleware|workflow|pipeline|action|module|plugin|command|logging|metrics|tracing|` +
   R`telemetry|cach(e|ing)|support|dark mode|readme|docs|config|spinner|dropdown|sorting|filter\w*)\b`, 4],
  // imperative change requests: the verb that opens a sentence or follows "can you / please"
  [R`(^|[.!?\n]\s*|\b(can|could|would) you (please )?|\bplease\s+|\bpls\s+|\band then\s+|\bnow\s+)` +
   R`(add|implement|build|create|write|refactor|rename|remove|delete|extract|convert|make|update|change|bump|upgrade|move|` +
   R`replace|wire|port|clean ?up|fix|generate|scaffold|split|merge|inline|simplify|optimi[sz]e|document|migrate|` +
   R`rewrite|introduce|instrument|commit|push|review)\b`, 3],
  [R`\brefactor\w*|\brewrite\b|\bport (this|it|to)\b|\bmigrate (this|the|it|to)\b|\bconvert (this|the|it)\b`, 3],
  // something in the code is broken
  [R`\bfix(es|ed|ing)?\b|\bbugs?\b|\bbroken\b|\bregression\b|\bcrash(es|ed|ing)?\b|\bdoesn'?t work\b|\bnot working\b|` +
   R`\b(test|tests|build|compile|compilation|lint|ci|typecheck)\b.{0,20}\b(fail\w*|break\w*|broken|red|error\w*)|` +
   R`\bfail\w*.{0,20}\b(tests?|build|compile|lint|ci)\b|\b(type|syntax|compile|build|lint) errors?\b|\bmemory leak\b|` +
   R`\bexpected .{1,30} (received|got|but)\b|\bmake (the )?tests? pass\b|\bundefined is not\b|\bnull pointer\b`, 3],
  [R`\bunit tests?\b|\bintegration tests?\b|\be2e tests?\b|\bwrite tests\b|\btest coverage\b|\btest (for|the|that)\b`, 3],
  // code and its tooling
  [R`\bcode\b|\bcodebase\b|\bsource\b|\brepo\b|\bfunctions?\b|\bclass(es)?\b|\bmethods?\b|\bcomponents?\b|\bmodules?\b|` +
   R`\bvariables?\b|\bimports?\b|\bdependenc(y|ies)\b|\bpackages?\b|\blibrar(y|ies)\b|\bhelpers?\b|\butils?\b|` +
   R`\bhandlers?\b|\bhooks\b|\bprops?\b|\bstate management\b|\bmigrations?\b|\breadme\b|\bapi routes?\b|` +
   R`\bcache (the|this|these|it)\b|\bin redis\b`, 2],
  [R`\bpull request\b|\bprs?\b|\bcommits?\b|\bbranch(es)?\b|\brebase\b|\bmerge conflicts?\b|\bmain branch\b|` +
   R`\bgithub actions\b|\bci\b|\bpipelines?\b|\blint\w*|\bcompil\w+|\btypecheck\w*`, 2],
  [R`\bbuttons?\b|\bheaders?\b|\bfooter\b|\bmodals?\b|\bdialogs?\b|\bforms?\b|\bcss\b|\bstyles?\b|\blayout\b|\bui\b|` +
   R`\bdropdowns?\b|\bspinners?\b|\binputs?\b|\bcheckbox\w*|\bmenus?\b|\bclick(s|ed|ing)?\b|\bscroll\w*|` +
   R`\bdark mode\b|\bresponsive\b|\bsticky\b|\bfigma\b|\bsettings page\b|\btooltips?\b|\bnavbar\b|\bsidebar\b`, 2],
  ['```', 2],
  [R`\b(python|typescript|javascript|golang|rust|java|kotlin|swift|c#|c\+\+|ruby|php|terraform|dockerfile|bicep|` +
   R`react|vue|angular|svelte|next\.?js|node|deno|django|flask|fastapi|rails|spring|\.net|tailwind|graphql|sql)\b`, 1],
  [R`\b(npm|pnpm|yarn|pip|cargo|gradle|maven|webpack|vite|eslint|prettier|tsc|pytest|jest|vitest|junit|nunit|xunit)\b`, 1],
]
// Code-shaped text, checked on the original (case kept): file paths, identifiers, stack frames.
export const CODE_SHAPE_PATTERNS: [RegExp, number][] = [
  [/[\w./-]+\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|vue|svelte|scss|css|html|sql|tf|proto|ipynb)\b/, 3],
  [/\b[a-z]+[A-Z][a-zA-Z0-9]*\b|\b[a-z]+_[a-z0-9_]+\(|\b[A-Z][a-z]+[A-Z]\w*(Error|Exception|Component|Service|Controller)\b/, 2],
  [/\b(TypeError|ReferenceError|SyntaxError|RangeError|NullPointerException|NullReferenceException|KeyError|AttributeError|ImportError|ModuleNotFoundError|IndexError|ValueError|panic:|Traceback \(most recent call last\))/, 3],
  [/\n\s+at [\w.<>$]+ \(?[^\s)]+:\d+(:\d+)?\)?|File "[^"]+", line \d+/, 3],
]

// Phrases that contain an OPEX word but are about code ("log in", "console.log", "stack trace").
const FALSE_FRIENDS: [RegExp, string][] = [
  [/\b(log|sign)[ -]?(in|out|on)s?\b|\blog(ged|ging)? (them |users? |people )?(in|out)\b/g, ' signin '],
  [/\b(console|logger|logging|log)\.\w+\b|\bgit log\b|\bchange ?logs?\b|\bblog\w*|\bcatalog\w*|\bbacklogs? (item|ticket)s?\b/g, ' codeword '],
  [/\bstack ?traces?\b|\bback ?traces?\b|\btraceback\b/g, ' stacktrace '],
  [/\balert\(|\balert (dialog|box|component|banner|modal)s?\b/g, ' dialog '],
  [/\b(admin|user|analytics)? ?dashboard (page|component|layout|view|ui|screen|route)s?\b/g, ' page '],
  [/\bmetrics? (endpoint|exporter|library|lib|package|middleware|handler)s?\b/g, ' metrics handler '],
]
// Machine-written blocks that land in the user's turn (hook output, command stdout, reminders).
const MACHINE_BLOCKS = /<(system-reminder|local-command-stdout|local-command-stderr|bash-stdout|bash-stderr|bash-input|command-stdout|task-notification|user-prompt-submit-hook)>[\s\S]*?(<\/\1>|$)/g

export function clean(text: string): string {
  let t = (text || '').replace(MACHINE_BLOCKS, ' ').toLowerCase()
  for (const [re, sub] of FALSE_FRIENDS) t = t.replace(re, sub)
  return t
}

export const TOOL_WEIGHT = 3                   // per code-edit call (CAPEX) or observability/operations call (OPEX)
export const DEV_COMMAND_WEIGHT = 2            // per test/lint/build/commit/install shell command (CAPEX)
// Tool and MCP-server names (split into words) that point at observing or operating the estate.
const OPEX_TOOL_HINT = new RegExp(R`(^|[^a-z])(grafana|loki|prometheus|datadog|kibana|splunk|cloudwatch|sentry|pagerduty|` +
  R`opsgenie|newrelic|new_relic|honeycomb|jaeger|tempo|dynatrace|appinsights|applicationinsights|app_insights|` +
  R`loganalytics|log_analytics|kusto|azuremonitor|azure_monitor|elasticsearch|opensearch|statuspage|incident\w*|alerts?|` +
  R`metrics?|logs|query_logs|search_logs|traces|kubernetes|k8s|kubectl|pods?)([^a-z]|$)`, 'i')
const CAPEX_TOOL_HINT = /pull_?request|create_branch|push_files|create_or_update_file|merge_pull|commit/i
// Shell commands that observe or operate a running system (checked on the command with quoted text removed).
const OPS_COMMAND = new RegExp(R`\bkubectl\s+(logs|top|describe|get|rollout|scale|events|exec|port-forward|drain|cordon|delete\s+pod)\b|` +
  R`\bjournalctl\b|\bdocker\s+(logs|stats|ps|restart)\b|\bsystemctl\s+(status|restart|reload|stop|start)\b|` +
  R`\baws\s+(logs|cloudwatch|ecs\s+(describe|update-service)|autoscaling)\b|\baz\s+(monitor|webapp\s+(log|restart))\b|` +
  R`\bgcloud\s+(logging|monitoring)\b|\bhelm\s+(rollback|status|history)\b|\blogcli\b|\bpromtool\b|\btail\s+-[fF]\b|` +
  R`\bcurl\b[^|;&]*(prometheus|grafana|loki|:9090|:3100|/metrics|/health)|\b(top|htop|vmstat|iostat|uptime)\s*($|[|;&])`, 'i')
const DEV_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|run\s+dev|update)\b|\bpip3?\s+install\b|\buv\s+(add|sync)\b|\bpoetry\s+add\b|\bcargo\s+add\b|\bgo\s+(get|mod)\b|\bgit\s+(diff|add|rebase|merge|checkout\s+-b|switch\s+-c|stash|cherry-pick)\b/i

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
  const t = clean(text)
  let o = 0
  let c = 0
  for (const [p, w] of OPEX_PATTERNS) if (rx(p).test(t)) o += w
  for (const [p, w] of CAPEX_PATTERNS) if (rx(p).test(t)) c += w
  const raw = (text || '').replace(MACHINE_BLOCKS, ' ')
  for (const [re, w] of CODE_SHAPE_PATTERNS) if (re.test(raw)) c += w
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
  if (call.kind === TOOL_SHELL) return scoreCommand(call.command)
  if (OPEX_TOOL_HINT.test(call.name || '')) return [TOOL_WEIGHT, 0]
  if (CAPEX_TOOL_HINT.test(call.name || '')) return [0, DEV_COMMAND_WEIGHT]
  return [0, 0]
}

/** A shell command by what it runs, not the words in it: `git log` or `grep "metrics"` is neither side. */
export function scoreCommand(raw: string): [number, number] {
  const cmd = bareCommand(raw || '')
  if (!cmd.trim()) return [0, 0]
  if (OPS_COMMAND.test(cmd) || OPEX_TOOL_HINT.test(cmd.split(/\s+/)[0] || '')) return [TOOL_WEIGHT, 0]
  if (classifyCommand(cmd) || DEV_COMMAND.test(cmd)) return [0, DEV_COMMAND_WEIGHT]
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
