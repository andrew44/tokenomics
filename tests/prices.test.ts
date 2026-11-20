/** Price table: parsing Claude's pricing page, merging into the JSON, and statusline lookups. */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT } from './helpers.ts'

import * as statusline from '../scripts/statusline.ts'
import * as updatePrices from '../scripts/update_prices.ts'

const PAGE = `## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| :---- | :---------------- | :-------------- | :-------------- | :----------------------- | :------------ |
| Claude Fable 5.2 | $8 / MTok | $10 / MTok | $16 / MTok | $0.20 / MTok<sup>1</sup> | $40 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 4.1 ([retired, except on Bedrock](https://example.com)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |
| Claude Haiku 3 | $0.25 / MTok | $0.30 / MTok | $0.50 / MTok | $0.03 / MTok | $1.25 / MTok |

| Model | Input | Output |
| ----- | ----- | ------ |
| Claude Fable 5.2 | $16 USD / MTok | $80 USD / MTok |
`

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`)

describe('parsing the pricing page', () => {
  const models = updatePrices.parsePricing(PAGE)

  test('rows become model ids', () => {
    assert.deepEqual(new Set(Object.keys(models)), new Set(['claude-fable-5-2', 'claude-opus-5-5', 'claude-opus-4-1',
      'claude-sonnet-5', 'claude-haiku-5-5']))
    assert.equal(models['claude-fable-5-2'].input, 8)
    assert.equal(models['claude-fable-5-2'].output, 40)    // not the fast-mode table
    assert.equal(models['claude-sonnet-5'].input, 2)       // footnote stripped
  })

  test('retired and long context', () => {
    assert.equal(models['claude-opus-4-1'].retired, true)
    const lc = models['claude-haiku-5-5'].long_context
    assert.equal(lc.threshold, 100000)
    assert.equal(lc.input, 0.5)
    assert.equal(models['claude-haiku-5-5'].input, 0.1)
  })

  test('older than Haiku 3.5 is skipped', () => {
    assert.ok(!('claude-3-haiku' in models))
  })

  test('merge keeps unlisted and legacy models', () => {
    const current = { models: { 'claude-opus-4': { name: 'Claude Opus 4', family: 'opus', version: '4', input: 15.0, output: 75.0 } } }
    const data = updatePrices.merge(current, models)
    assert.equal(data.models['claude-opus-4'].listed, false)
    assert.equal(data.models['claude-opus-5-5'].listed, true)
    assert.equal(data.models['claude-3-5-haiku'].input, 0.8)
    assert.equal(Object.keys(data.models)[0], 'claude-opus-5-5')   // newest first
  })

  test('refuses to write when the page is unparseable', async () => {
    const d = mkdtempSync(join(tmpdir(), 'prices-'))
    try {
      const src = join(d, 'page.md')
      const out = join(d, 'prices.json')
      writeFileSync(src, '# nothing here\n')
      const orig = process.stderr.write
      process.stderr.write = (() => true) as typeof process.stderr.write
      try {
        assert.equal(await updatePrices.main(['--source', src, '--out', out]), 2)
      } finally {
        process.stderr.write = orig
      }
      assert.ok(!existsSync(out))
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  test('the shipped file merges to itself (nothing to rewrite)', () => {
    const current = JSON.parse(readFileSync(join(ROOT, 'data', 'model-prices.json'), 'utf8'))
    const listed = Object.fromEntries(Object.entries(current.models).filter(([, v]: [string, any]) => v.listed)
      .map(([k, v]: [string, any]) => [k, Object.fromEntries(Object.entries(v).filter(([kk]) => kk !== 'listed'))]))
    assert.deepEqual({ ...updatePrices.merge(current, listed), updated: null }, { ...current, updated: null })
  })
})

describe('the shipped price file', () => {
  test('covers Haiku 3.5 to Fable 5.2', () => {
    const models = JSON.parse(readFileSync(join(ROOT, 'data', 'model-prices.json'), 'utf8')).models
    for (const mid of ['claude-3-5-haiku', 'claude-haiku-4-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-2']) {
      assert.ok(mid in models, mid)
      assert.ok(models[mid].output > models[mid].input)
    }
  })
})

describe('statusline price lookups', () => {
  test('model id normalisation', () => {
    const cases: Record<string, string | null> = {
      'claude-opus-5-5[1m]': 'claude-opus-5-5', 'Opus 5.5': 'claude-opus-5-5',
      'claude-opus-4-1-20250805': 'claude-opus-4-1', 'claude-opus-4-20250514': 'claude-opus-4',
      'claude-3-5-haiku-20241022': 'claude-3-5-haiku', 'Claude Fable 5.2': 'claude-fable-5-2',
      'claude-sonnet-5': 'claude-sonnet-5', 'gpt-5': null,
    }
    for (const [name, want] of Object.entries(cases)) assert.equal(statusline.claudeModelId(name), want, name)
  })

  test('uses the cache rates from the JSON', () => {
    close(statusline.usageCostUsd({ cache_read_input_tokens: 1_000_000 }, 'claude-opus-5-5', {}), 0.20)   // 0.05x, not the generic 0.1x
    assert.deepEqual(statusline.priceFor('claude-fable-5-2', {}), [8, 40])
  })

  test('long-context tier', () => {
    close(statusline.usageCostUsd({ input_tokens: 100_000 }, 'claude-haiku-5-5', {}), 0.01)
    close(statusline.usageCostUsd({ input_tokens: 200_000 }, 'claude-haiku-5-5', {}), 0.10)
  })

  test('config override and fallback', () => {
    assert.deepEqual(statusline.priceFor('claude-opus-5-5', { prices: { opus: [1, 2] } }), [1, 2])
    assert.deepEqual(statusline.priceFor('claude-opus-9-9', {}), statusline.PRICES.opus)
    assert.deepEqual(statusline.priceFor('gpt-5', {}), statusline.PRICES.gpt)
  })
})
