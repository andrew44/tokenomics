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
const DEFAULT_ICONS = ['●', '◑', '○']

type Level = 'green' | 'yellow' | 'red'
// The band's colours: the app theme's own where it has one, so it sits right in light and dark.
const THEME: Record<Level, 'success' | 'warning' | 'error'> = { green: 'success', yellow: 'warning', red: 'error' }
// The cache ring is a picture, which can't read the theme: mid tones that hold on either ground.
const RING: Record<Level, string> = { green: '#2FB673', yellow: '#E8A317', red: '#E5484D' }

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
    gauge: '━'.repeat(filled) + '─'.repeat(width - filled),
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

/** The cache countdown at `nowSec`: how much is left (0-1), its colour, icon, text and caption. */
function timer(b: Line, nowSec: number) {
  const [full, half, empty] = (b.icons?.length === 3 ? b.icons : DEFAULT_ICONS) as [string, string, string]
  if (b.cold_at == null) {
    return { frac: 0, level: undefined, icon: empty, text: '--:--', caption: 'no cache yet' }
  }
  const rem = Math.max(0, b.cold_at - nowSec)
  const frac = b.ttl ? Math.min(1, rem / b.ttl) : 0
  if (rem <= 0) return { frac: 0, level: 'red' as Level, icon: empty, text: mmss(0), caption: 'cache cold' }
  if (frac > 0.75) return { frac, level: 'green' as Level, icon: full, text: mmss(rem), caption: 'cache warm' }
  if (frac > 0.25) return { frac, level: 'yellow' as Level, icon: half, text: mmss(rem), caption: 'cache cooling' }
  return { frac, level: 'red' as Level, icon: empty, text: mmss(rem), caption: 'cache going cold' }
}

/** The countdown ring: an arc that runs down as the cache cools. */
function ring(frac: number, level: Level | undefined) {
  const r = 7
  const c = 2 * Math.PI * r
  const arc = frac > 0 && level
    ? `<circle cx="10" cy="10" r="${r}" fill="none" stroke="${RING[level]}" stroke-width="3" stroke-linecap="round" ` +
      `stroke-dasharray="${(frac * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 10 10)"/>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">` +
    `<circle cx="10" cy="10" r="${r}" fill="none" stroke="#8A8F98" stroke-opacity="0.3" stroke-width="3"/>${arc}</svg>`
}

/** The context bar: a rounded track filled to `pct` with the terminal gauge's green -> amber -> red. */
function bar(pct: number) {
  const w = 96
  const h = 8
  const fill = Math.max(0, Math.min(100, pct)) / 100 * w
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs>` +
    `<linearGradient id="g" x1="0" x2="${w}" y1="0" y2="0" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0.5" stop-color="${RING.green}"/><stop offset="0.75" stop-color="${RING.yellow}"/>` +
    `<stop offset="0.9" stop-color="${RING.red}"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="#8A8F98" fill-opacity="0.25"/>` +
    (fill > 0 ? `<rect width="${Math.max(h, fill).toFixed(1)}" height="${h}" rx="${h / 2}" fill="url(#g)"/>` : '') +
    `</svg>`
}

/** The line as plain text (VS Code's status line has no colours). */
function plainLine(b: Line, nowSec: number) {
  const t = timer(b, nowSec)
  const pct = `${Math.round(b.pct ?? 0)}%`
  return [`✦ ${b.model ?? ''}`.trim(), `${b.gauge ?? ''} ${pct} ctx${b.level === 'red' ? ' ▲' : ''}`,
    `${b.tokens ?? ''} tok`, b.cost ?? '', t.text === '--:--' || t.caption !== 'cache cold'
      ? `${t.icon} ${t.text} cache` : `${t.icon} cache cold`].join('  ·  ')
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
    const { Box, Text, Svg } = $.ui.resolve(e)
    const t = timer(b, (await $.clock.now()) / 1000)
    const pct = Math.round(b.pct ?? 0)
    const level: Level = b.level ?? 'green'
    const estimated = (b.cost ?? '').startsWith('~')

    // A stat: its figure, and a small caption under it.
    const stat = (key: string, figure: JSX.Element, caption: string, color?: string) => (
      <Box key={key} flexDirection="column">
        {figure}
        <Text size="caption" color={color} dimColor={!color}>{caption}</Text>
      </Box>
    )

    // `await next(e)` among the children: before v2.1.323 the band was one shared drawing, and
    // this keeps the rows of the mods after this one there.
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap="lg" rowGap="sm" paddingX="sm">
          {stat('model',
            <Text weight="semibold" wrap="end"><Text color="claude">✦ </Text>{b.model ?? ''}</Text>,
            'model')}
          {stat('context',
            <Box flexDirection="row" alignItems="center" gap="sm">
              <Svg source={bar(pct)} alt={`Context window ${pct}% full`} width={96} height={8} />
              <Text weight="semibold" tabular color={level === 'green' ? undefined : THEME[level]}>{pct}%</Text>
            </Box>,
            level === 'red' ? 'context · compact soon' : level === 'yellow' ? 'context · filling up' : 'context',
            level === 'green' ? undefined : THEME[level])}
          {stat('tokens', <Text weight="semibold" tabular>{b.tokens ?? ''}</Text>, 'tokens')}
          {stat('cost',
            <Text weight="semibold" tabular>{estimated ? (b.cost ?? '').slice(1) : b.cost ?? ''}</Text>,
            estimated ? 'spent · est.' : 'spent')}
          {stat('cache',
            <Box flexDirection="row" alignItems="center" gap="xs">
              <Svg source={ring(t.frac, t.level)} alt={`Prompt cache: ${t.caption}, ${t.text} left`} width={14} height={14} />
              <Text weight="semibold" tabular color={t.level ? THEME[t.level] : undefined} dimColor={!t.level}>{t.text}</Text>
            </Box>,
            t.caption,
            t.level === 'red' ? THEME.red : undefined)}
        </Box>
        {await next(e)}
      </Box>
    )
  })
}
