import { describe, test } from 'node:test'
import assert from 'node:assert/strict'

import { classify, clean, labelFor, score, scoreCommand, scoreTool } from '../tokenomics/engine/classifier.ts'
import { prompt, sessionEvidence, TOOL_CODE_EDIT, TOOL_OTHER, TOOL_SHELL, toolCall } from '../tokenomics/engine/evidence.ts'
import { HOLDOUT_PROMPTS, LABELLED_COMMANDS, LABELLED_PROMPTS } from './fixtures_classifier.ts'

function side([o, c]: [number, number]): 'opex' | 'capex' | null {
  return o > c ? 'opex' : c > o ? 'capex' : null
}

describe('prompt classification', () => {
  for (const [name, set] of [['labelled', LABELLED_PROMPTS], ['holdout', HOLDOUT_PROMPTS]] as const) {
    test(`every ${name} prompt lands on its side`, () => {
      const misses = set.filter(([p, want]) => labelFor(...score(p)) !== want)
        .map(([p, want]) => `${want} <- ${labelFor(...score(p))}: ${p.slice(0, 60)}`)
      assert.deepEqual(misses, [])
    })
  }

  test('false friends do not count as OPEX', () => {
    for (const p of ['users cannot log in', 'remove console.log', 'git log is messy', 'parse the stack trace',
      'show an alert dialog', 'update the changelog']) {
      assert.equal(score(p)[0], 0, p)
    }
  })

  test('machine-written blocks in a user turn are ignored', () => {
    assert.deepEqual(score('<local-command-stdout>grafana logs metrics dashboards</local-command-stdout>'), [0, 0])
    assert.equal(clean('<system-reminder>prometheus</system-reminder> hi').trim(), 'hi')
  })
})

describe('tool classification', () => {
  test('shell commands are judged by what they run', () => {
    const misses = LABELLED_COMMANDS.filter(([cmd, want]) => side(scoreCommand(cmd)) !== want)
    assert.deepEqual(misses, [])
  })

  test('observability MCP tools are OPEX, PR tools are CAPEX, edits are CAPEX', () => {
    assert.equal(side(scoreTool(toolCall('mcp__datadog__search_logs', TOOL_OTHER))), 'opex')
    assert.equal(side(scoreTool(toolCall('mcp__pagerduty__list_incidents', TOOL_OTHER))), 'opex')
    assert.equal(side(scoreTool(toolCall('mcp__github__create_pull_request', TOOL_OTHER))), 'capex')
    assert.equal(side(scoreTool(toolCall('Edit', TOOL_CODE_EDIT))), 'capex')
    assert.equal(side(scoreTool(toolCall('Bash', TOOL_SHELL, { command: 'git log -5' }))), null)
  })

  test('a coding session that greps for "metrics" stays CAPEX', () => {
    const ev = sessionEvidence({ sessionId: 's', platform: 'x',
      prompts: [prompt('the metrics exporter test fails, fix it')],
      toolCalls: [toolCall('Bash', TOOL_SHELL, { command: 'grep -rn "metrics" src/' }),
        toolCall('Bash', TOOL_SHELL, { command: 'git log -3' }), toolCall('Edit', TOOL_CODE_EDIT),
        toolCall('Bash', TOOL_SHELL, { command: 'npm test' })] })
    assert.equal(classify(ev).label, 'capex')
  })

  test('an incident session stays OPEX', () => {
    const ev = sessionEvidence({ sessionId: 's', platform: 'x',
      prompts: [prompt('checkout is throwing 502s in prod, what is going on')],
      toolCalls: [toolCall('Bash', TOOL_SHELL, { command: 'kubectl logs deploy/checkout --since=30m' }),
        toolCall('mcp__grafana__query_prometheus', TOOL_OTHER), toolCall('Bash', TOOL_SHELL, { command: 'git log -5' })] })
    assert.equal(classify(ev).label, 'opex')
  })
})
