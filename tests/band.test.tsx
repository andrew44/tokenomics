// claude plugin test .   (the band of hooks/band.tsx; the Python tests cover statusbar.py --json)
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// What the band reads: its `bar` value, answered as the engine's store would, and the clock.
function seed(on: On, values: { bar?: unknown, now?: number }) {
  on('state.get', (_, e) => ({ value: { value: e.key === 'bar' ? values.bar : undefined, version: 1 } }))
  on('clock.now', () => ({ value: (values.now ?? 0) * 1000 }))
}

const BAND = {
  plugin: 'tokenomics',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 10 }, view: {},
  },
} as const

const BAR = {
  show: true, model: 'claude-opus-5-5', pct: 79.5, level: 'yellow', gauge: '█████████▌▒▒',
  tokens: '4.1M', cost: '~£1.46', ttl: 300, cold_at: 1_000_120, icons: ['F', 'H', 'E'],
} as const

test('the band shows the bar in the desktop and mobile apps', async ($, on) => {
  seed(on, { bar: BAR, now: 1_000_000 })           // 120s of a 300s cache left: half timer
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /claude-opus-5-5/ }))?.text).toContain('claude-opus-5-5')
    expect((await ui.find({ type: 'Text', text: /80%/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /4\.1M/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /~£1\.46/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /H 02:00/ }))).toBeDefined()
    await ui.unmount()
  }
})

test('the terminal keeps its own status line: no band there', async ($, on) => {
  seed(on, { bar: BAR, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /claude-opus-5-5/ })).toBeUndefined()
  await ui.unmount()
})

test('no band before the numbers arrive', async ($, on) => {
  seed(on, {})
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('no band when the status bar is off', async ($, on) => {
  seed(on, { bar: { show: false }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('a survey takes the band', async ($, on) => {
  seed(on, { bar: BAR, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /ctx/ })).toBeUndefined()
  await ui.unmount()
})

test('a cold cache reads 00:00', async ($, on) => {
  seed(on, { bar: { ...BAR, cold_at: 999_000 }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /E 00:00/ })).toBeDefined()
  await ui.unmount()
})

test('nothing cached yet reads --:--', async ($, on) => {
  seed(on, { bar: { ...BAR, cold_at: null }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /--:--/ })).toBeDefined()
  await ui.unmount()
})

// The engine beneath the band's timer and refresh: a session on `surfaces`, statusbar.py
// answering `stdout`. Records each run and each status line.
function engine(on: On, surfaces: ('terminal' | 'desktop' | 'vscode' | 'mobile')[], stdout: string) {
  const runs: { argv: readonly string[], stdin?: string }[] = []
  const status: (string | undefined)[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.id', () => ({ value: 's1' }))
  on('session.info', () => ({ value: { transcriptPath: '/t/s1.jsonl' } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [],
    context: { tokens: 159_000, window: 200_000, percent: 79.5 }, cost: { usd: 1.92 } } }))
  on('process.hookEnv', () => ({ value: {} }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('ui.status', (_, e) => { status.push(e.text); return { value: undefined } })
  return { runs, status }
}

test('VS Code gets it as the status line, fed the same figures as the terminal', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 * 1000 })
  const { runs, status } = engine(on, ['vscode'], JSON.stringify(BAR))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await clock.advance(1000)

  expect(runs[0]?.argv.slice(-3)).toEqual(['--json', '--band', 's1'])
  const payload = JSON.parse(runs[0]?.stdin ?? '{}')
  expect(payload.cost).toEqual({ total_cost_usd: 1.92 })
  expect(payload.context_window.used_percentage).toBe(79.5)
  expect(payload.transcript_path).toBe('/t/s1.jsonl')
  expect(status.at(-1)).toBe('◆ claude-opus-5-5 │ ctx █████████▌▒▒ 80% │ Σ 4.1M │ ~£1.46 │ H 01:59')
})

test('in the terminal alone the timer does nothing: its status line has it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { runs, status } = engine(on, ['terminal'], '{"show":false}')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)
  expect(runs.length).toBe(1)                     // the session.start read, nothing per tick
  expect(runs[0]?.argv).not.toContain('--band')   // and the after-reply message isn't silenced
  expect(status).toEqual([])
})
