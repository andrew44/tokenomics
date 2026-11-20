/**
 * Outcomes: what useful work a session got done, so spend can be measured per result.
 *
 * Read from what the agent did (a Trace), never from what it said:
 *
 *   green_suite  a test run that passed (consecutive passes of the same command count once)
 *   bug_fix      the same test command went from failing to passing, or a fix-type request ended
 *                with the change committed or the tests green
 *   feature      a build-type request ("add", "implement", ...) ended with code edited and then
 *                committed, a PR opened, or the tests green
 *   commit       a successful git commit
 *   pr           a pull request opened
 *   agent_task   a subagent task that came back without an error
 *
 * People can also record one by hand (bangforbuck.ts mark), for work no heuristic sees.
 */
import { AGENT_TOOLS, command, EDIT_TOOLS, type Step, type Trace } from './trace.ts'

export const KINDS = ['feature', 'bug_fix', 'green_suite', 'commit', 'pr', 'agent_task'] as const
export type Kind = typeof KINDS[number]
export type Outcomes = Partial<Record<string, number>>

export const LABELS: Record<string, string> = {
  feature: 'completed feature', bug_fix: 'bug fixed', green_suite: 'passing test suite', commit: 'commit',
  pr: 'pull request', agent_task: 'successful agent task',
}

const R = String.raw
const TEST_RES = [
  R`\b(npm|pnpm|yarn|bun)\s+(run\s+)?test(:\S+)?\b`, R`\bnpx\s+(jest|vitest|mocha|playwright\s+test|ava)\b`,
  R`(^|[\s/])(jest|vitest|mocha|pytest|rspec|phpunit|ctest|tox|nox)\b`, R`\bpython3?\s+-m\s+(pytest|unittest)\b`,
  R`\bgo\s+test\b`, R`\bcargo\s+(test|nextest)\b`, R`\b(mvnw?|gradlew?)\b.*\b(test|verify|check)\b`,
  R`\bdotnet\s+test\b`, R`\b(bundle\s+exec\s+)?rake\s+(test|spec)\b`, R`\bnode\s+(--[\w-]+\s+)*--test\b`,
  R`\bmake\s+(test|check)\b`, R`\bdeno\s+test\b`, R`\bswift\s+test\b`, R`\bmix\s+test\b`, R`\bflutter\s+test\b`,
].map((p) => new RegExp(p, 'i'))
const LINT_RES = [
  R`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|type-check|check|tsc)\b`, R`(^|[\s/])(eslint|ruff|flake8|pylint|mypy|pyright|tsc|biome|golangci-lint|shellcheck|rubocop|stylelint)\b`,
  R`\bcargo\s+clippy\b`, R`\bgo\s+vet\b`,
].map((p) => new RegExp(p, 'i'))
const BUILD_RES = [R`\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b`, R`\bcargo\s+build\b`, R`\bgo\s+build\b`, R`\bdotnet\s+build\b`,
  R`\b(mvnw?|gradlew?)\b.*\b(package|build|assemble)\b`].map((p) => new RegExp(p, 'i'))
const COMMIT_RE = /\bgit\s+(-\S+\s+(\S+\s+)?)*commit\b(?!.*--dry-run)/i
const PR_RE = /\bgh\s+pr\s+create\b/i
const PUSH_RE = /\bgit\s+(-\S+\s+)*push\b/i
const FAIL_COUNT_RE = /\b[1-9]\d* (tests? )?(failed|failing|failures?)\b/i
const FAIL_LINE_RE = /(^|\n)\s*(FAIL|FAILED|not ok \d+)\b|# fail\s+[1-9]/
const FIX_RE = /\b(fix|bug|broken|crash(es|ing)?|regression|error|failing|doesn'?t work|not working|issue #?\d*)\b/i
const BUILD_REQ_RE = /\b(add|implement|create|build|introduce|support|feature|new|extend|write a|make (a|it))\b/i

export type CommandKind = 'test' | 'lint' | 'build' | 'commit' | 'pr' | 'push'

/** The command itself, without heredoc bodies or quoted text (`echo "npm test"` runs no tests). */
export function bareCommand(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?(\n\2\b|$)/g, '')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
}

/** What a shell command is for, or null. A chain like `cd x && npm test` counts as its strongest part. */
export function classifyCommand(raw: string): CommandKind | null {
  const cmd = bareCommand(raw)
  if (!cmd.trim()) return null
  if (PR_RE.test(cmd)) return 'pr'
  if (COMMIT_RE.test(cmd)) return 'commit'
  if (TEST_RES.some((r) => r.test(cmd))) return 'test'
  if (LINT_RES.some((r) => r.test(cmd))) return 'lint'
  if (BUILD_RES.some((r) => r.test(cmd))) return 'build'
  if (PUSH_RE.test(cmd)) return 'push'
  return null
}

/** True when a test/lint/build step passed: no error flag and no failure in its output. */
export function passed(s: Step): boolean {
  if (s.isError !== false) return false
  return !FAIL_COUNT_RE.test(s.resultText) && !FAIL_LINE_RE.test(s.resultText)
}

/** The command with cd prefixes, env assignments and output plumbing removed: "the same test". */
export function normaliseCommand(cmd: string): string {
  return cmd.split(/&&|;|\|\|/).map((p) => p.trim()).filter((p) => p && !/^cd\s/.test(p)).join(' && ')
    .replace(/\s*\|\s*(tail|head|grep|tee|less|cat)\b.*$/s, '').replace(/\s+2>&1/g, '')
    .replace(/^(\w+=\S+\s+)+/, '').replace(/\s+/g, ' ').trim()
}

const isPrTool = (name: string) => /create_pull_request|pull_request_create|create_pr\b/i.test(name)

export function outcomesOf(t: Trace): Outcomes {
  const out: Record<string, number> = {}
  const add = (k: string, n = 1) => {
    if (n > 0) out[k] = (out[k] ?? 0) + n
  }
  const state = new Map<string, 'pass' | 'fail'>()
  let lastEdit = -1
  let greenAfterEdit = false
  let shipped = false
  t.steps.forEach((s, i) => {
    if (EDIT_TOOLS.has(s.name) && s.isError !== true) {
      lastEdit = i
      greenAfterEdit = false
    }
    if (AGENT_TOOLS.has(s.name) && !s.sidechain && s.isError === false) add('agent_task')
    if (isPrTool(s.name) && s.isError === false) {
      add('pr')
      shipped = true
    }
    const kind = classifyCommand(command(s))
    if (!kind || s.isError === null) return
    if (kind === 'commit' && s.isError === false && !/nothing to commit/i.test(s.resultText)) {
      add('commit')
      shipped = true
    } else if (kind === 'pr' && s.isError === false) {
      add('pr')
      shipped = true
    } else if (kind === 'test') {
      const key = normaliseCommand(command(s))
      const before = state.get(key)
      if (passed(s)) {
        if (before === 'fail') add('bug_fix')
        if (before !== 'pass') add('green_suite')
        state.set(key, 'pass')
        if (lastEdit >= 0) greenAfterEdit = true
      } else {
        state.set(key, 'fail')
        greenAfterEdit = false
      }
    }
  })
  const asked = t.prompts.map((p) => p.text).join('\n')
  const done = lastEdit >= 0 && (shipped || greenAfterEdit)
  if (done && FIX_RE.test(asked) && !out.bug_fix) add('bug_fix')
  if (done && BUILD_REQ_RE.test(asked)) add('feature')
  return out
}

export const total = (o: Outcomes) => Object.values(o).reduce((a: number, b) => a + (b ?? 0), 0)

/** The most valuable outcome a session produced (for grouping "equivalent tasks"). */
export function primary(o: Outcomes): string {
  for (const k of ['feature', 'bug_fix', 'pr', 'commit', 'green_suite', 'agent_task']) if (o[k]) return k
  return 'none'
}
