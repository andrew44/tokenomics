// The band: the tokenomics statusline in Claude Code's apps, which don't draw the CLI's
// `statusLine` setting (a mod: see https://code.claude.com/docs/en/plugins/mods/interface).
//   * Claude desktop app (and mobile): a row in the band above the prompt box (AbovePrompt).
//   * VS Code, which has no band: the plugin's status line above the prompt box ($.ui.status).
//   * Terminal: nothing here; the CLI statusline is scripts/statusline.py itself.
// The numbers come from scripts/statusline.py --json, fed the same figures the CLI statusline
// gets ($.session.usage), so both show the same line. A timer started at session.start redraws
// the cache countdown each second and re-reads the numbers when the transcript grows mid-turn.
// Off with `tokenomics statusline --band-off` or TOKENOMICS_BAND=off (statusline.py decides).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Line } from '../types'

const line = atom({ plugin: 'tokenomics', key: 'line' } as const, null)

const REFRESH_MS = 3000          // mid-turn: at most one statusline.py run per 3s
const DEFAULT_ICONS = ['⧗', '⏳︎', '⧖']

let lastRun = 0
let seenMtime = 0
let statusShown = false

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

/** Re-read the numbers from statusline.py, with the figures the CLI statusline gets. */
async function refresh($: EngineInterface) {
  lastRun = Date.now()
  try {
    const apps = await appSurfaces($)
    const [sid, info, model, usage] = await Promise.all(
      [$.session.id(), $.session.info(), $.session.model(), $.session.usage()])
    const payload = {
      session_id: sid,
      transcript_path: info.transcriptPath,
      model: { id: model },
      context_window: { used_percentage: usage.context.percent, context_window_size: usage.context.window,
        current_context_tokens: usage.context.tokens },
      cost: usage.cost ? { total_cost_usd: usage.cost.usd } : undefined,
    }
    // --band: an app shows the band here, so statusline.py's after-reply message stays quiet
    const argv = ['sh', `${$.plugin.root}/scripts/run.sh`, 'statusline.py', '--json']
    const { exitCode, stdout } = await $.process.run(apps.length ? [...argv, '--band', sid] : argv, {
      stdin: JSON.stringify(payload), env: await $.process.hookEnv(), timeoutMs: 10000 })
    if (exitCode !== 0 || !stdout.trim()) return
    const data = JSON.parse(stdout) as Line
    await update($, line, () => data)
  } catch {
    // never get in the way: no Python, no transcript yet... the band just stays as it was
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
