#!/usr/bin/env node
/**
 * tokenomics / pennywise: a model router. "Penny wise, pound foolish": stop paying top-model
 * prices for trivial prompts, and stop sending hard ones to a model that will flounder.
 *
 * Every prompt gets a complexity score from weighted signals (length, code, reasoning words,
 * technical terms, multi-step structure, simple-task phrases, scope) and lands in one of four tiers.
 * Each tier maps to a model, the way an auto-router (LiteLLM's complexity router and the like) does:
 *
 *   SIMPLE    -> haiku     hello-world, rename, typo, commit message, convert JSON
 *   MEDIUM    -> sonnet    a routine feature or test, a short script
 *   COMPLEX   -> opus      refactors, debugging, multi-file or multi-step work
 *   REASONING -> opus      architecture, proofs, security, trade-offs, root causes
 *
 * Two ways to route:
 *
 *   Hook (default, nothing to set up). UserPromptSubmit in Claude Code. Hooks can't switch the
 *   session's model, so pennywise has the session hand the prompt to a subagent on the tier's model
 *   (the Agent tool's `model` parameter) and relay the answer. Routes down to save money, and up when
 *   a prompt is harder than the session's model.
 *
 *   Proxy (a true per-request router). `pennywise.ts serve` runs a local Anthropic-API proxy; point
 *   Claude Code at it with ANTHROPIC_BASE_URL=http://127.0.0.1:8787 and ANTHROPIC_MODEL=pennywise.
 *   Each new user turn is scored and the request's `model` is rewritten before it goes upstream.
 *   Routing is cache-aware: inside a tool loop the model never changes, and it only moves down to a
 *   cheaper model when the prompt cache is cold or the context is small (a switch means re-writing
 *   the context to the new model's cache). A failed request on a routed model is retried once on
 *   the fallback model.
 *
 * Per-prompt overrides (both modes): start a prompt with
 *   keep-model:   stay on the session's model
 *   haiku: / sonnet: / opus: / fable:   force that model
 *
 * Commands:
 *   pennywise.ts                      hook (reads the hook JSON on stdin)
 *   pennywise.ts explain "prompt"     show the score, the signals and the model it would pick
 *   pennywise.ts serve [--port N]     run the routing proxy (foreground)
 *   pennywise.ts env [--port N]       print the shell lines that point Claude Code at the proxy
 *
 * Env:
 *   TOKENOMICS_PENNYWISE   route (default) | block (pause once, suggest /model) | warn | off
 *                          | proxy (the hook steps aside; the proxy does the routing)
 *   TOKENOMICS_PENNYWISE_UP        on (default) | off: also route prompts UP to a stronger model
 *   TOKENOMICS_ROUTER_TIERS        e.g. "SIMPLE=haiku,MEDIUM=sonnet,COMPLEX=opus,REASONING=fable"
 *   TOKENOMICS_ROUTER_PORT         proxy port (default 8787)
 *   TOKENOMICS_ROUTER_UPSTREAM     where the proxy forwards (default https://api.anthropic.com)
 *   TOKENOMICS_ROUTER_MODELS       request model names the proxy routes (default "pennywise,auto");
 *                                  "*" routes every main-model request
 *   TOKENOMICS_ROUTER_FALLBACK     model to retry on when a routed request fails (default: COMPLEX tier)
 *   TOKENOMICS_ROUTER_STICKY_TOKENS  below this context the proxy may move down while the cache is
 *                                  warm (default 20000)
 *   ~/.tokenomics/router.json      the same settings as a file: {"tiers": {...}, "thresholds": {...}}
 *   TOKENOMICS_DB                  SQLite path shared with spendlens (default ~/.tokenomics/spendlens.db)
 *
 * The hook always exits 0; a crash never blocks a prompt (errors go to <db>.err).
 */
import { closeSync, mkdirSync, openSync, readFileSync, readSync, fstatSync, writeFileSync } from 'node:fs'
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { argValue, errText, isMain, isObj, logErr, now, readStdin, sha1, type Obj } from '../tokenomics/util.ts'

const env = (name: string, fallback = '') => process.env[name] ?? fallback
const mode = () => env('TOKENOMICS_PENNYWISE', 'route').trim().toLowerCase()
const routeUp = () => env('TOKENOMICS_PENNYWISE_UP', 'on').trim().toLowerCase() !== 'off'
const statePath = () => join(dirname(defaultDbPath()), 'pennywise_state.json')
const configPath = () => join(process.env.TOKENOMICS_HOME || join(homedir(), '.tokenomics'), 'router.json')
const PRICES_PATH = join(import.meta.dirname, '..', 'data', 'model-prices.json')

export const FAMILY_TIER: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4, mythos: 4 }
const NAMES: Record<number, string> = { 1: 'Haiku', 2: 'Sonnet', 3: 'Opus', 4: 'Fable' }
const ALIASES: Record<number, string> = { 1: 'haiku', 2: 'sonnet', 3: 'opus', 4: 'fable' }   // values the Agent tool's `model` takes
export const TIERS = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'] as const
const DEFAULT_TIERS: Record<string, string> = { SIMPLE: 'haiku', MEDIUM: 'sonnet', COMPLEX: 'opus', REASONING: 'opus' }
// score >= threshold puts a prompt in that tier (scores run roughly -1 .. +2)
const DEFAULT_THRESHOLDS: Record<string, number> = { MEDIUM: 0.15, COMPLEX: 0.5, REASONING: 0.95 }

const BYPASS_RE = /^\s*keep-model:\s*/i
// Follow-ups that lean on the conversation: a subagent (hook mode) couldn't see what they refer to.
const FOLLOW_UP_RE = new RegExp(String.raw`^\s*(yes|yeah|yep|no|nope|ok(ay)?|sure|thanks|continue|go( ahead| on)?|do it|try again|` +
  String.raw`same|again|that|this|it|now|also|and|but|then)\b|\b(above|previous|earlier|you just|` +
  String.raw`last (one|step|answer)|that (one|file|error|change))\b`, 'i')
const TASK_SIGNALS = new Set(['simple-task', 'small-words', 'technical', 'complex-work', 'reasoning', 'multi-step', 'code'])
const FORCE_RE = /^\s*(haiku|sonnet|opus|fable):\s*/i

const rx = (...ps: string[]) => ps.map((p) => new RegExp(p, 'i'))
const R = String.raw

// [name, weight, patterns]: each pattern that matches adds its weight once, capped per signal.
const SIGNALS: [string, number, RegExp[]][] = [
  ['simple-task', -0.35, rx(
    R`\bhello[ ,-]*world\b`, R`\bfizz ?buzz\b`, R`\bboilerplate\b|\bskeleton\b|\bstarter\b`,
    R`\b(fix|correct) (a |the )?(typo|spelling|grammar)\b`,
    R`\brename\b.{0,30}\b(variable|function|file|method|class)\b`,
    R`\b(add|write|update) (a |some )?(comments?|docstrings?|jsdoc|readme)\b`,
    R`\bcommit message\b`, R`\bgitignore\b|\beditorconfig\b`,
    R`\b(format|lint|prettify|indent|sort)\b.{0,30}\b(file|code|json|yaml|imports?)\b`,
    R`\bconvert\b.{0,30}\b(json|yaml|csv|xml|toml)\b`, R`\bregex\b.{0,30}\b(for|to match)\b`,
    R`\b(what|which) (does|is)\b.{0,40}\b(this|command|flag|syntax|option)\b`,
    R`\bsummari[sz]e\b|\btl;?dr\b`, R`\blist (the |all )?(files|commands|branches)\b`,
    R`\bgit (status|log|diff)\b`, R`\bbump\b.{0,20}\bversion\b`)],
  ['small-words', -0.2, rx(R`\bone[- ]liner\b`, R`\b(simple|basic|quick(ly)?|tiny|small|trivial)\b`)],
  ['build-verb', 0.2, rx(R`\b(create|write|add|make|build|generate|implement)\b`)],
  ['technical', 0.15, rx(
    R`\b(api|endpoint|schema|database|sql|migration|auth\w*|oauth|jwt|cache|queue|kafka|redis)\b`,
    R`\b(kubernetes|k8s|terraform|docker|ci/cd|pipeline|webhook|grpc|graphql)\b`,
    R`\b(async|thread\w*|mutex|lock|transaction|index(es|ing)?|memory|latency)\b`,
    R`\b(test suite|integration tests?|e2e|benchmark)\b`)],
  ['complex-work', 0.4, rx(
    R`\brefactor\w*\b|\brewrite\b|\bmigrat\w+\b`, R`\bdebug\w*\b|\bfix\b.{0,30}\b(bug|crash|leak|flaky)\b`,
    R`\bperformance\b|\boptimi[sz]\w+|\bprofil(e|ing)\b`,
    R`\bacross (the |all )?(repo|codebase|services?|files|modules)\b|\bmulti[- ]?(file|service|module)\b`,
    R`\bfull(y)?\b.{0,20}\b(app|application|platform|system|feature)\b`, R`\bend[- ]to[- ]end\b`,
    R`\bplan\b.{0,20}\b(implementation|rollout|project|migration)\b`)],
  ['reasoning', 0.55, rx(
    R`\barchitect\w*|\bsystem design\b|\bdesign (doc|review)\b`,
    R`\bsecurity\b|\bvulnerab\w+|\bthreat model\b|\bexploit\b`,
    R`\brace condition\b|\bconcurren\w+|\bdeadlock\b|\bdistributed\b|\bconsisten(cy|t hashing)\b`,
    R`\broot cause\b|\bwhy (is|does|did|would)\b.{0,60}\b(fail|crash|hang|leak|slow)\w*`,
    R`\btrade-?offs?\b|\bcompare\b.{0,40}\b(approaches|options|designs)\b|\bpros and cons\b`,
    R`\bprove\b|\bproof\b|\balgorithm\w*\b|\bcomplexity\b.{0,10}\b(time|space|big-?o)\b`,
    R`\bstep[- ]by[- ]step\b|\bthink (it )?through\b|\breason about\b`,
    R`\bresearch\b|\banalys[ei]s\b|\binvestigat\w+`)],
  ['multi-step', 0.3, rx(
    R`\b(first|1\.|step 1)\b[\s\S]{0,300}\b(then|next|2\.|step 2|after that|finally)\b`,
    R`(^|\n)\s*([-*]|\d+[.)])\s+\S[\s\S]*\n\s*([-*]|\d+[.)])\s+\S[\s\S]*\n\s*([-*]|\d+[.)])\s+\S`)],
]
const SIGNAL_CAP: Record<string, number> = { 'simple-task': -0.6, 'small-words': -0.3, 'build-verb': 0.2, technical: 0.45,
  'complex-work': 0.8, reasoning: 1.1, 'multi-step': 0.3 }

const round2 = (v: number) => Math.round(v * 100) / 100

// ------------------------------------------------------------------ config ------------------

export type RouterConfig = { tiers: Record<string, string>, thresholds: Record<string, number> }

export function loadConfig(): RouterConfig {
  const cfg: RouterConfig = { tiers: { ...DEFAULT_TIERS }, thresholds: { ...DEFAULT_THRESHOLDS } }
  try {
    const f = JSON.parse(readFileSync(configPath(), 'utf8'))
    for (const [k, v] of Object.entries(isObj(f.tiers) ? f.tiers : {})) {
      if ((TIERS as readonly string[]).includes(k.toUpperCase())) cfg.tiers[k.toUpperCase()] = String(v)
    }
    for (const [k, v] of Object.entries(isObj(f.thresholds) ? f.thresholds : {})) {
      if (Number.isFinite(Number(v))) cfg.thresholds[k.toUpperCase()] = Number(v)
    }
  } catch {
    // no router.json: the defaults
  }
  for (const part of env('TOKENOMICS_ROUTER_TIERS').split(',')) {
    const i = part.indexOf('=')
    const k = (i >= 0 ? part.slice(0, i) : part).trim().toUpperCase()
    const v = i >= 0 ? part.slice(i + 1).trim() : ''
    if ((TIERS as readonly string[]).includes(k) && v) cfg.tiers[k] = v
  }
  return cfg
}

/** Model name or alias -> 1 (Haiku) .. 4 (Fable), or null for a model we don't know. */
export function tierOf(model: unknown): number | null {
  const m = String(model ?? '').toLowerCase()
  for (const [name, t] of Object.entries(FAMILY_TIER)) if (m.includes(name)) return t
  return null
}

let prices: Obj | null = null

/** 'haiku' -> the newest listed Haiku model id from data/model-prices.json; full ids pass through. */
export function resolveModel(name: string): string {
  if (!name || !Object.values(ALIASES).includes(name.toLowerCase())) return name
  if (prices === null) {
    try {
      const data = JSON.parse(readFileSync(PRICES_PATH, 'utf8'))
      prices = isObj(data.models) ? data.models : {}
    } catch {
      prices = {}
    }
  }
  const ver = (e: Obj) => String(e.version ?? '0').split('.').map((x) => Number.parseInt(x, 10) || 0)
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1)
    return 0
  }
  const fam = Object.entries(prices!).filter(([, v]) => v.family === name.toLowerCase() && v.listed !== false)
  if (!fam.length) return name
  return fam.reduce((best, x) => (cmp(ver(x[1]), ver(best[1])) > 0 ? x : best))[0]
}

// ------------------------------------------------------------------ scoring ----------------

export type Score = { tier: string, score: number, signals: [string, number][], model: string }

/** -> {tier, score, signals, model}. Pure function of the prompt (and context size). */
export function score(prompt: string, contextTokens = 0, config?: RouterConfig): Score {
  const cfg = config ?? loadConfig()
  const words = prompt.split(/\s+/).filter(Boolean).length
  let total = 0
  const hits: [string, number][] = []
  // length: very short prompts lean simple, long ones lean complex
  if (words <= 12) {
    total -= 0.1
    hits.push(['short', -0.1])
  } else if (words > 250) {
    total += 0.45
    hits.push(['long', 0.45])
  } else if (words > 80) {
    total += 0.25
    hits.push(['longish', 0.25])
  }
  if (prompt.includes('```') || /(^|\n)( {4}|\t)\S.*\n( {4}|\t)\S/.test(prompt)) {
    total += 0.3
    hits.push(['code', 0.3])
  }
  for (const [name, weight, pats] of SIGNALS) {
    const n = pats.filter((p) => p.test(prompt)).length
    if (n) {
      const cap = SIGNAL_CAP[name]
      const w = cap < 0 ? Math.max(weight * n, cap) : Math.min(weight * n, cap)
      total += w
      hits.push([name, round2(w)])
    }
  }
  if ((prompt.match(/\?/g)?.length ?? 0) >= 3) {
    total += 0.2
    hits.push(['many-questions', 0.2])
  }
  const th = cfg.thresholds
  let tier = 'SIMPLE'
  for (const t of ['MEDIUM', 'COMPLEX', 'REASONING']) if (total >= th[t]) tier = t
  if (contextTokens > 150_000 && tier === 'SIMPLE') {     // big contexts need more than the smallest model
    tier = 'MEDIUM'
    hits.push(['big-context', 0])
  }
  return { tier, score: round2(total), signals: hits, model: cfg.tiers[tier] }
}

export function forced(prompt: string): string | null {
  const m = FORCE_RE.exec(prompt)
  return m ? m[1].toLowerCase() : null
}

// ------------------------------------------------------------------ logging -----------------

function log(sid: string, model: string | null, suggested: string, reason: string, action: string): void {
  try {
    withDb(defaultDbPath(), (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pennywise_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, ts TEXT,
        model TEXT, suggested TEXT, reason TEXT, action TEXT)`)
      db.run('INSERT INTO pennywise_events(session_id,ts,model,suggested,reason,action) VALUES(?,?,?,?,?,?)',
        sid, now(), model, suggested, reason, action)
    })
  } catch {
    // logging must never break routing
  }
}

// ------------------------------------------------------------------ hook mode ---------------

function lastModel(path: string): string | null {
  try {
    const fd = openSync(path, 'r')
    let text: string
    try {
      const size = fstatSync(fd).size
      const start = Math.max(0, size - 400_000)
      const buf = Buffer.alloc(size - start)
      readSync(fd, buf, 0, buf.length, start)
      text = buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
    for (const line of text.split(/\r?\n/).reverse()) {
      let ev: Obj
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      const m = ev?.message?.model
      if (ev.type === 'assistant' && m && !String(m).startsWith('<') && !ev.isSidechain) return String(m)
    }
  } catch {
    // no transcript
  }
  return null
}

function currentModel(d: Obj): string | null {
  let m = d.model
  if (isObj(m)) m = m.id || m.display_name
  if (tierOf(m)) return String(m)
  if (d.transcript_path) {
    m = lastModel(String(d.transcript_path))
    if (tierOf(m)) return m
  }
  if (tierOf(process.env.ANTHROPIC_MODEL)) return process.env.ANTHROPIC_MODEL!
  const cwd = d.cwd || '.'
  for (const p of [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'),
    join(homedir(), '.claude', 'settings.json')]) {
    try {
      m = JSON.parse(readFileSync(p, 'utf8')).model
      if (tierOf(m)) return String(m)
    } catch {
      continue
    }
  }
  return null
}

function proxyActive(): boolean {
  const port = env('TOKENOMICS_ROUTER_PORT', '8787')
  return mode() === 'proxy' || new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}\\b`).test(env('ANTHROPIC_BASE_URL'))
}

function routeInstruction(tier: number, why: string, up: boolean): string {
  const reason = up ? "it needs more than this session's model" : 'a cheaper model can do it'
  return `[tokenomics pennywise model router] This prompt was scored ${why}, so it is routed to ` +
    `${NAMES[tier]} (${reason}). Do not do the task yourself. Make one call to the Agent tool ` +
    `(the subagent tool) with model: "${ALIASES[tier]}", passing the user's request word for word as its ` +
    'prompt, plus only the facts from this conversation it needs (file paths, names, earlier ' +
    'decisions), since the subagent cannot see this conversation. Then give the user its result ' +
    'briefly, without redoing or re-checking its work. If you have no Agent tool, or the request ' +
    'clearly depends on this conversation in a way you cannot hand over in a few lines, do it ' +
    'yourself as usual.'
}

function route(sid: string, model: string, cur: number, tier: number, why: string): Obj {
  const up = tier > cur
  log(sid, model, NAMES[tier], why, up ? 'routed-up' : 'routed')
  return {
    systemMessage: `pennywise: routing ${up ? 'up' : 'down'} to ${NAMES[tier]} (${why}) instead of ${NAMES[cur]}. ` +
      `Start a prompt with 'keep-model:' to keep it on ${NAMES[cur]}.`,
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: routeInstruction(tier, why, up) },
  }
}

function readState(): Record<string, string> {
  try {
    const s = JSON.parse(readFileSync(statePath(), 'utf8'))
    return isObj(s) ? s : {}
  } catch {
    return {}
  }
}

export function handle(d: Obj): Obj | null {
  const m0 = mode()
  if (m0 === 'off' || m0 === 'proxy' || proxyActive()) return null
  const prompt = String(d.prompt || d.userPrompt || '').trim()
  if (!prompt || prompt.startsWith('/') || BYPASS_RE.test(prompt)) return null
  const model = currentModel(d)
  const cur = tierOf(model)
  if (cur === null) return null
  const sid = String(d.session_id || d.sessionId || 'unknown')
  const f = forced(prompt)
  let tier: number | null
  let why: string
  if (f) {
    [tier, why] = [FAMILY_TIER[f], `forced with '${f}:'`]
  } else {
    const r = score(prompt)
    tier = tierOf(r.model)
    why = `${r.tier}, score ${r.score}`
    // a subagent starts blank: only hand over prompts that stand on their own and clearly read as a task
    if (FOLLOW_UP_RE.test(prompt) || !r.signals.some(([n]) => TASK_SIGNALS.has(n))) return null
  }
  if (tier === null || tier === cur || (tier > cur && !routeUp() && !f)) return null
  if (!(m0 === 'block' || m0 === 'warn') || f || tier > cur) return route(sid, model!, cur, tier, why)   // "route", forced, and upgrades always route

  const digest = sha1(prompt)
  const state = readState()
  if (state[sid] === digest) {                             // same prompt sent again = "I meant it"
    log(sid, model, NAMES[tier], why, 'overridden')
    return null
  }
  const cheaper = NAMES[tier]
  const msg = `pennywise: this prompt scored ${why}, which ${cheaper} can handle, but this session is on ` +
    `${model} (${NAMES[cur]}), a pricier tier. Switch with /model ${cheaper.toLowerCase()} and resend, ` +
    `or send the same prompt again (or start it with 'keep-model:') to run it on ${NAMES[cur]} anyway.`
  if (m0 === 'warn') {
    log(sid, model, cheaper, why, 'warned')
    return { systemMessage: msg }
  }
  delete state[sid]
  state[sid] = digest
  try {
    mkdirSync(dirname(statePath()), { recursive: true })
    writeFileSync(statePath(), JSON.stringify(Object.fromEntries(Object.entries(state).slice(-200))))
  } catch {
    // the pause still works this once
  }
  log(sid, model, cheaper, why, 'blocked')
  return { decision: 'block', reason: msg }
}

// ------------------------------------------------------------------ proxy mode --------------

function text(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.filter((p) => isObj(p) && p.type === 'text').map((p) => p.text ?? '').join(' ')
  return ''
}

function clean(t: string): string {
  return t.replace(/<(system-reminder|command-[a-z-]+|local-command-[a-z-]+)>[\s\S]*?<\/\1>/g, ' ').split(/\s+/).filter(Boolean).join(' ')
}

/** Stable id for a conversation: system prompt head + first user message. */
export function conversationKey(body: Obj): string {
  const sysp = typeof body.system === 'string' ? body.system : text(body.system)
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const firstMsg = msgs.length && isObj(msgs[0]) ? text(msgs[0].content) : ''
  return sha1(sysp.slice(0, 2000) + '\x00' + firstMsg.slice(0, 2000)).slice(0, 16)
}

/** The last message is the user typing (not a tool result coming back mid-loop). */
function newUserTurn(body: Obj): string | null {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const last = msgs.at(-1)
  if (!isObj(last) || last.role !== 'user') return null
  const c = last.content
  if (Array.isArray(c) && c.some((p) => isObj(p) && p.type === 'tool_result')) return null
  return clean(text(c)) || null
}

function uses1hCache(body: Obj): boolean {
  return JSON.stringify(body).slice(0, 200_000).includes('"ttl":"1h"')
}

type Conv = { model: string, ts: number, ttl: number }

/** Per-conversation, cache-aware routing decisions for the proxy. */
export class Router {
  cfg: RouterConfig
  convs = new Map<string, Conv>()
  match: Set<string>
  stickyTokens: number
  fallback: string

  constructor(cfg?: RouterConfig) {
    this.cfg = cfg ?? loadConfig()
    this.match = new Set(env('TOKENOMICS_ROUTER_MODELS', 'pennywise,auto').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))
    this.stickyTokens = Number.parseInt(env('TOKENOMICS_ROUTER_STICKY_TOKENS'), 10) || 20000
    this.fallback = resolveModel(env('TOKENOMICS_ROUTER_FALLBACK') || this.cfg.tiers.COMPLEX)
  }

  routes(model: unknown): boolean {
    const m = String(model ?? '').toLowerCase()
    if (this.match.has(m)) return true
    // "*" routes every request on a main model; Claude Code's small background calls stay put
    const t = tierOf(m)
    return this.match.has('*') && t !== null && t > 1
  }

  /** -> [modelToUse, reason, key, requested] for a /v1/messages body whose model we route. */
  decide(body: Obj, rawLen: number, at?: number): [string, string, string, string] {
    const ts = at ?? Date.now() / 1000
    const requested = String(body.model || '')
    const key = conversationKey(body)
    const ctx = Math.floor(rawLen / 4)
    const ttl = uses1hCache(body) ? 3600 : 300
    const prev = this.convs.get(key)
    const warm = Boolean(prev) && ts - prev!.ts < prev!.ttl
    const turn = newUserTurn(body)
    let choice: string
    let reason: string
    if (prev && !turn) {
      [choice, reason] = [prev.model, 'same turn (tool loop)']
    } else {
      const t = turn || ''
      const f = forced(t)
      if (f) {
        [choice, reason] = [resolveModel(f), `forced ${f}:`]
      } else if (BYPASS_RE.test(t) && prev) {
        [choice, reason] = [prev.model, 'keep-model:']
      } else {
        const r = score(t, ctx, this.cfg)
        choice = resolveModel(r.model)
        reason = `${r.tier} score ${r.score}`
        const tc = tierOf(choice)
        const tp = prev ? tierOf(prev.model) : null
        if (prev && warm && tc && tp && tc < tp && ctx >= this.stickyTokens) {
          [choice, reason] = [prev.model, `${reason}; kept ${prev.model} while its cache is warm`]
        }
      }
      if (this.match.has(choice.toLowerCase()) || (tierOf(choice) === null && !choice.startsWith('claude'))) choice = this.fallback
    }
    this.convs.set(key, { model: choice, ts, ttl })
    if (this.convs.size > 500) {
      for (const [k] of [...this.convs].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100)) this.convs.delete(k)
    }
    return [choice, reason, key, requested]
  }
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'])
const RETRY = new Set([400, 404, 429, 500, 502, 503, 529])

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function forward(upstream: string, method: string, path: string, headers: IncomingMessage['headers'], body: Buffer | null): Promise<IncomingMessage> {
  const url = new URL(upstream + path)
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) out[k] = v
  out['accept-encoding'] = 'identity'
  if (body) out['content-length'] = String(body.length)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const r = send(url, { method, headers: out, timeout: 600_000 }, resolve)
    r.on('error', reject)
    r.on('timeout', () => r.destroy(new Error('upstream timed out')))
    r.end(body ?? undefined)
  })
}

function relay(resp: IncomingMessage, res: ServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(resp.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v
  headers.connection = 'close'
  res.writeHead(resp.statusCode ?? 502, headers)
  res.flushHeaders()
  return new Promise((resolve) => {
    resp.on('data', (chunk: Buffer) => res.write(chunk))         // streams pass straight through
    resp.on('end', () => res.end(resolve))
    resp.on('error', () => res.end(resolve))
  })
}

/** Start the routing proxy on 127.0.0.1:port (0 = any free port); resolves once it listens. */
export function serve(port: number, opts: { upstream?: string, router?: Router } = {}): Promise<Server> {
  const upstream = (opts.upstream || env('TOKENOMICS_ROUTER_UPSTREAM') || 'https://api.anthropic.com').replace(/\/+$/, '')
  const router = opts.router ?? new Router()
  const srv = createServer(async (req, res) => {
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0]
    if (method === 'GET' && req.url === '/pennywise/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, upstream, tiers: router.cfg.tiers }))
      return
    }
    try {
      let raw: Buffer | null = await readBody(req)
      if (!raw.length) raw = null
      let routed: [string, string, string, string] | null = null      // requested, model, reason, key
      const countTokens = path.endsWith('count_tokens')
      if (raw && method === 'POST' && (path === '/v1/messages' || path === '/v1/messages/count_tokens')) {
        try {
          const body = JSON.parse(raw.toString('utf8'))
          if (isObj(body) && router.routes(body.model)) {
            let model: string
            let reason: string
            let key: string
            let requested: string
            if (countTokens) [model, reason, key, requested] = [router.fallback, 'count_tokens', conversationKey(body), String(body.model)]
            else [model, reason, key, requested] = router.decide(body, raw.length)
            body.model = model
            raw = Buffer.from(JSON.stringify(body), 'utf8')
            routed = [requested, model, reason, key]
          }
        } catch {
          // not JSON: pass it through untouched
        }
      }
      let resp = await forward(upstream, method, req.url ?? '/', req.headers, raw)
      const code = resp.statusCode ?? 0
      if (routed && RETRY.has(code) && routed[1] !== router.fallback && !countTokens) {
        resp.resume()                                          // drop the failed answer
        const body = JSON.parse(raw!.toString('utf8'))
        body.model = router.fallback
        raw = Buffer.from(JSON.stringify(body), 'utf8')
        log(routed[3], routed[0], router.fallback, `${routed[1]} failed (${code})`, 'proxy-fallback')
        resp = await forward(upstream, method, req.url ?? '/', req.headers, raw)
      } else if (routed && !countTokens && routed[2] !== 'same turn (tool loop)') {
        log(routed[3], routed[0], routed[1], routed[2], 'proxy-routed')
      }
      await relay(resp, res)
    } catch (e) {
      logErr(defaultDbPath(), `pennywise proxy\n${errText(e)}`)
      try {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `pennywise proxy: ${e instanceof Error ? e.message : e}` } }))
      } catch {
        // the client went away
      }
    }
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

// ------------------------------------------------------------------ CLI ---------------------

export function explain(prompt: string): string {
  const r = score(prompt)
  const f = forced(prompt)
  const signed = (w: number) => (w >= 0 ? '+' : '') + String(w)
  const th = loadConfig().thresholds
  return [
    `tier:    ${r.tier}  (score ${r.score})`,
    `model:   ${resolveModel(f || r.model)}` + (f ? `  (forced with '${f}:')` : ''),
    'signals: ' + (r.signals.map(([n, w]) => `${n} ${signed(w)}`).join(', ') || 'none'),
    'tiers:   ' + ['MEDIUM', 'COMPLEX', 'REASONING'].map((t) => `${t}>=${th[t]}`).join('  '),
  ].join('\n')
}

function portArg(args: string[]): number {
  return Number.parseInt(argValue(args, '--port') ?? env('TOKENOMICS_ROUTER_PORT', '8787'), 10) || 8787
}

async function main(args: string[]): Promise<number> {
  const cmd = args[0] ?? ''
  if (cmd === 'explain') {
    process.stdout.write(explain(args.length > 1 ? args.slice(1).join(' ') : readStdin()) + '\n')
    return 0
  }
  if (cmd === 'env') {
    const p = portArg(args)
    process.stdout.write(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${p}\nexport ANTHROPIC_MODEL=pennywise\n`)
    return 0
  }
  if (cmd === 'serve') {
    const p = portArg(args)
    await serve(p)
    const tiers = loadConfig().tiers
    process.stdout.write(`pennywise router on http://127.0.0.1:${p}  ->  ${env('TOKENOMICS_ROUTER_UPSTREAM') || 'https://api.anthropic.com'}\n` +
      `tiers: ${TIERS.map((t) => `${t}=${resolveModel(tiers[t])}`).join(', ')}\n` +
      `use it:  ANTHROPIC_BASE_URL=http://127.0.0.1:${p} ANTHROPIC_MODEL=pennywise claude\n`)
    process.on('SIGINT', () => process.exit(0))
    return 0
  }
  try {                                                      // hook mode
    const raw = readStdin()
    const d = raw.trim() ? JSON.parse(raw) : {}
    const out = handle(isObj(d) ? d : {})
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(defaultDbPath(), `pennywise hook\n${errText(e)}`)
  }
  return 0
}

if (isMain(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
