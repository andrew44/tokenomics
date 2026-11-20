/**
 * Loops: is the agent going round in circles? Used by groundhog, before each tool call.
 *
 *   failing_command   the same command has failed N times in a row (default 3), or is being re-run
 *                     after failing twice with nothing changed in between
 *   identical_call    the same call with the same input, again, with nothing changed since (default:
 *                     the 3rd time)
 *   edit_flipflop     the same edit is being made (or undone) on a file for the 3rd time
 *   no_progress       the last 20 calls: mostly errors, no check passing, and the context still
 *                     growing: tokens are going up and nothing is getting done
 *
 * Only completed calls (with a result) count, so the call about to run is never counted against itself.
 */
import { sha1, type Obj } from '../util.ts'
import { classifyCommand, normaliseCommand, passed } from './outcomes.ts'
import { callKey, command, EDIT_TOOLS, filePath, type Step, type Trace } from './trace.ts'

export type Pending = { name: string, input: Obj }
export type Loop = { rule: string, key: string, count: number, reason: string, usd: number }
export type Options = { repeat: number, fails: number, window: number }

export const DEFAULTS: Options = { repeat: 3, fails: 3, window: 20 }

// Tools that are meant to be called again and again (polling, task lists).
const POLL_TOOLS = /^(TodoWrite|TodoRead|BashOutput|TaskOutput|TaskGet|TaskList|TaskUpdate|Monitor|ReadNotifications|AskUserQuestion|KillShell|ScheduleWakeup)$/
const POLL_CMD = /\b(sleep|watch|wait|ps|top|tail\s+-f|kubectl\s+(get|rollout\s+status)|docker\s+ps|gh\s+run\s+(view|watch)|curl)\b/

const pathOf = (input: Obj) => String(input.file_path ?? input.path ?? input.notebook_path ?? '')
const firstLine = (s: string) => (s.split('\n').map((l) => l.trim()).find((l) => l && !/^exit code/i.test(l)) ?? '').slice(0, 140)

function changesState(s: Step): boolean {
  return (EDIT_TOOLS.has(s.name) && s.isError !== true) || Boolean(command(s))
}

export function detect(t: Trace, p: Pending, o: Options = DEFAULTS): Loop | null {
  const done = t.steps.filter((s) => s.isError !== null)
  const cost = (from: number) => t.turns.slice(from).reduce((a, x) => a + x.costUsd, 0)
  const cmd = p.name === 'Bash' ? String(p.input.command ?? '') : ''

  // 1. the same command failing again and again
  if (cmd && !POLL_CMD.test(cmd)) {
    const norm = normaliseCommand(cmd)
    const same = done.filter((s) => command(s) && normaliseCommand(command(s)) === norm)
    let streak = 0
    for (let i = same.length - 1; i >= 0; i--) {
      const s = same[i]
      if (s.isError || (classifyCommand(command(s)) === 'test' && !passed(s))) streak++
      else break
    }
    if (streak) {
      const last = same[same.length - 1]
      const at = done.indexOf(last)
      const unchanged = !done.slice(at + 1).some((s) => EDIT_TOOLS.has(s.name) && s.isError !== true)
      if (streak >= o.fails || (streak >= 2 && unchanged)) {
        const first = same[same.length - streak]
        return { rule: 'failing_command', key: 'fail:' + sha1(norm).slice(0, 12), count: streak, usd: cost(first.turn),
          reason: `groundhog: \`${norm.slice(0, 80)}\` has failed ${streak} times in a row` +
            `${unchanged ? ', and nothing has changed since the last failure' : ''} (last error: "${firstLine(last.resultText)}"). ` +
            'Running it again will not change the answer. Stop and change strategy: re-read the error, say what you have ' +
            'tried and why it did not work, form a different hypothesis, or ask the user for help.' }
      }
    }
  }

  // 2. the same call, again, with nothing changed since
  if (!POLL_TOOLS.test(p.name) && !EDIT_TOOLS.has(p.name) && !(cmd && POLL_CMD.test(cmd))) {
    const key = callKey(p.name, p.input)
    let n = 0
    let firstTurn = t.turns.length
    for (let i = done.length - 1; i >= 0; i--) {
      const s = done[i]
      if (s.key === key) {
        n++
        firstTurn = s.turn
      } else if (changesState(s)) {
        break
      }
    }
    if (n + 1 >= o.repeat) {
      const what = cmd ? `\`${cmd.slice(0, 80)}\`` : `${p.name}${pathOf(p.input) ? ` on ${pathOf(p.input)}` : ''}`
      return { rule: 'identical_call', key: 'same:' + key, count: n + 1, usd: cost(firstTurn),
        reason: `groundhog: this is call number ${n + 1} to ${what} with exactly the same input, and nothing has changed ` +
          'since the last one, so the result will be the same. Use the earlier result, or do something different.' }
    }
  }

  // 3. editing a file back and forth
  if (p.name === 'Edit' && p.input.old_string !== undefined) {
    const path = pathOf(p.input)
    const a = String(p.input.old_string)
    const b = String(p.input.new_string ?? '')
    const flips = done.filter((s) => s.name === 'Edit' && s.isError === false && filePath(s) === path &&
      ((s.input.old_string === a && s.input.new_string === b) || (s.input.old_string === b && s.input.new_string === a)))
    if (flips.length >= 2) {
      return { rule: 'edit_flipflop', key: 'flip:' + sha1(`${path}\u0000${[a, b].sort().join('\u0000')}`).slice(0, 12),
        count: flips.length + 1, usd: cost(flips[0].turn),
        reason: `groundhog: this edit to ${path} has already been made or undone ${flips.length} times. Going back and forth ` +
          'is not converging. Step back: write down what each version fixes and breaks, then pick one, or ask the user.' }
    }
  }

  // 4. tokens climbing, nothing getting done
  const recent = done.slice(-o.window)
  if (recent.length >= o.window) {
    const errors = recent.filter((s) => s.isError).length
    const progress = recent.some((s) => {
      const k = classifyCommand(command(s))
      return (k === 'test' || k === 'lint' || k === 'build' || k === 'commit') && passed(s)
    })
    const t0 = t.turns[recent[0].turn]
    const t1 = t.turns[recent[recent.length - 1].turn]
    if (!progress && errors >= recent.length * 0.6 && t0 && t1 && t1.ctx > t0.ctx * 1.25) {
      return { rule: 'no_progress', key: 'stall:' + Math.floor(done.length / o.window), count: errors, usd: cost(recent[0].turn),
        reason: `groundhog: ${errors} of the last ${recent.length} tool calls failed, no check has passed, and the context has ` +
          `grown from ${t0.ctx.toLocaleString('en-US')} to ${t1.ctx.toLocaleString('en-US')} tokens. This is burning money ` +
          'without progress. Stop, summarise what you have learned, and propose a fresh approach before going on.' }
    }
  }
  return null
}
