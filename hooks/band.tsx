// The band: the tokenomics statusline in Claude Code's apps, which don't draw the CLI's
// `statusLine` setting (a mod: see https://code.claude.com/docs/en/plugins/mods/interface).
//   * Claude desktop app (and mobile): a row in the band above the prompt box (AbovePrompt).
//   * VS Code, which has no band: the plugin's status line above the prompt box ($.ui.status).
//   * Terminal: nothing here; the CLI statusline is scripts/statusline.ts itself.
// The numbers come from scripts/statusline.ts --json, fed the same figures the CLI statusline
// gets ($.session.usage), so both show the same line. A timer started at session.start redraws
// the cache countdown each second and re-reads the numbers when the transcript grows mid-turn.
// If statusline.ts can't run (no shell or Node.js 22.18+ the app can start), the band shows the
// engine's own figures instead and says why once in the transcript (the details: claude --debug).
// Off with `tokenomics statusline --band-off` or TOKENOMICS_BAND=off (statusline.ts decides).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Line } from '../types'

const line = atom({ plugin: 'tokenomics', key: 'line' } as const, null)

const REFRESH_MS = 3000          // mid-turn: at most one statusline.ts run per 3s
const DEFAULT_ICONS = ['⧗', '⏳︎', '⧖']

// $.process.run starts argv[0] itself (no shell), on the app's own PATH: on Windows that has no
// `sh` (hooks.json's commands get Git Bash from Claude Code; this doesn't), so try these in turn.
const SHELLS = ['sh', 'bash']
const WINDOWS_SHELLS = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe']

let lastRun = 0
let seenMtime = 0
let statusShown = false
let shell: string | null = null   // the first of SHELLS that started
let told = false                  // said once why the band fell back

function human(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

/** The line from the engine's own figures, for when statusline.ts can't run: no cache timer,
 *  the cost in dollars (the configured currency lives in statusline.ts). */
function fallbackLine(model: string, usage: { context: { percent?: number | null, tokens?: number | null },
  cost?: { usd: number } | null }): Line {
  const pct = usage.context.percent ?? 0
  const width = 12
  const filled = Math.round((pct / 100) * width)
  return {
    show: true, model, pct,
    level: pct >= 90 ? 'red' : pct >= 75 ? 'yellow' : 'green',
    gauge: '█'.repeat(filled) + '▒'.repeat(width - filled),
    tokens: human(usage.context.tokens ?? 0),
    cost: usage.cost ? `~$${usage.cost.usd.toFixed(2)}` : '',
    cold_at: null,
  }
}

/** Runs `run.sh args`, through the first shell that starts. */
async function runScript($: EngineInterface, args: string[], stdin: string) {
  const { platform } = await $.session.info()
  const shells = shell ? [shell] : platform === 'windows' ? [...SHELLS, ...WINDOWS_SHELLS] : SHELLS
  let lastError: unknown
  for (const sh of shells) {
    try {
      const result = await $.process.run([sh, `${$.plugin.root}/scripts/run.sh`, ...args], {
        stdin, env: await $.process.hookEnv(), timeoutMs: 10000 })
      shell = sh
      return result
    } catch (err) {
      lastError = err                             // couldn't start (or timed out): try the next
    }
  }
  throw new Error(`no shell could run scripts/run.sh (tried ${shells.join(', ')}): ${String(lastError)}`)
}

function mmss(seconds: number) {
  const t = Math.max(0, Math.floor(seconds))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/** The cache countdown: icon, colour and text, at `nowSec`. */
function timer(b: Line, nowSec: number) {
  const [full, half, empty] = (b.icons?.length === 3 ? b.icons : DEFAULT_ICONS) as [string, string, string]
  if (b.cold_at == null) return { icon: empty, color: undefined, text: '--:--' }
  const rem = Math.max(0, b.cold_at - nowSec)
  const frac = b.ttl ? rem / b.ttl : 0
  if (rem <= 0) return { icon: empty, color: 'red', text: mmss(rem) }
  if (frac > 0.75) return { icon: full, color: 'green', text: mmss(rem) }
  if (frac > 0.25) return { icon: half, color: 'yellow', text: mmss(rem) }
  return { icon: empty, color: 'red', text: mmss(rem) }
}

/** The line as plain text (VS Code's status line has no colours). */
function plainLine(b: Line, nowSec: number) {
  const t = timer(b, nowSec)
  const flag = b.level === 'red' ? ' ▲' : ''
  return [`◆ ${b.model ?? ''}`.trim(), `ctx ${b.gauge ?? ''} ${Math.round(b.pct ?? 0)}%${flag}`,
    `Σ ${b.tokens ?? ''}`, b.cost ?? '', `${t.icon} ${t.text}`].join(' │ ')
}

/** Surfaces showing this session that don't draw the status line. */
async function appSurfaces($: EngineInterface) {
  return (await $.session.surfaces()).filter(s => s !== 'terminal')
}

/** Re-read the numbers from statusline.ts, with the figures the CLI statusline gets. */
async function refresh($: EngineInterface) {
  lastRun = Date.now()
  let model = ''
  let usage: Awaited<ReturnType<EngineInterface['session']['usage']>> | undefined
  try {
    const apps = await appSurfaces($)
    const [sid, info, m, u] = await Promise.all(
      [$.session.id(), $.session.info(), $.session.model(), $.session.usage()])
    model = m
    usage = u
    const payload = {
      session_id: sid,
      transcript_path: info.transcriptPath,
      model: { id: model },
      context_window: { used_percentage: usage.context.percent, context_window_size: usage.context.window,
        current_context_tokens: usage.context.tokens },
      cost: usage.cost ? { total_cost_usd: usage.cost.usd } : undefined,
    }
    // --band: an app shows the band here, so statusline.ts's after-reply message stays quiet
    const args = ['statusline.ts', '--json']
    const { exitCode, stdout, stderr } = await runScript($, apps.length ? [...args, '--band', sid] : args,
      JSON.stringify(payload))
    const data = exitCode === 0 && stdout.trim() ? JSON.parse(stdout) as Line : null
    if (!data || !('show' in data)) {             // no output: no Node.js 22.18+, or the script failed
      throw new Error(`statusline.ts gave no numbers (exit ${exitCode})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
    }
    await update($, line, () => data)
  } catch (err) {
    // never get in the way: draw the engine's own figures, and say once why
    $.ui.log(`tokenomics band: ${String(err)}`, { to: 'debug' })
    if (!told && (await appSurfaces($).catch(() => [])).length) {
      told = true
      $.ui.log(`tokenomics: the band is showing Claude Code's own figures (no cache timer, cost in $): ` +
        `${err instanceof Error ? err.message : String(err)}`)
    }
    if (usage) {
      const fallback = fallbackLine(model, usage)
      await update($, line, b => (b?.show === false ? b : fallback)).catch(() => {})
    }
  }
}

/** Each second: redraw the countdown, and re-read the numbers when the transcript grew. */
async function tick($: EngineInterface) {
  const apps = await appSurfaces($)
  if (!apps.length) return                        // terminal only: the CLI statusline does this
  $.ui.invalidate('ui.render')
  const b = await read($, line)
  if (apps.includes('vscode') && b?.show) {
    $.ui.status(plainLine(b, (await $.clock.now()) / 1000))
    statusShown = true
  } else if (statusShown) {
    $.ui.status(undefined)
    statusShown = false
  }
  if (Date.now() - lastRun < REFRESH_MS) return
  try {
    const { transcriptPath } = await $.session.info()
    const { mtimeMs } = await $.fs.stat(transcriptPath)
    if (mtimeMs !== seenMtime) {
      seenMtime = mtimeMs
      await refresh($)
    }
  } catch {
    // no transcript yet
  }
}

export const register: Register = on => {
  lastRun = 0
  seenMtime = 0
  statusShown = false
  shell = null
  told = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void refresh($)
    $.clock.every(1000, () => tick($))            // stops on a reload; the new module starts its own
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const b = await read($, line)
    if (!b || !b.show) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const t = timer(b, (await $.clock.now()) / 1000)
    const sep = <Text dimColor> │ </Text>

    // `await next(e)` among the children: before v2.1.323 the band was one shared drawing, and
    // this keeps the rows of the mods after this one there.
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="blue" bold>◆ {b.model ?? ''}</Text>
          {sep}
          <Text dimColor>ctx </Text>
          <Text color={b.level}>{b.gauge}</Text>
          <Text color={b.level} bold> {Math.round(b.pct ?? 0)}%{b.level === 'red' ? ' ▲' : ''}</Text>
          {sep}
          <Text dimColor>Σ </Text>
          <Text bold>{b.tokens}</Text>
          {sep}
          <Text bold>{b.cost}</Text>
          {sep}
          {t.color ? <Text color={t.color} bold>{t.icon} {t.text}</Text> : <Text dimColor>{t.icon} {t.text}</Text>}
        </Text>
        {await next(e)}
      </Box>
    )
  })
}
