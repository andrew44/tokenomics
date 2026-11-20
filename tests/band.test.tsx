// claude plugin test .   (the band of hooks/band.tsx; the Node tests (tests/*.test.ts) cover statusline.ts --json)
import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// What the band reads: its `line` value, answered as the engine's store would, and the clock.
function seed(on: On, values: { line?: unknown, now?: number }) {
  on('state.get', (_, e) => ({ value: { value: e.key === 'line' ? values.line : undefined, version: 1 } }))
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

const LINE = {
  show: true, model: 'claude-opus-5-5', pct: 79.5, level: 'yellow', gauge: '━━━━━━━━━╸──',
  tokens: '4.1M', cost: '~£1.46', ttl: 300, cold_at: 1_000_120, icons: ['F', 'H', 'E'],
} as const

test('the band shows the statusline in the desktop and mobile apps', async ($, on) => {
  seed(on, { line: LINE, now: 1_000_000 })           // 120s of a 300s cache left: half timer
  for (const surface of ['desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /claude-opus-5-5/ }))?.text).toContain('claude-opus-5-5')
    expect((await ui.find({ type: 'Text', text: /80%/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /4\.1M/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^£1\.46$/ }))).toBeDefined()        // ~: an estimate
    expect((await ui.find({ type: 'Text', text: /spent · est\./ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^02:00$/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /cache cooling/ }))).toBeDefined()
    expect(await ui.findAll({ type: 'Svg' })).toHaveLength(2)               // the context bar, the cache ring
    await ui.unmount()
  }
})

test('the terminal keeps the CLI statusline: no band there', async ($, on) => {
  seed(on, { line: LINE, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /claude-opus-5-5/ })).toBeUndefined()
  await ui.unmount()
})

test('no band before the numbers arrive', async ($, on) => {
  seed(on, {})
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeUndefined()
  await ui.unmount()
})

test('no band when it is turned off (--band-off)', async ($, on) => {
  seed(on, { line: { show: false }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeUndefined()
  await ui.unmount()
})

test('a survey takes the band', async ($, on) => {
  seed(on, { line: LINE, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ type: 'Text', text: /context/ })).toBeUndefined()
  await ui.unmount()
})

test('a cold cache reads 00:00, cache cold', async ($, on) => {
  seed(on, { line: { ...LINE, cold_at: 999_000 }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^00:00$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /cache cold/ })).toBeDefined()
  await ui.unmount()
})

test('nothing cached yet reads --:--', async ($, on) => {
  seed(on, { line: { ...LINE, cold_at: null }, now: 1_000_000 })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /--:--/ })).toBeDefined()
  await ui.unmount()
})

// The engine beneath the band's timer and refresh: a session on `surfaces`, statusline.ts
// answering `stdout`. Records each run and each status line.
type Run = { argv: readonly string[], stdin?: string }
function engine(on: On, surfaces: ('terminal' | 'desktop' | 'vscode' | 'mobile')[], stdout: string,
  opts: { platform?: string, run?: (argv: readonly string[]) => void, state?: boolean } = {}) {
  const runs: Run[] = []
  const status: (string | undefined)[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.id', () => ({ value: 's1' }))
  on('session.info', () => ({ value: { transcriptPath: '/t/s1.jsonl', platform: opts.platform } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [],
    context: { tokens: 159_000, window: 200_000, percent: 79.5 }, cost: { usd: 1.92 } } }))
  on('process.hookEnv', () => ({ value: {} }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin })
    opts.run?.(e.argv)                              // throws: the command couldn't start
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('ui.status', (_, e) => { status.push(e.text); return { value: undefined } })
  return { runs, status }
}

test('VS Code gets it as the status line, fed the same figures as the terminal', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 * 1000 })
  const { runs, status } = engine(on, ['vscode'], JSON.stringify(LINE))

  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await clock.advance(1000)

  expect(runs[0]?.argv.slice(-3)).toEqual(['--json', '--band', 's1'])
  const payload = JSON.parse(runs[0]?.stdin ?? '{}')
  expect(payload.cost).toEqual({ total_cost_usd: 1.92 })
  expect(payload.context_window.used_percentage).toBe(79.5)
  expect(payload.transcript_path).toBe('/t/s1.jsonl')
  expect(status.at(-1)).toBe('✦ claude-opus-5-5  ·  ━━━━━━━━━╸── 80% ctx  ·  4.1M tok  ·  ~£1.46  ·  H 01:59 cache')
})

test('in the terminal alone the timer does nothing: the CLI statusline has it', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  const { runs, status } = engine(on, ['terminal'], '{"show":false}')
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10_000)
  expect(runs.length).toBe(1)                     // the session.start read, nothing per tick
  expect(runs[0]?.argv).not.toContain('--band')   // and the after-reply message isn't silenced
  expect(status).toEqual([])
})

test('on Windows, with no sh on the PATH, the band runs the script through Git Bash', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 * 1000 })
  const { runs } = engine(on, ['desktop'], JSON.stringify(LINE), { platform: 'windows',
    run: argv => { if (!argv[0]?.endsWith('bash.exe')) throw new Error(`spawn ${argv[0]} ENOENT`) } })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)

  expect(runs.map(r => r.argv[0])).toEqual(['sh', 'bash', 'C:/Program Files/Git/bin/bash.exe'])
})

test('when statusline.ts gives nothing (no Node.js), the band draws the engine figures and says why', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 * 1000 })
  engine(on, ['desktop'], '')
  let stored: unknown
  on('state.get', () => ({ value: { value: stored, version: 1 } }))
  on('state.set', (_, e) => { stored = e.value; return { value: undefined } })
  const logs: string[] = []
  on('ui.log', (_, e) => { if (e.to !== 'debug') logs.push(e.text); return { value: undefined } })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)

  expect(stored).toMatchObject({ show: true, model: 'claude-opus-5-5', pct: 79.5, tokens: '159.0k', cost: '~$1.92' })
  expect(logs.length).toBe(1)
  expect(logs[0]).toContain('statusline.ts gave no numbers')
})
