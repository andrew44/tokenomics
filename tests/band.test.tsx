// claude plugin test .   (the band of hooks/band.tsx; the Python tests cover statusbar.py --json)
import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// What the band reads: its `bar` and `now` values, answered as the engine's store would.
function seed(on: On, values: Record<string, unknown>) {
  on('state.get', (_, e) => ({ value: { value: values[e.key], version: 1 } }))
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
