/**
 * OutcomeEngine: did the work succeed, and how good was it? Measured, never inferred from tokens.
 *
 * Token counts prove nothing about success, so every status here rests on something observable:
 *
 *   test / lint / build runs   passed or failed (the exit status and the output)
 *   accepted changes           committed, a pull request opened, a commit reachable from the main branch,
 *                              or marked accepted by a person
 *   task completion            the request ended with the change verified or shipped
 *   rejection                  the user refused an edit, reverted it (git checkout/restore/reset/stash)
 *                              or deleted the files the agent created
 *
 * Both platforms feed the same rules: a Claude Code transcript and Copilot's hook events are each turned
 * into one neutral list of Activity, and everything below works on that list.
 *
 *   succeeded    a success signal: tests green after the edits, committed, PR, accepted, or an outcome
 *   failed       code was changed and the last check that ran failed
 *   discarded    code was changed and then thrown away (rejected, reverted, deleted)
 *   abandoned    code was changed and the user interrupted the agent at the end, with nothing verified
 *   unverified   code was changed with no signal either way (not counted as waste: mark it)
 *   no_change    nothing was edited: questions, research, reviews (not counted as waste)
 */
import { spawnSync } from 'node:child_process'

import { classifyCommand, outcomesOf, passed, total, type Outcomes } from '../engine/outcomes.ts'
import { command, EDIT_TOOLS, filePath, type Trace } from '../engine/trace.ts'

export { classifyCommand, KINDS, LABELS, normaliseCommand, outcomesOf, passed, primary, total, type Outcomes } from '../engine/outcomes.ts'

export const STATUSES = ['succeeded', 'failed', 'discarded', 'abandoned', 'unverified', 'no_change'] as const
export type Status = typeof STATUSES[number]
/** Statuses whose whole cost bought nothing. */
export const DEAD: readonly Status[] = ['failed', 'discarded', 'abandoned']

export type ActivityKind = 'edit' | 'create' | 'test' | 'lint' | 'build' | 'commit' | 'pr' | 'revert' | 'delete' | 'rejected' | 'other'
export type Activity = { kind: ActivityKind, ok: boolean | null, path: string, turn: number, detail: string }

const REVERT_RE = /\bgit\s+(?:checkout\s+(?:--\s+\S|\.(?:\s|$))|restore\b(?![^\n]*--staged)|reset\s+--hard\b|stash(?:\s+push)?(?:\s|$)(?!\s*(?:pop|apply|list|show|drop))|clean\s+-\w*f)/i
const DELETE_RE = /(?:^|&&|;|\|\|)\s*(?:git\s+)?rm\s+(?:-\w+\s+)*(.+)$/
const REJECTED_RE = /^\s*The user doesn't want to (?:proceed|take this action)|^\s*\[Request interrupted by user/i
const COMMIT_SHA_RE = /\[[^\]\s]+(?:\s+\([^)]*\))?\s+([0-9a-f]{7,40})\]/g
const PR_TOOL_RE = /create_pull_request|pull_request_create|create_pr\b/i

/** What a shell command does, as an activity kind. */
export function commandKind(cmd: string): ActivityKind {
  if (!cmd.trim()) return 'other'
  if (REVERT_RE.test(cmd)) return 'revert'
  const k = classifyCommand(cmd)
  if (k === 'test' || k === 'lint' || k === 'build' || k === 'commit' || k === 'pr') return k
  if (DELETE_RE.test(cmd)) return 'delete'
  return 'other'
}

/** A Claude Code transcript as activity. */
export function activityFromTrace(t: Trace): Activity[] {
  const out: Activity[] = []
  for (const s of t.steps) {
    if (s.isError !== false && REJECTED_RE.test(s.resultText)) {
      out.push({ kind: 'rejected', ok: false, path: filePath(s), turn: s.turn, detail: s.name })
      continue
    }
    if (EDIT_TOOLS.has(s.name)) {
      const created = /created successfully|file created/i.test(s.resultText) || s.name === 'create'
      out.push({ kind: created ? 'create' : 'edit', ok: s.isError === null ? null : !s.isError, path: filePath(s), turn: s.turn, detail: s.name })
      continue
    }
    if (PR_TOOL_RE.test(s.name)) {
      out.push({ kind: 'pr', ok: s.isError === null ? null : !s.isError, path: '', turn: s.turn, detail: s.name })
      continue
    }
    const cmd = command(s)
    const kind = commandKind(cmd)
    if (kind === 'other') continue
    let ok: boolean | null = s.isError === null ? null : !s.isError
    if ((kind === 'test' || kind === 'lint' || kind === 'build') && s.isError !== null) ok = passed(s)
    if (kind === 'commit' && ok && /nothing to commit/i.test(s.resultText)) ok = false
    const detail = kind === 'commit' ? [...s.resultText.matchAll(COMMIT_SHA_RE)].map((m) => m[1]).join(' ')
      : kind === 'delete' ? (DELETE_RE.exec(cmd)?.[1] ?? '') : ''
    out.push({ kind, ok, path: '', turn: s.turn, detail })
  }
  for (const turn of t.interrupts ?? []) out.push({ kind: 'rejected', ok: false, path: '', turn, detail: 'interrupted' })
  return out.sort((a, b) => a.turn - b.turn)
}

/** TelemetryEngine rows (Copilot: postToolUse events) as activity. */
export function activityFromEvents(rows: { type: string, tool_kind: string | null, command_kind: string | null, ok: number | boolean | null,
  path: string | null, tool: string | null }[]): Activity[] {
  const out: Activity[] = []
  rows.forEach((r, i) => {
    if (r.type !== 'tool_result') return
    const ok = r.ok === null || r.ok === undefined ? null : Boolean(r.ok)
    if (r.tool_kind === 'code_edit') {
      out.push({ kind: /^create/i.test(r.tool ?? '') ? 'create' : 'edit', ok, path: r.path ?? '', turn: i, detail: r.tool ?? '' })
    } else if (r.command_kind && r.command_kind !== 'other') {
      out.push({ kind: r.command_kind as ActivityKind, ok, path: '', turn: i, detail: '' })
    } else if (r.tool && PR_TOOL_RE.test(r.tool)) {
      out.push({ kind: 'pr', ok, path: '', turn: i, detail: r.tool })
    }
  })
  return out
}

export type Signals = {
  edits: number
  files: string[]                 // edited or created, in order
  created: string[]
  checks: { runs: number, passed: number, failed: number, last: 'pass' | 'fail' | null, lastTurn: number }
  greenAfterLastEdit: boolean
  commits: string[]               // commit SHAs (may be short)
  committed: boolean
  pr: boolean
  rejected: number                // tool calls the user refused
  interrupts: number
  endedOn: 'interrupt' | 'rejection' | null   // the last thing that happened
  reverted: boolean               // a revert after the last edit
  deletedCreated: string[]        // files the agent created and later deleted
  lastEditTurn: number
}

export function signals(acts: Activity[]): Signals {
  const s: Signals = { edits: 0, files: [], created: [], checks: { runs: 0, passed: 0, failed: 0, last: null, lastTurn: -1 },
    greenAfterLastEdit: false, commits: [], committed: false, pr: false, rejected: 0, interrupts: 0, endedOn: null, reverted: false,
    deletedCreated: [], lastEditTurn: -1 }
  for (const a of acts) {
    if ((a.kind === 'edit' || a.kind === 'create') && a.ok !== false) {
      s.edits++
      if (a.path && !s.files.includes(a.path)) s.files.push(a.path)
      if (a.kind === 'create' && a.path && !s.created.includes(a.path)) s.created.push(a.path)
      s.lastEditTurn = a.turn
      s.greenAfterLastEdit = false
      s.reverted = false
    } else if ((a.kind === 'test' || a.kind === 'lint' || a.kind === 'build') && a.ok !== null) {
      s.checks.runs++
      if (a.ok) s.checks.passed++
      else s.checks.failed++
      s.checks.last = a.ok ? 'pass' : 'fail'
      s.checks.lastTurn = a.turn
      if (a.kind === 'test') s.greenAfterLastEdit = Boolean(a.ok) && s.lastEditTurn >= 0
    } else if (a.kind === 'commit' && a.ok) {
      s.committed = true
      for (const sha of a.detail.split(' ').filter(Boolean)) if (!s.commits.includes(sha)) s.commits.push(sha)
    } else if (a.kind === 'pr' && a.ok) {
      s.pr = true
    } else if (a.kind === 'revert' && a.ok !== false && s.edits) {
      s.reverted = true
    } else if (a.kind === 'delete' && a.ok !== false) {
      for (const f of s.created) {
        const base = f.split(/[\\/]/).pop()!
        if (base && a.detail.includes(base) && !s.deletedCreated.includes(f)) s.deletedCreated.push(f)
      }
    } else if (a.kind === 'rejected') {
      if (a.detail === 'interrupted') s.interrupts++
      else s.rejected++
    }
  }
  const last = acts[acts.length - 1]
  s.endedOn = last?.kind !== 'rejected' ? null : last.detail === 'interrupted' ? 'interrupt' : 'rejection'
  return s
}

export type Verdict = { status: Status, reason: string }

/** The status of a piece of work from its signals (plus outcomes counted from the transcript, if any). */
export function status(s: Signals, outcomes: Outcomes = {}, opts: { accepted?: boolean } = {}): Verdict {
  const shipped = s.committed || s.pr || opts.accepted
  if (!s.edits) {
    if (shipped) return { status: 'succeeded', reason: s.pr ? 'pull request opened' : 'committed' }
    return { status: 'no_change', reason: s.checks.runs ? 'ran checks, changed nothing' : 'no files changed' }
  }
  const allCreatedGone = s.created.length > 0 && s.deletedCreated.length === s.created.length && s.files.length === s.created.length
  if (!shipped && (s.reverted || allCreatedGone)) {
    return { status: 'discarded', reason: s.reverted ? 'changes reverted after the last edit' : 'every file it created was deleted' }
  }
  if (opts.accepted) return { status: 'succeeded', reason: 'change accepted' }
  if (shipped) return { status: 'succeeded', reason: s.pr ? 'pull request opened' : 'changes committed' }
  if (s.greenAfterLastEdit) return { status: 'succeeded', reason: 'tests pass after the last edit' }
  if (s.checks.last === 'fail' && s.checks.lastTurn >= s.lastEditTurn) return { status: 'failed', reason: 'the last check failed' }
  if (s.endedOn === 'rejection') return { status: 'discarded', reason: 'the user refused the last change' }
  if (s.endedOn === 'interrupt') return { status: 'abandoned', reason: 'interrupted by the user, nothing verified' }
  if (s.checks.last === 'fail') return { status: 'failed', reason: 'the last check failed and was not re-run' }
  if (total(outcomes) > 0) return { status: 'succeeded', reason: 'an outcome was recorded' }
  if (s.checks.last === 'pass') return { status: 'succeeded', reason: 'checks pass' }
  return { status: 'unverified', reason: 'files changed, no test, commit or acceptance seen' }
}

/** Status of a whole transcript. */
export function judge(t: Trace, opts: { accepted?: boolean } = {}): Verdict & { signals: Signals, outcomes: Outcomes } {
  const acts = activityFromTrace(t)
  const sig = signals(acts)
  const outcomes = outcomesOf(t)
  return { ...status(sig, outcomes, opts), signals: sig, outcomes }
}

/** Explicit marks a person (or CI) recorded override the heuristics: accepted, rejected/discarded, abandoned, failed. */
export function applyMark(v: Status, mark: string | null | undefined): Status {
  const m = String(mark ?? '').toLowerCase()
  if (m === 'accepted' || m === 'succeeded' || m === 'success') return 'succeeded'
  if (m === 'discarded' || m === 'rejected') return 'discarded'
  if (m === 'abandoned') return 'abandoned'
  if (m === 'failed') return 'failed'
  return v
}

/** Commits from a session that made it onto the main branch: the strongest "accepted change" signal.
 *  Squash merges and rebases change SHAs, so a commit that isn't found is "unknown", never "discarded". */
export function mergedCommits(cwd: string | null, shas: string[], timeoutMs = 3_000): string[] {
  if (!cwd || !shas.length) return []
  const git = (...args: string[]) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: timeoutMs })
  const head = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']
    .find((r) => git('rev-parse', '--verify', '--quiet', r).status === 0)
  if (!head) return []
  return shas.slice(0, 20).filter((sha) => git('merge-base', '--is-ancestor', sha, head).status === 0)
}

// ---- quality -----------------------------------------------------------------------------------

/** A 0-1 quality score from observed checks, or null with no evidence (never guessed). */
export function quality(s: Signals): number | null {
  if (!s.checks.runs && !s.committed && !s.pr) return null
  let q = s.checks.runs ? (s.checks.last === 'pass' ? 0.7 : 0.2) + 0.3 * (s.checks.passed / s.checks.runs) : 0.6
  if (s.rejected) q -= Math.min(0.3, 0.1 * s.rejected)
  if (s.reverted) q -= 0.3
  return Math.max(0, Math.min(1, Math.round(q * 100) / 100))
}

// ---- task category ------------------------------------------------------------------------------

export const CATEGORIES = ['feature', 'bug_fix', 'refactor', 'tests', 'docs', 'ops', 'research', 'other'] as const
export type Category = typeof CATEGORIES[number]

const CAT_RES: [Category, RegExp][] = [
  ['refactor', /\b(refactor|clean ?up|tidy|rename|restructure|simplif(y|ication)|extract|dedupe|reorgani[sz]e)\b/i],
  ['bug_fix', /\b(fix|bug|broken|crash(es|ing)?|regression|error|failing|doesn'?t work|not working)\b/i],
  ['tests', /\b(write|add|more|unit|integration|e2e)\s+(\w+\s+)?tests?\b|\btest coverage\b/i],
  ['docs', /\b(readme|docs?|documentation|docstrings?|changelog|comments?)\b/i],
  ['ops', /\b(deploy|kubectl|helm|terraform|incident|logs?|alert|grafana|on-?call|pipeline|ci)\b/i],
  ['feature', /\b(add|implement|create|build|introduce|support|feature|new|extend|endpoint)\b/i],
]

/** What kind of task a session was, from the first requests and what was changed. Only the category is kept. */
export function category(prompts: string[], s: Signals): Category {
  const asked = prompts.slice(0, 3).join('\n')
  for (const [cat, re] of CAT_RES) {
    if (!re.test(asked)) continue
    if (cat === 'docs' && s.files.length && !s.files.every((f) => /\.(md|mdx|rst|txt|adoc)$|(^|\/)docs?\//i.test(f))) continue
    if (cat === 'tests' && s.files.length && !s.files.every((f) => isTestPath(f))) continue
    return cat
  }
  return s.edits ? 'other' : 'research'
}

export function isTestPath(p: string): boolean {
  return /(^|[\\/])(tests?|__tests__|spec)[\\/]|[._-](test|spec)\.\w+$|(^|[\\/])test_[^\\/]+\.py$/i.test(p)
}
