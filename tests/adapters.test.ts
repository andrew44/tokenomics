/** Platform capabilities, billing separation, session ids and graceful degradation. */
import assert from 'node:assert/strict'
import { describe, mock, test } from 'node:test'

import { assistant, useTemp, user, writeTranscript } from './helpers.ts'

import { settings } from '../tokenomics/config.ts'
import * as llm from '../tokenomics/engine/llm.ts'
import * as session from '../tokenomics/engine/session.ts'
import { ALL_CAPABILITIES, BILLING_ANTHROPIC_TOKENS, BILLING_COPILOT_PREMIUM_REQUESTS, Capability } from '../tokenomics/platform/capabilities.ts'
import * as registry from '../tokenomics/platform/registry.ts'

const { getAdapter } = registry

describe('capabilities', () => {
  test('every capability is declared', () => {
    for (const name of ['claude-code', 'copilot']) {
      const a = getAdapter(name)
      for (const cap of ALL_CAPABILITIES) assert.ok(cap in a.capabilities, `${name} does not declare ${cap}`)
    }
  })

  test('platform facts', () => {
    const cc = getAdapter('claude-code')
    const cp = getAdapter('copilot')
    assert.ok(cc.supports(Capability.TRANSCRIPT) && cc.supports(Capability.TOKEN_USAGE))
    assert.ok(!cp.supports(Capability.TRANSCRIPT))
    assert.ok(!cp.supports(Capability.TOKEN_USAGE))
    assert.ok(!cp.supports(Capability.BILLING_INFO))
    assert.ok(cp.supports(Capability.TOOL_EVENTS))
    assert.equal(cc.billingModel, BILLING_ANTHROPIC_TOKENS)
    assert.equal(cp.billingModel, BILLING_COPILOT_PREMIUM_REQUESTS)
  })

  test('the report is JSON', () => {
    JSON.parse(JSON.stringify(registry.report()))
  })
})

describe('billing', () => {
  test('Claude tokens are reported', async (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 'c', [user('fix the bug in the parser code'), assistant('m', [['Edit', {}]])])
    await session.finalize(getAdapter('claude-code'), { session_id: 'c', transcript_path: path }, settings({ dbPath: t.db }))
    const r = t.session('c')!
    assert.deepEqual([r.input_tokens, r.total_tokens], [100, 1160])
    assert.deepEqual([r.billing_model, r.usage_status, r.evidence], [BILLING_ANTHROPIC_TOKENS, 'reported', 'transcript'])
  })

  test('Copilot tokens are never invented', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db })
    const a = getAdapter('copilot')
    session.recordPrompt(a, { sessionId: 'g', prompt: 'write a function' }, s)
    await session.finalize(a, { sessionId: 'g', reason: 'complete' }, s)
    const r = t.session('g')!
    for (const col of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'total_tokens']) assert.equal(r[col], null, col)
    assert.deepEqual([r.billing_model, r.usage_status, r.evidence], [BILLING_COPILOT_PREMIUM_REQUESTS, 'unavailable', 'hook-events'])
  })

  test('a Copilot transcript is not read even if given', async (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 'x', [user('hello'), assistant('m')])
    await session.finalize(getAdapter('copilot'), { sessionId: 'x', transcriptPath: path }, settings({ dbPath: t.db }))
    assert.equal(t.session('x')!.input_tokens, null)
  })
})

describe('session ids', () => {
  test('all spellings', () => {
    const cp = getAdapter('copilot')
    assert.equal(cp.sessionId({ sessionId: 'a' }), 'a')
    assert.equal(cp.sessionId({ session_id: 'b' }), 'b')
    assert.ok(cp.sessionId({ cwd: '/w' }).startsWith('anon-'))
    assert.equal(getAdapter('claude-code').sessionId({ session_id: 'c' }), 'c')
  })

  test('Copilot tool payload spellings', () => {
    const cp = getAdapter('copilot')
    const a = cp.toolCall({ toolName: 'bash', toolArgs: '{"command": "kubectl logs x"}' })!
    const b = cp.toolCall({ tool_name: 'bash', tool_input: { command: 'kubectl logs x' } })
    assert.deepEqual([a.kind, a.command], ['shell', 'kubectl logs x'])
    assert.deepEqual(a, b)
    assert.equal(cp.toolCall({ toolName: 'str_replace_editor', toolArgs: { command: 'view' } })!.kind, 'read')
    assert.equal(cp.toolCall({}), null)
  })
})

describe('degradation', () => {
  test('a broken adapter is isolated', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db })
    const orig = registry.ADAPTERS.copilot
    registry.cache.clear()
    registry.ADAPTERS.copilot = () => {
      throw new Error('cannot load')
    }
    let broken, ok
    try {
      broken = getAdapter('copilot')
      ok = getAdapter('claude-code')
    } finally {
      registry.ADAPTERS.copilot = orig
      registry.cache.clear()
      registry.loadErrors.clear()
    }
    assert.equal(broken.constructor.name, 'GenericAdapter')
    assert.equal(ok.constructor.name, 'ClaudeCodeAdapter')
    session.recordPrompt(broken, { sessionId: 'b', prompt: 'check grafana' }, s)
    session.recordTool(broken, { sessionId: 'b', toolName: 'edit' }, s)     // no TOOL_EVENTS: ignored
    await session.finalize(broken, { sessionId: 'b' }, s)
    assert.equal(t.session('b')!.label, 'opex')
    assert.deepEqual(t.rows('SELECT * FROM tool_events'), [])
  })

  test('an unknown source', (c) => {
    const t = useTemp(c)
    session.recordPrompt(getAdapter('some-new-ide'), { session_id: 'u', prompt: 'refactor this module' }, settings({ dbPath: t.db }))
    assert.equal(t.session('u')!.source, 'some-new-ide')
  })

  test('Claude with a missing transcript keeps the running label', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db })
    const a = getAdapter('claude-code')
    session.recordPrompt(a, { session_id: 'm', prompt: 'write a function' }, s)
    await session.finalize(a, { session_id: 'm', transcript_path: '/does/not/exist' }, s)
    const r = t.session('m')!
    assert.deepEqual([r.label, r.capex_score, r.prompt_count], ['capex', 4, 1])
  })
})

describe('LLM step', () => {
  test('the LLM label is kept and shared', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db, llmEnabled: true, llmUrl: 'http://localhost:9/v1', storePrompt: true })
    const call = mock.method(llm.client, 'call', async () => ({ label: 'opex', confidence: 0.9, reason: 'r', model: 'm' }))
    try {
      const path = writeTranscript(t.home, 'c', [user('write a function'), assistant('m')])
      await session.finalize(getAdapter('claude-code'), { session_id: 'c', transcript_path: path }, s)
      const a = getAdapter('copilot')
      session.recordPrompt(a, { sessionId: 'g', prompt: 'write a function' }, s)
      await session.finalize(a, { sessionId: 'g' }, s)
      await session.finalize(a, { sessionId: 'g' }, s)           // same input: no second call
      assert.equal(call.mock.callCount(), 2)
    } finally {
      call.mock.restore()
    }
    for (const sid of ['c', 'g']) {
      const r = t.session(sid)!
      assert.deepEqual([r.label, r.label_source], ['opex', 'llm'])
    }
  })

  test('Copilot without stored prompts stays on keywords', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db, llmEnabled: true, llmUrl: 'http://localhost:9/v1' })
    const call = mock.method(llm.client, 'call', async () => ({ label: 'opex', confidence: 1, reason: '', model: 'm' }))
    try {
      const a = getAdapter('copilot')
      session.recordPrompt(a, { sessionId: 'g', prompt: 'write a function' }, s)
      await session.finalize(a, { sessionId: 'g' }, s)
      assert.equal(call.mock.callCount(), 0)
    } finally {
      call.mock.restore()
    }
    assert.equal(t.session('g')!.label_source, 'keywords')
  })

  test('an LLM failure falls back to keywords', async (c) => {
    const t = useTemp(c)
    const s = settings({ dbPath: t.db, llmEnabled: true, llmUrl: 'http://127.0.0.1:9/v1', llmTimeout: 1 })
    const path = writeTranscript(t.home, 'c', [user('write a function'), assistant('m')])
    await session.finalize(getAdapter('claude-code'), { session_id: 'c', transcript_path: path }, s)
    assert.equal(t.session('c')!.label, 'capex')
  })
})
