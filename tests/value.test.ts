/** bangforbuck, waistline, sherlock, tastetest, haggle, springclean and groundhog. */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, runScript, useTemp, type TempEnv } from './helpers.ts'

import * as bangforbuck from '../scripts/bangforbuck.ts'
import * as groundhogScript from '../scripts/groundhog.ts'
import * as springclean from '../scripts/springclean.ts'
import * as tastetest from '../scripts/tastetest.ts'
import * as waistline from '../scripts/waistline.ts'
import * as contract from '../tokenomics/engine/contract.ts'
import { investigate } from '../tokenomics/engine/forensics.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import { detect } from '../tokenomics/engine/loops.ts'
import { classifyCommand, outcomesOf } from '../tokenomics/engine/outcomes.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { today } from '../tokenomics/util.ts'

const SONNET = 'claude-sonnet-5-5'

/** Builds a Claude Code transcript one step at a time. */
class Tx {
  recs: object[] = []
  n = 0
  ctx = 10_000
  sid: string
  model: string
  cwd: string
  constructor(sid = 'sess-1', model = SONNET, cwd = '/proj') {
    this.sid = sid
    this.model = model
    this.cwd = cwd
  }

  ask(text: string): this {
    this.recs.push({ type: 'user', sessionId: this.sid, cwd: this.cwd, timestamp: this.ts(), message: { role: 'user', content: text } })
    return this
  }

  ts(): string {
    return new Date(Date.UTC(2026, 10, 20, 9, 0, this.n)).toISOString()
  }

  usage(grow = 500) {
    this.ctx += grow
    return { input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: grow, cache_read_input_tokens: this.ctx - grow - 10 }
  }

  call(name: string, input: object, result = 'ok', opts: { error?: boolean, grow?: number, text?: string } = {}): this {
    const id = `toolu_${++this.n}`
    const content: object[] = []
    if (opts.text) content.push({ type: 'text', text: opts.text })
    content.push({ type: 'tool_use', id, name, input })
    this.recs.push({ type: 'assistant', sessionId: this.sid, timestamp: this.ts(),
      message: { id: `msg_${this.n}`, model: this.model, content, usage: this.usage(opts.grow) } })
    this.recs.push({ type: 'user', timestamp: this.ts(), message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: Boolean(opts.error) }] } })
    return this
  }

  say(text: string): this {
    this.n++
    this.recs.push({ type: 'assistant', sessionId: this.sid, timestamp: this.ts(),
      message: { id: `msg_${this.n}`, model: this.model, content: [{ type: 'text', text }], usage: this.usage(100) } })
    return this
  }

  text(): string {
    return this.recs.map((r) => JSON.stringify(r) + '\n').join('')
  }

  write(dir: string, name = this.sid): string {
    const p = join(dir, `${name}.jsonl`)
    writeFileSync(p, this.text())
    return p
  }

  trace(): trace.Trace {
    return trace.parseText(this.text())
  }
}

const BIG = (word: string) => Array.from({ length: 300 }, (_, i) => `${word}Identifier${i} = computeSomething${i}()`).join('\n')

function hook(t: TempEnv, script: string, args: string[], payload: object, env: Record<string, string> = {}) {
  const p = runScript(script, args, { input: JSON.stringify(payload), env: t.env(env) })
  assert.equal(p.status, 0, p.stderr)
  assert.equal(p.stderr, '')
  return p.stdout.trim() ? JSON.parse(p.stdout) : null
}

describe('trace', () => {
  test('streamed messages count usage once and tool results attach to their calls', () => {
    const recs = [
      { type: 'assistant', message: { id: 'm1', model: SONNET, content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'assistant', message: { id: 'm1', model: SONNET, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 5, output_tokens: 9 } } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a\nb' }], is_error: true }] } },
    ]
    const t = trace.parseText(recs.map((r) => JSON.stringify(r)).join('\n'))
    assert.equal(t.turns.length, 1)
    assert.equal(t.turns[0].usage.outputTokens, 9)
    assert.equal(t.steps[0].resultText, 'a\nb')
    assert.equal(t.steps[0].isError, true)
    assert.equal(t.prompts.length, 0, 'tool results are not prompts')
  })

  test('incremental reads lose no line and skip an unfinished one', (c) => {
    const t = useTemp(c)
    const p = join(t.home, 'x.jsonl')
    writeFileSync(p, 'aa\nbb\ncc')
    assert.deepEqual(trace.readText(p), ['aa\nbb\n', 6])
    assert.deepEqual(trace.readText(p, { from: 6 }), ['', 6])
    writeFileSync(p, 'aa\nbb\ncc\ndd\n')
    assert.deepEqual(trace.readText(p, { from: 6 }), ['cc\ndd\n', 12])
    assert.deepEqual(trace.readText(p, { from: 4 }), ['cc\ndd\n', 12], 'a cut line is dropped')
  })
})

describe('bangforbuck', () => {
  test('commands are recognised', () => {
    assert.equal(classifyCommand('cd app && npm test 2>&1 | tail -20'), 'test')
    assert.equal(classifyCommand('python -m pytest -q tests/'), 'test')
    assert.equal(classifyCommand('git commit -m "fix: x"'), 'commit')
    assert.equal(classifyCommand('gh pr create --fill'), 'pr')
    assert.equal(classifyCommand('npx tsc --noEmit'), 'lint')
    assert.equal(classifyCommand('ls -la'), null)
  })

  test('outcomes come from what the agent did', () => {
    const t = new Tx().ask('fix the crash when the config file is empty')
      .call('Bash', { command: 'npm test' }, '1 failed, 9 passed', { error: true })
      .call('Edit', { file_path: '/proj/src/config.ts', old_string: 'a', new_string: 'b' })
      .call('Bash', { command: 'npm test' }, '10 passed')
      .call('Bash', { command: 'npm test' }, '10 passed')
      .call('Bash', { command: 'git commit -am "fix empty config"' }, '[main 1a2b3c] fix').trace()
    assert.deepEqual(outcomesOf(t), { bug_fix: 1, green_suite: 1, commit: 1 })
    const f = new Tx().ask('add a csv export to the report command')
      .call('Write', { file_path: '/proj/src/csv.ts', content: 'x' })
      .call('Bash', { command: 'npx vitest run' }, 'Tests  12 passed (12)').trace()
    assert.deepEqual(outcomesOf(f), { green_suite: 1, feature: 1 })
    const none = new Tx().ask('what does this repo do?').call('Read', { file_path: '/proj/README.md' }, 'hello').trace()
    assert.deepEqual(outcomesOf(none), {})
  })

  test('the hook writes a ledger row and the report prices outcomes per model', (c) => {
    const t = useTemp(c)
    const good = new Tx('s-good', SONNET).ask('fix the failing date parser test')
      .call('Bash', { command: 'npm test' }, '1 failed', { error: true })
      .call('Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' })
      .call('Bash', { command: 'npm test' }, '5 passed').write(t.home)
    hook(t, 'bangforbuck.ts', ['record', 'claude-code'], { session_id: 's-good', transcript_path: good })
    for (const sid of ['s-cheap1', 's-cheap2']) {
      const p = new Tx(sid, 'claude-haiku-5-5').ask('fix the failing date parser test')
        .call('Bash', { command: 'npm test' }, '1 failed', { error: true }).write(t.home)
      hook(t, 'bangforbuck.ts', ['record', 'claude-code'], { session_id: sid, transcript_path: p })
    }
    const row = t.rows('SELECT * FROM ledger WHERE session_id=?', 's-good')[0]
    assert.equal(row.primary_outcome, 'bug_fix')
    assert.equal(row.day, today(new Date(Date.UTC(2026, 10, 20, 9))))
    const r = bangforbuck.build(t.db, 0, ['USD', '$', 1])
    assert.equal(r.sessions, 3)
    assert.equal(r.productive, 1)
    assert.equal(r.nothing_to_show.sessions, 2)
    const haiku = r.by_model.find((m: any) => m.model === 'claude-haiku-5-5')
    assert.equal(haiku.cost_per_success, null, 'no success: no cost per success')
    assert.ok(bangforbuck.markdown(r).includes('Nothing to show'))
  })

  test('hand-marked outcomes count', (c) => {
    const t = useTemp(c)
    const p = runScript('bangforbuck.ts', ['mark', 'feature', 'shipped', 'the', 'thing', '--session', 'abc'], { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    const db = store.connect(t.db)
    try {
      ledger.record(db, ledger.summarise(new Tx('abc').ask('hello').say('hi').trace(), 'abc'))
      const rows = ledger.rows(db, null)
      assert.deepEqual(rows[0].outcomes, { feature: 1 })
      assert.equal(rows[0].primary, 'feature')
    } finally {
      db.close()
    }
  })
})

function row(sid: string, cost: number, extra: Partial<ledger.LedgerRow> = {}): ledger.LedgerRow {
  return { session_id: sid, day: today(), cwd: '/p', model: SONNET, label: null, cost_usd: cost, turns: 10, tool_calls: 10,
    peak_ctx: 40_000, avg_ctx: 25_000, input_tokens: 250_000, output_tokens: 2_000, prompts: 1,
    tools: { Read: { calls: 5, result_tokens: 4_000, errors: 0 } }, outcomes: { feature: 1 }, primary: 'feature', ...extra }
}

describe('waistline', () => {
  test('flags cost creep, new tools and model changes; ignores noise', () => {
    const before = waistline.metrics([1, 2, 3, 4].map((i) => row(`a${i}`, 1.0)))
    const after = waistline.metrics([1, 2, 3, 4].map((i) => row(`b${i}`, 1.5, { avg_ctx: 40_000, model: 'claude-opus-5-5',
      tools: { Read: { calls: 5, result_tokens: 4_000, errors: 0 }, mcp__big__dump: { calls: 2, result_tokens: 9_000, errors: 0 } } })))
    const res = waistline.compare(before, after, 15)
    assert.ok(res.regressed)
    const names = res.checks.filter((x) => x.status === 'regression').map((x) => x.name)
    assert.ok(names.includes('median cost per session'))
    assert.ok(names.includes('context per request'))
    assert.ok(res.findings.some((f) => f.includes('mcp__big__dump')))
    assert.ok(res.findings.some((f) => f.includes('Model change')))
    const steady = waistline.compare(before, waistline.metrics([1, 2, 3, 4].map((i) => row(`c${i}`, 1.05))), 15)
    assert.equal(steady.regressed, false)
    const few = waistline.compare(waistline.metrics([row('x', 1)]), waistline.metrics([row('y', 9)]), 15)
    assert.equal(few.regressed, false, 'one session each is not a trend')
  })

  test('--ci fails on a regression against a saved baseline', (c) => {
    const t = useTemp(c)
    const dir = t.mkdir('runs')
    for (const i of [1, 2, 3]) new Tx(`base${i}`).ask('add a flag').call('Read', { file_path: '/a' }, 'x').write(dir)
    const base = join(t.home, 'baseline.json')
    let p = runScript('waistline.ts', ['--save-baseline', base, '--transcripts', dir], { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    p = runScript('waistline.ts', ['--baseline', base, '--transcripts', dir, '--ci'], { env: t.env() })
    assert.equal(p.status, 0, p.stdout)
    const dear = t.mkdir('dear')
    for (const i of [1, 2, 3]) {
      const x = new Tx(`dear${i}`).ask('add a flag')
      for (let k = 0; k < 6; k++) x.call('Read', { file_path: `/a${k}` }, BIG('w'), { grow: 20_000 })
      x.write(dear)
    }
    const summary = join(t.home, 'summary.md')
    p = runScript('waistline.ts', ['--baseline', base, '--transcripts', dear, '--ci'], { env: t.env({ GITHUB_STEP_SUMMARY: summary }) })
    assert.equal(p.status, 1, p.stdout)
    assert.ok(readFileSync(summary, 'utf8').includes('Cost regression'))
  })
})

describe('sherlock', () => {
  test('finds repeated reads, redundant calls, rephrased searches and unused output', () => {
    const t = new Tx().ask('look into the parser')
      .call('Read', { file_path: '/p/parser.ts' }, BIG('parse'))
      .call('Grep', { pattern: 'tokenize' }, 'src/a.ts\n'.repeat(40))
      .call('Grep', { pattern: 'tokeniz' }, 'src/a.ts\n'.repeat(40))
      .call('Bash', { command: 'git status' }, 'clean')
      .call('Bash', { command: 'git status' }, 'clean')
      .call('Read', { file_path: '/p/parser.ts' }, BIG('parse'))
      .call('Bash', { command: 'cat big.log' }, BIG('logline'))
      .call('Edit', { file_path: '/p/parser.ts', old_string: 'parseIdentifier7 = computeSomething7()\nparseIdentifier8 = computeSomething8()', new_string: 'x' })
      .say('done').trace()
    const r = investigate(t)
    const kinds = new Set(r.findings.map((f) => f.kind))
    for (const k of ['repeated_read', 'redundant_call', 'repeated_search', 'unused_result']) assert.ok(kinds.has(k), k)
    assert.ok(r.wasted_usd > 0 && r.wasted_usd <= r.session_cost_usd)
    const unused = r.findings.filter((f) => f.kind === 'unused_result').map((f) => f.detail)
    assert.deepEqual(unused, ['cat big.log'], 'the parser output was used by the edit; the log was not')
  })

  test('an edit in between makes a re-read legitimate', () => {
    const t = new Tx()
      .call('Read', { file_path: '/p/a.ts' }, 'v1 '.repeat(100))
      .call('Edit', { file_path: '/p/a.ts', old_string: 'v1', new_string: 'v2' })
      .call('Read', { file_path: '/p/a.ts' }, 'v1 '.repeat(100)).trace()
    assert.equal(investigate(t).findings.filter((f) => f.kind === 'repeated_read').length, 0)
  })

  test('subagents: overlap and needless delegation', () => {
    const brief = 'Investigate the authentication middleware and the session token refresh flow in src/auth'
    const t = new Tx()
      .call('Agent', { description: 'auth review', prompt: brief }, 'found a bug '.repeat(200))
      .call('Agent', { description: 'auth check', prompt: brief + ' carefully' }, 'found a bug '.repeat(200))
      .call('Agent', { description: 'find config', prompt: 'find where the config file is read' }, 'src/config.ts line 4').trace()
    const kinds = investigate(t).findings.map((f) => f.kind)
    assert.ok(kinds.includes('overlapping_agents'))
    assert.ok(kinds.includes('needless_agent'))
  })

  test('the hook records the waste', (c) => {
    const t = useTemp(c)
    const p = new Tx('sh1').call('Bash', { command: 'git log -5' }, 'abc').call('Bash', { command: 'git log -5' }, 'abc').write(t.home)
    hook(t, 'sherlock.ts', ['log', 'claude-code'], { session_id: 'sh1', transcript_path: p })
    const r = t.rows('SELECT * FROM sherlock_events')[0]
    assert.equal(r.top_kind, 'redundant_call')
  })
})

describe('groundhog', () => {
  test('rules', () => {
    const same = new Tx().call('Grep', { pattern: 'foo' }, 'x').call('Grep', { pattern: 'foo' }, 'x').trace()
    assert.equal(detect(same, { name: 'Grep', input: { pattern: 'foo' } })?.rule, 'identical_call')
    const edited = new Tx().call('Grep', { pattern: 'foo' }, 'x').call('Edit', { file_path: '/a', old_string: 'a', new_string: 'b' })
      .call('Grep', { pattern: 'foo' }, 'x').trace()
    assert.equal(detect(edited, { name: 'Grep', input: { pattern: 'foo' } }), null, 'something changed in between')

    const failing = new Tx()
    for (let i = 0; i < 3; i++) {
      failing.call('Bash', { command: 'npm test' }, 'Error: expected 2 got 3', { error: true })
        .call('Edit', { file_path: '/a', old_string: `v${i}`, new_string: `v${i + 1}` })
    }
    const loop = detect(failing.trace(), { name: 'Bash', input: { command: 'npm test 2>&1 | tail -5' } })
    assert.equal(loop?.rule, 'failing_command')
    assert.ok(loop!.reason.includes('expected 2 got 3'))
    const twiceUnchanged = new Tx().call('Bash', { command: 'make' }, 'boom', { error: true }).call('Bash', { command: 'make' }, 'boom', { error: true }).trace()
    assert.equal(detect(twiceUnchanged, { name: 'Bash', input: { command: 'make' } })?.rule, 'failing_command')

    const flip = new Tx().call('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })
      .call('Edit', { file_path: '/a', old_string: 'y', new_string: 'x' }).trace()
    assert.equal(detect(flip, { name: 'Edit', input: { file_path: '/a', old_string: 'x', new_string: 'y' } })?.rule, 'edit_flipflop')

    const stall = new Tx()
    for (let i = 0; i < 20; i++) stall.call('Bash', { command: `try-${i}` }, 'nope', { error: i % 4 !== 0, grow: 3_000 })
    assert.equal(detect(stall.trace(), { name: 'Bash', input: { command: 'try-again' } })?.rule, 'no_progress')

    const poll = new Tx().call('Bash', { command: 'sleep 5' }, '').call('Bash', { command: 'sleep 5' }, '').trace()
    assert.equal(detect(poll, { name: 'Bash', input: { command: 'sleep 5' } }), null, 'polling is fine')
  })

  test('the hook refuses, then escalates; bypass and modes', (c) => {
    const t = useTemp(c)
    const p = new Tx('g1').call('Read', { file_path: '/a' }, 'x').call('Read', { file_path: '/a' }, 'x').write(t.home)
    const payload = { session_id: 'g1', transcript_path: p, tool_name: 'Read', tool_input: { file_path: '/a' } }
    for (let i = 0; i < 2; i++) {
      const out = hook(t, 'groundhog.ts', ['claude-code'], payload)
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny')
    }
    assert.ok(hook(t, 'groundhog.ts', ['claude-code'], payload).systemMessage.includes('let a repeated call through'))
    assert.equal(hook(t, 'groundhog.ts', ['claude-code'], payload), null, 'then it stays quiet')

    const t2 = useTemp(c)
    hook(t2, 'groundhog.ts', ['claude-code'], payload, { TOKENOMICS_GROUNDHOG: 'interrupt' })
    assert.equal(hook(t2, 'groundhog.ts', ['claude-code'], payload, { TOKENOMICS_GROUNDHOG: 'interrupt' }).continue, false)
    assert.ok(hook(useTemp(c), 'groundhog.ts', ['claude-code'], payload, { TOKENOMICS_GROUNDHOG: 'warn' }).systemMessage)
    assert.equal(hook(useTemp(c), 'groundhog.ts', ['claude-code'], payload, { TOKENOMICS_GROUNDHOG: 'off' }), null)

    const bash = new Tx('g2').call('Bash', { command: 'ls' }, 'a').call('Bash', { command: 'ls' }, 'a').write(t.home)
    assert.equal(hook(t, 'groundhog.ts', ['claude-code'], { session_id: 'g2', transcript_path: bash, tool_name: 'Bash',
      tool_input: { command: 'ls # groundhog-ok' } }), null)
  })

  test('copilot: identical calls in a row, from the database', (c) => {
    const t = useTemp(c)
    const payload = { sessionId: 'cp', toolName: 'bash', toolArgs: JSON.stringify({ command: 'npm test' }) }
    assert.equal(hook(t, 'groundhog.ts', ['copilot'], payload), null)
    assert.equal(hook(t, 'groundhog.ts', ['copilot'], payload), null)
    const out = hook(t, 'groundhog.ts', ['copilot'], payload)
    assert.ok(out, 'third identical call is refused')
  })

  test('check replays a finished session', () => {
    const t = new Tx().call('Grep', { pattern: 'q' }, 'x').call('Grep', { pattern: 'q' }, 'x').call('Grep', { pattern: 'q' }, 'x').trace()
    assert.equal(groundhogScript.replay(t)[0].rule, 'identical_call')
  })
})

describe('haggle', () => {
  test('estimates scale with complexity and context, and calibrate on history', (c) => {
    const t = useTemp(c)
    const db = store.connect(t.db)
    try {
      const h = contract.history(db)
      const simple = contract.estimate('SIMPLE', 20_000, SONNET, h)
      const hard = contract.estimate('REASONING', 20_000, SONNET, h)
      const bigCtx = contract.estimate('REASONING', 150_000, SONNET, h)
      assert.ok(simple.mid < hard.mid && hard.mid < bigCtx.mid)
      assert.ok(hard.low < hard.mid && hard.mid < hard.high)
      const b = hard.breakdown
      assert.ok(Math.abs(b.input + b.tools + b.output - hard.mid) < 1e-9)
      contract.ensure(db)
      for (let i = 0; i < 3; i++) {
        db.run("INSERT INTO contracts(session_id,status,est_mid,spent_usd) VALUES('x','closed',1,2)")
      }
      assert.equal(contract.history(db).calibration, 2)
    } finally {
      db.close()
    }
  })

  test('agreed price: quote, enforce the cap, approve more', (c) => {
    const t = useTemp(c)
    const x = new Tx('h1').ask('hello').say('hi')
    const path = x.write(t.home)
    const out = hook(t, 'haggle.ts', ['prompt', 'claude-code'], { session_id: 'h1', transcript_path: path,
      prompt: 'haggle $0.01: refactor the authentication module and migrate every caller to the new token API' }, { TOKENOMICS_CURRENCY: 'USD' })
    assert.ok(out.systemMessage.startsWith('haggle:'))
    assert.ok(out.systemMessage.includes('Agreed cap $0.01'))
    assert.ok(out.hookSpecificOutput.additionalContext.includes('hard cap'))
    const guard = { session_id: 'h1', transcript_path: path, tool_name: 'Read', tool_input: { file_path: '/a' } }
    assert.equal(hook(t, 'haggle.ts', ['guard', 'claude-code'], guard), null, 'nothing spent yet')
    for (let i = 0; i < 10; i++) x.call('Read', { file_path: `/f${i}` }, 'x', { grow: 5_000 })
    x.write(t.home)
    const stop = hook(t, 'haggle.ts', ['guard', 'claude-code'], guard, { TOKENOMICS_CURRENCY: 'USD' })
    assert.equal(stop.hookSpecificOutput.permissionDecision, 'deny')
    assert.ok(stop.hookSpecificOutput.permissionDecisionReason.includes('approve'))
    assert.equal(t.rows('SELECT status FROM contracts')[0].status, 'capped')
    const ok = hook(t, 'haggle.ts', ['prompt', 'claude-code'], { session_id: 'h1', transcript_path: path, prompt: 'approve' })
    assert.ok(ok.systemMessage.includes('approved'))
    assert.equal(hook(t, 'haggle.ts', ['guard', 'claude-code'], guard), null)
    hook(t, 'haggle.ts', ['close', 'claude-code'], { session_id: 'h1' })
    const r = t.rows('SELECT status, spent_usd FROM contracts')[0]
    assert.equal(r.status, 'closed')
    assert.ok(r.spent_usd > 0.01)
  })

  test('auto quotes warn but never stop; small and follow-up prompts get no contract', (c) => {
    const t = useTemp(c)
    const x = new Tx('h2').ask('hi')
    const path = x.write(t.home)
    assert.equal(hook(t, 'haggle.ts', ['prompt', 'claude-code'], { session_id: 'h2', transcript_path: path, prompt: 'yes go ahead' }), null)
    assert.equal(hook(t, 'haggle.ts', ['prompt', 'claude-code'], { session_id: 'h2', transcript_path: path, prompt: 'fix the typo in the readme title' }), null)
    const q = hook(t, 'haggle.ts', ['prompt', 'claude-code'], { session_id: 'h2', transcript_path: path,
      prompt: 'Design the architecture for a multi-tenant billing system: evaluate the trade-offs between event sourcing and CRUD, ' +
        'plan the migration step by step, and refactor the existing invoice module across all services' })
    assert.ok(q.systemMessage.includes('quoted'))
    db(t, "UPDATE contracts SET cap_usd=0.0001, target_usd=0.00005")
    for (let i = 0; i < 3; i++) x.call('Read', { file_path: `/f${i}` }, 'x')
    x.write(t.home)
    const guard = { session_id: 'h2', transcript_path: path, tool_name: 'Read', tool_input: {} }
    const warn = hook(t, 'haggle.ts', ['guard', 'claude-code'], guard)
    assert.ok(warn.systemMessage.includes('past its'), JSON.stringify(warn))
    assert.equal(hook(t, 'haggle.ts', ['guard', 'claude-code'], guard), null, 'warned once')
  })

  test('quote command answers "is it worth £2?"', (c) => {
    const t = useTemp(c)
    const p = runScript('haggle.ts', ['quote', 'refactor', 'the', 'auth', 'module', '--price', '1000', '--json'], { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    const r = JSON.parse(p.stdout)
    assert.ok(r.verdict.startsWith('Yes'))
    const cheap = JSON.parse(runScript('haggle.ts', ['quote', 'refactor the auth module', '--price', '0.0001', '--json'], { env: t.env() }).stdout)
    assert.ok(cheap.verdict.startsWith('Unlikely'))
  })
})

function db(t: TempEnv, sql: string): void {
  const d = store.connect(t.db)
  try {
    d.exec(sql)
  } finally {
    d.close()
  }
}

describe('springclean', () => {
  test('duplicates, stale references, bloat and contradictions', (c) => {
    const t = useTemp(c)
    const dir = t.mkdir('proj')
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'main.ts'), '')
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }))
    writeFileSync(join(dir, 'CLAUDE.md'), [
      '# Rules', '- Always run the unit tests before committing any change.', '- Use npm to install the dependencies here.',
      '- Run `npm run typecheck` before pushing.', '- The entry point is `src/main.ts`; settings live in `src/settings.ts`.',
      '## Changelog', '- v1: first', '- v2: second', '```', ...Array.from({ length: 30 }, (_, i) => `line ${i}`), '```',
    ].join('\n'))
    writeFileSync(join(dir, 'AGENTS.md'), ['- Always run the unit tests before committing any change!',
      '- Use pnpm to install the dependencies here.'].join('\n'))
    const docs = springclean.collect(dir, t.home)
    const kinds = springclean.audit(dir, docs).map((f) => `${f.kind} ${f.detail}`)
    const has = (re: RegExp) => assert.ok(kinds.some((k) => re.test(k)), `${re} in\n${kinds.join('\n')}`)
    has(/^duplicate .*Always run the unit tests/)
    has(/^outdated .*typecheck/)
    has(/^outdated .*src\/settings\.ts/)
    has(/^bloat .*Changelog/)
    has(/^bloat .*30-line code block/)
    has(/^contradiction package manager/)
    assert.ok(!kinds.some((k) => k.includes('src/main.ts')), 'existing files are fine')
    const r = springclean.build(dir, t.db, 1500)
    assert.ok(r.savings.tokens > 0)
  })
})

describe('tastetest', () => {
  test('test counts from common runners', () => {
    assert.deepEqual(tastetest.counts('# tests 10\n# pass 9\n# fail 1\n'), [9, 1])
    assert.deepEqual(tastetest.counts('Tests:       2 failed, 40 passed, 42 total'), [40, 2])
    assert.deepEqual(tastetest.counts('==== 3 failed, 97 passed in 2.1s ===='), [97, 3])
    assert.deepEqual(tastetest.counts('test result: ok. 12 passed; 0 failed; 0 ignored'), [12, 0])
    assert.deepEqual(tastetest.counts('  14 passing (2s)\n  1 failing'), [14, 1])
    assert.deepEqual(tastetest.counts('ok  	example.com/pkg	0.01s'), [null, null])
  })

  test('verdicts', () => {
    const s = (cost: number, quality: number) => ({ name: '', source: null, cost_usd: cost, tokens: null, turns: null, checks: [],
      signals: { final_tests: null, error_rate: null }, quality })
    assert.equal(tastetest.judge(s(2, 1), s(1, 1)).verdict, 'safe-saving')
    assert.equal(tastetest.judge(s(2, 1), s(1, 0.4)).verdict, 'false-economy')
    assert.equal(tastetest.judge(s(2, 1), s(1, 0.9)).verdict, 'cheaper-but-worse')
    assert.equal(tastetest.judge(s(1, 0.5), s(2, 1)).verdict, 'better-for-more')
    assert.equal(tastetest.judge(s(1, 1), s(2, 0.5)).verdict, 'worse')
    assert.equal(tastetest.judge(s(2, 1), s(1, 1)).quality_adjusted_saving_pct, 50)
  })

  test('end to end: two transcripts, two working copies, a check', (c) => {
    const t = useTemp(c)
    const a = new Tx('ta', 'claude-opus-5-5').ask('add x').call('Bash', { command: 'npm test' }, '3 passed').write(t.home)
    const b = new Tx('tb', 'claude-haiku-5-5').ask('add x').call('Bash', { command: 'npm test' }, '3 passed').write(t.home)
    const da = t.mkdir('a')
    const dbb = t.mkdir('b')
    writeFileSync(join(da, 'ok'), '')
    const check = 'node -e "process.exit(require(\'fs\').existsSync(\'ok\') ? 0 : 1)"'
    const p = runScript('tastetest.ts', ['--a', a, '--b', b, '--a-dir', da, '--b-dir', dbb, '--check', check, '--json', '--save', 'haiku-trial'],
      { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    const r = JSON.parse(p.stdout)
    assert.equal(r.a.checks[0].score, 1)
    assert.equal(r.b.checks[0].score, 0)
    assert.equal(r.verdict, 'false-economy')
    assert.equal(t.rows('SELECT label FROM tastetest_runs')[0].label, 'haiku-trial')
  })
})

describe('wiring', () => {
  test('every new hook script is registered through the launcher, and the cli knows the tools', () => {
    const cc = readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')
    for (const s of ['groundhog.ts claude-code', 'haggle.ts prompt', 'haggle.ts guard', 'haggle.ts settle', 'haggle.ts close',
      'bangforbuck.ts record', 'sherlock.ts log', 'waistline.ts nudge']) {
      assert.ok(cc.includes(`run.sh\\" ${s}`), s)
    }
    assert.ok(readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8').includes('groundhog.ts copilot'))
    for (const skill of ['bangforbuck', 'waistline', 'sherlock', 'tastetest', 'haggle', 'springclean', 'groundhog']) {
      const md = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8')
      assert.match(md, new RegExp(`^---\\nname: ${skill}\\n`), skill)
    }
  })

  test('hook scripts stay silent and exit 0 on bad input', (c) => {
    const t = useTemp(c)
    for (const [script, args] of [['groundhog.ts', ['claude-code']], ['groundhog.ts', ['copilot']], ['haggle.ts', ['prompt', 'claude-code']],
      ['haggle.ts', ['guard', 'claude-code']], ['haggle.ts', ['close', 'claude-code']], ['bangforbuck.ts', ['record', 'claude-code']],
      ['sherlock.ts', ['log', 'claude-code']], ['waistline.ts', ['nudge', 'claude-code']]] as [string, string[]][]) {
      for (const input of ['', 'not json', '{}', JSON.stringify({ transcript_path: '/nope.jsonl', session_id: 'x', tool_name: 'Read' })]) {
        const p = runScript(script, args, { input, env: t.env() })
        assert.equal(p.status, 0, `${script} ${input}: ${p.stderr}`)
        assert.equal(p.stdout, '', `${script} ${input}`)
        assert.equal(p.stderr, '', `${script} ${input}`)
      }
    }
  })
})
