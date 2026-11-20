// tokenomics status bar as a band above the prompt, for the Claude desktop app (and mobile),
// which don't draw `statusLine`. The terminal keeps its real status line, so the band stays out
// of it. The numbers come from scripts/statusbar.py --json (one source of truth); the band only
// ticks the cache countdown each second.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Bar } from '../types'

const bar = atom({ plugin: 'tokenomics', key: 'bar' } as const, null)
const now = atom({ plugin: 'tokenomics', key: 'now' } as const, 0)

const REFRESH_MS = 3000          // mid-turn: at most one statusbar.py run per 3s

const mmss = (s: number) => {
  const t = Math.max(0, Math.floor(s))
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

let lastRun = 0
let ticking = false
let seenMtime = 0
let drawn = false                // the band has been drawn on a surface that shows it

async function refresh($: EngineInterface) {
  lastRun = Date.now()
  try {
    const [sid, info] = await Promise.all([$.session.id(), $.session.info()])
    const env = await $.process.hookEnv()
    // --band tells statusbar.py the band shows the bar here, so its after-reply message stays quiet
    const argv = ['sh', `${$.plugin.root}/scripts/run.sh`, 'statusbar.py', '--json']
    const { exitCode, stdout } = await $.process.run(drawn ? [...argv, '--band', sid] : argv,
      { stdin: JSON.stringify({ session_id: sid, transcript_path: info.transcriptPath }),
        env, timeoutMs: 10000 })
    if (exitCode !== 0 || !stdout.trim()) return
    const data = JSON.parse(stdout) as Bar
    await update($, bar, () => data)
    if (data.show && !ticking) {
      ticking = true
      $.clock.every(1000, () => tick($, info.transcriptPath))
    }
  } catch {
    // never get in the way: no Python, no transcript yet... the band just stays empty
  }
}

// Each second: redraw the countdown, and re-read the numbers when the transcript has grown
// (a reply or tool result landed) mid-turn.
async function tick($: EngineInterface, transcript: string) {
  await update($, now, () => Date.now() / 1000)
  if (!drawn || !transcript || Date.now() - lastRun < REFRESH_MS) return
  try {
    const { mtimeMs } = await $.fs.stat(transcript)
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
  ticking = false
  seenMtime = 0
  drawn = false

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void refresh($)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const b = await read($, bar)
    if (!b || !b.show) return next(e)
    drawn = true                 // the next tick re-reads with --band
    seenMtime = 0
    const t = (await read($, now)) || Date.now() / 1000
    const { Box, Text } = $.ui.resolve(e)

    const [full, half, empty] = b.icons?.length === 3 ? b.icons : ['⧗', '⏳︎', '⧖']
    let timer = <Text dimColor>{empty} --:--</Text>
    if (b.cold_at != null) {
      const rem = Math.max(0, b.cold_at - t)
      const frac = b.ttl ? rem / b.ttl : 0
      const [icon, color] = rem <= 0 ? [empty, 'red'] : frac > 0.75 ? [full, 'green']
        : frac > 0.25 ? [half, 'yellow'] : [empty, 'red']
      timer = <Text color={color} bold>{icon} {mmss(rem)}</Text>
    }
    const sep = <Text dimColor> │ </Text>

    return (
      <Box flexDirection="row">
        <Text>
          <Text color="blue" bold>◆ {b.model || ''}</Text>
          {sep}
          <Text dimColor>ctx </Text>
          <Text color={b.level}>{b.gauge}</Text>
          <Text color={b.level} bold> {Math.round(b.pct ?? 0)}%{(b.level === 'red') ? ' ▲' : ''}</Text>
          {sep}
          <Text dimColor>Σ </Text><Text bold>{b.tokens}</Text>
          {sep}
          <Text bold>{b.cost}</Text>
          {sep}
          {timer}
        </Text>
      </Box>
    )
  })
}
