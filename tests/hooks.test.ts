/** End-to-end through the real hook command, as each platform runs it. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { assistant, ROOT, useTemp, user, writeTranscript, type TempEnv } from './helpers.ts'

function runOk(t: TempEnv, mode: string, source: string, payload: unknown, env = {}) {
  const p = t.hook(mode, source, payload, env)
  assert.equal(p.status, 0, p.stderr)
  assert.equal(p.stdout, '', 'hooks must print nothing')
  assert.equal(p.stderr, '')
  return p
}

describe('hook runs', () => {
  test('claude code flow', (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 's', [
      user('why is the p99 latency up in grafana? check the loki logs'),
      assistant('m1', [['mcp__grafana__query', {}], ['Bash', { command: 'kubectl logs api-1' }]]),
      user('<command-name>/grafana-triage</command-name>'),
      { type: 'system', content: 'Skills:\n- grafana-triage: Investigate dashboards and alerts for incidents' },
    ])
    runOk(t, 'prompt', 'claude-code', { session_id: 's', cwd: '/x', prompt: 'check the grafana dashboard' })
    runOk(t, 'finalize', 'claude-code', { session_id: 's', cwd: '/x', hook_event_name: 'SessionEnd', transcript_path: path })
    const r = t.session('s')!
    // Regression values for this transcript.
    assert.deepEqual([r.label, r.opex_score, r.capex_score, r.prompt_count], ['opex', 28, 0, 2])
    assert.deepEqual([r.total_tokens, r.skill_opex], [1160, 1])
    assert.deepEqual(JSON.parse(r.skills), ['grafana-triage'])
  })

  test('copilot flow', (c) => {
    const t = useTemp(c)
    const sid = '3f1c-copilot'
    runOk(t, 'prompt', 'copilot', { sessionId: sid, timestamp: 1, cwd: '/x', prompt: 'add a cli command to export the report' })
    runOk(t, 'tool', 'copilot', { sessionId: sid, timestamp: 2, cwd: '/x', toolName: 'edit',
      toolArgs: JSON.stringify({ path: 'cli.py' }), toolResult: { resultType: 'success' } })
    runOk(t, 'finalize', 'copilot', { sessionId: sid, timestamp: 3, cwd: '/x', reason: 'complete' })
    const r = t.session(sid)!
    assert.deepEqual([r.source, r.label, r.capex_score, r.prompt_count], ['copilot', 'capex', 10, 1])
    assert.equal(r.total_tokens, null)
    assert.deepEqual(t.rows('SELECT tool, kind FROM tool_events WHERE session_id=?', sid), [{ tool: 'edit', kind: 'code_edit' }])
  })

  test('finalize is idempotent', (c) => {
    const t = useTemp(c)
    runOk(t, 'prompt', 'copilot', { sessionId: 'idem', prompt: 'check the grafana dashboard' })
    runOk(t, 'tool', 'copilot', { sessionId: 'idem', toolName: 'bash', toolArgs: { command: 'kubectl logs x' } })
    runOk(t, 'finalize', 'copilot', { sessionId: 'idem' })
    const first = t.session('idem')!.opex_score
    runOk(t, 'finalize', 'copilot', { sessionId: 'idem' })
    assert.equal(t.session('idem')!.opex_score, first)
  })

  test('bad input never blocks', (c) => {
    const t = useTemp(c)
    for (const payload of ['', 'not json', '[1,2]', '{}']) {
      for (const mode of ['prompt', 'tool', 'finalize']) {
        for (const src of ['claude-code', 'copilot', 'unknown']) runOk(t, mode, src, payload)
      }
    }
  })

  test('capabilities command', (c) => {
    const t = useTemp(c)
    const data = JSON.parse(t.hook('capabilities', '', '').stdout)
    assert.deepEqual(new Set(Object.keys(data)), new Set(['claude-code', 'copilot']))
    assert.equal(data.copilot.capabilities.token_usage.level, 'none')
  })
})

describe('hook config', () => {
  test('hook files use known modes', () => {
    const modes = new Set(['prompt', 'tool', 'finalize'])
    const cc = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
    const cp = JSON.parse(readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8'))
    const cmds: string[] = Object.values(cc.hooks).flatMap((arms: any) => arms.flatMap((g: any) => g.hooks.map((h: any) => h.command)))
    cmds.push(...Object.values(cp.hooks).flatMap((arms: any) => arms.map((h: any) => h.bash)))
    const lens = cmds.filter((c) => c.includes('spendlens.ts'))
    assert.ok(lens.length)
    for (const c of lens) {
      const parts = c.replaceAll('"', '').split(/\s+/)
      const i = parts.findIndex((x) => x.endsWith('spendlens.ts'))
      assert.ok(modes.has(parts[i + 1]), c)
    }
    assert.ok(lens.some((c) => c.includes(' tool copilot')), 'copilot postToolUse not wired')
  })
})
