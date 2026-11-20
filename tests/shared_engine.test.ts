/** Both adapters must run the same optimisation logic from the shared engine. */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { assistant, useTemp, user, writeTranscript, type TempEnv } from './helpers.ts'

import * as cc from '../tokenomics/adapters/claude_code.ts'
import * as cp from '../tokenomics/adapters/copilot.ts'
import { settings } from '../tokenomics/config.ts'
import * as classifier from '../tokenomics/engine/classifier.ts'
import * as session from '../tokenomics/engine/session.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'

async function claude(t: TempEnv, sid: string, prompts: string[], tools: [string, object][]) {
  const s = settings({ dbPath: t.db })
  const path = writeTranscript(t.home, sid, [...prompts.map((p) => user(p)), assistant('m1', tools)])
  const a = getAdapter('claude-code')
  for (const p of prompts) session.recordPrompt(a, { session_id: sid, prompt: p, cwd: '/w' }, s)
  await session.finalize(a, { session_id: sid, cwd: '/w', hook_event_name: 'SessionEnd', transcript_path: path }, s)
  return t.session(sid)!
}

async function copilot(t: TempEnv, sid: string, prompts: string[], tools: [string, unknown][]) {
  const s = settings({ dbPath: t.db })
  const a = getAdapter('copilot')
  for (const p of prompts) session.recordPrompt(a, { sessionId: sid, prompt: p, cwd: '/w' }, s)
  for (const [name, args] of tools) session.recordTool(a, { sessionId: sid, toolName: name, toolArgs: args, cwd: '/w' }, s)
  await session.finalize(a, { sessionId: sid, cwd: '/w', reason: 'complete' }, s)
  return t.session(sid)!
}

function assertSameResult(a: Record<string, any>, b: Record<string, any>) {
  for (const k of ['label', 'opex_score', 'capex_score', 'prompt_count', 'skills', 'skill_opex', 'skill_capex']) assert.equal(a[k], b[k], k)
}

describe('same logic on both platforms', () => {
  test('a CAPEX session scores identically', async (c) => {
    const t = useTemp(c)
    const prompts = ['implement a new endpoint for the orders api', 'now write unit tests']
    const a = await claude(t, 'c1', prompts, [['Edit', {}], ['Write', {}]])
    const b = await copilot(t, 'g1', prompts, [['edit', { path: 'a.py' }], ['create', { path: 'b.py' }]])
    assert.equal(a.label, 'capex')
    assertSameResult(a, b)
  })

  test('an OPEX session scores identically', async (c) => {
    const t = useTemp(c)
    const prompts = ['why is p99 latency up? check the grafana dashboard and loki logs']
    const a = await claude(t, 'c2', prompts, [['Bash', { command: 'kubectl logs api' }], ['mcp__grafana__query', {}]])
    const b = await copilot(t, 'g2', prompts, [['bash', '{"command": "kubectl logs api"}'], ['grafana/query', {}]])
    assert.equal(a.label, 'opex')
    assertSameResult(a, b)
  })

  test('skill classification is shared', async (c) => {
    const t = useTemp(c)
    const a = await claude(t, 'c3', ['hi'], [['Skill', { skill: 'grafana-triage' }]])
    const b = await copilot(t, 'g3', ['hi'], [['skill', { skill: 'grafana-triage' }]])
    assert.equal(a.skill_opex, 1)
    assertSameResult(a, b)
  })

  test('changing the shared logic changes both adapters (no private copies)', async (c) => {
    const t = useTemp(c)
    const opex = classifier.OPEX_PATTERNS.splice(0, Infinity, [String.raw`\bbanana\b`, 9])
    const capex = classifier.CAPEX_PATTERNS.splice(0, Infinity)
    let a, b
    try {
      a = await claude(t, 'c4', ['banana'], [])
      b = await copilot(t, 'g4', ['banana'], [])
    } finally {
      classifier.OPEX_PATTERNS.splice(0, Infinity, ...opex)
      classifier.CAPEX_PATTERNS.splice(0, Infinity, ...capex)
    }
    assert.deepEqual([a.opex_score, a.label], [9, 'opex'])
    assertSameResult(a, b)
  })

  test('adapters hold no scoring logic', () => {
    for (const mod of [cc, cp] as Record<string, unknown>[]) {
      for (const banned of ['OPEX_PATTERNS', 'CAPEX_PATTERNS', 'labelFor', 'score', 'SKILL_WEIGHT']) {
        assert.ok(!(banned in mod), `an adapter defines ${banned}`)
      }
    }
  })
})

describe('labels', () => {
  test('label rules', () => {
    assert.equal(classifier.labelFor(0, 0), 'unknown')
    assert.equal(classifier.labelFor(10, 2), 'opex')
    assert.equal(classifier.labelFor(2, 10), 'capex')
    assert.equal(classifier.labelFor(8, 10), 'mixed')
  })

  test('the skill map wins', () => {
    assert.deepEqual(classifier.classifySkill('pdf', null, { pdf: 'opex' }), ['opex', 'map'])
    assert.deepEqual(classifier.classifySkill('plugin:pdf', null, { pdf: 'capex' }), ['capex', 'map'])
  })

  test('the description decides', () => {
    assert.deepEqual(classifier.classifySkill('acme', 'Create unit tests using NUnit'), ['capex', 'description'])
    assert.deepEqual(classifier.classifySkill('acme', 'Analyses App Insights telemetry'), ['opex', 'description'])
  })
})
