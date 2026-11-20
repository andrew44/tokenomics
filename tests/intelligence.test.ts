/** The intelligence engine: the five shared services, and splitthebill, bazaar, blinkers, crystalball, deadwood. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, runScript, useTemp, type TempEnv } from './helpers.ts'

import * as bazaar from '../scripts/bazaar.ts'
import * as blinkers from '../scripts/blinkers.ts'
import * as crystalball from '../scripts/crystalball.ts'
import * as deadwood from '../scripts/deadwood.ts'
import * as splitthebill from '../scripts/splitthebill.ts'
import { GATE_FAILS } from '../scripts/tastetest.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import * as ledger from '../tokenomics/engine/ledger.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { CostEngine, InsightsEngine, OutcomeEngine, PolicyEngine, TelemetryEngine } from '../tokenomics/services/index.ts'
import * as value from '../tokenomics/services/value.ts'
import { today } from '../tokenomics/util.ts'

const SONNET = 'claude-sonnet-5-5'

/** A Claude Code transcript, one step at a time. */
class Tx {
  recs: object[] = []
  n = 0
  sec = 0
  sid: string
  model: string
  cwd: string
  constructor(sid = 's1', model = SONNET, cwd = '/proj') {
    this.sid = sid
    this.model = model
    this.cwd = cwd
  }

  ts(): string {
    return new Date(Date.UTC(2026, 10, 20, 9, 0, this.sec)).toISOString()
  }

  ask(text: string): this {
    this.sec += 1
    this.recs.push({ type: 'user', sessionId: this.sid, cwd: this.cwd, timestamp: this.ts(), message: { role: 'user', content: text } })
    return this
  }

  call(name: string, input: object, result = 'ok', o: { error?: boolean, sidechain?: boolean, wait?: number } = {}): this {
    const id = `toolu_${++this.n}`
    this.sec += o.wait ?? 2
    this.recs.push({ type: 'assistant', sessionId: this.sid, timestamp: this.ts(), isSidechain: Boolean(o.sidechain),
      message: { id: `msg_${this.n}`, model: this.model, content: [{ type: 'tool_use', id, name, input }],
        usage: { input_tokens: 10, output_tokens: 200, cache_creation_input_tokens: 500, cache_read_input_tokens: 10_000 } } })
    this.sec += 1
    this.recs.push({ type: 'user', timestamp: this.ts(), isSidechain: Boolean(o.sidechain),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: Boolean(o.error) }] } })
    return this
  }

  /** A Task call with a subagent that makes `steps` calls before returning. */
  agent(type: string, steps: number): this {
    const id = `toolu_${++this.n}`
    this.sec += 1
    this.recs.push({ type: 'assistant', timestamp: this.ts(), message: { id: `msg_${this.n}`, model: this.model,
      content: [{ type: 'tool_use', id, name: 'Task', input: { subagent_type: type, description: 'look', prompt: 'look around' } }],
      usage: { input_tokens: 10, output_tokens: 50, cache_creation_input_tokens: 100, cache_read_input_tokens: 10_000 } } })
    for (let i = 0; i < steps; i++) this.call('Read', { file_path: `/proj/f${i}.ts` }, 'x', { sidechain: true })
    this.recs.push({ type: 'user', timestamp: this.ts(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'found it', is_error: false }] } })
    return this
  }

  interrupt(): this {
    this.recs.push({ type: 'user', timestamp: this.ts(), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })
    return this
  }

  apiError(): this {
    this.recs.push({ type: 'assistant', isApiErrorMessage: true, timestamp: this.ts(), message: { id: `err_${++this.n}`, model: '<synthetic>',
      content: [{ type: 'text', text: 'API Error: overloaded' }] } })
    return this
  }

  text(): string {
    return this.recs.map((r) => JSON.stringify(r) + '\n').join('')
  }

  trace(): trace.Trace {
    return trace.parseText(this.text())
  }

  write(dir: string): string {
    const p = join(dir, `${this.sid}.jsonl`)
    writeFileSync(p, this.text())
    return p
  }
}

const edit = (path: string, a = 'a', b = 'b') => ['Edit', { file_path: path, old_string: a, new_string: b }] as const
const fixed = (sid = 'ok') => new Tx(sid).ask('fix the login redirect in src/auth/login.ts')
  .call('Bash', { command: 'npm test' }, '1 test failed', { error: true }).call(...edit('/proj/src/auth/login.ts'))
  .call('Bash', { command: 'npm test' }, '# pass 3\n# fail 0').call('Bash', { command: 'git commit -am fix' }, '[main 1a2b3c4] fix\n 1 file changed')

describe('trace: agents, latency, API errors, interrupts', () => {
  test('sidechain turns belong to the subagent that was running', () => {
    const t = new Tx().ask('find it').agent('Explore', 2).call('Read', { file_path: '/proj/a.ts' }).trace()
    assert.deepEqual(t.turns.map((x) => x.agent), ['main', 'Explore', 'Explore', 'main'])
    assert.equal(t.steps[1].agent, 'Explore')
  })

  test('latency is measured from the input to the reply, and API errors are counted', () => {
    const t = new Tx().ask('hi').call('Bash', { command: 'ls' }, 'ok', { wait: 7 }).apiError().interrupt().trace()
    assert.equal(t.turns[0].latency, 7)
    assert.deepEqual(t.apiErrors, { [SONNET]: 1 })
    assert.equal(t.interrupts.length, 1)
  })
})

describe('OutcomeEngine: status from observable signals', () => {
  const st = (tx: Tx) => OutcomeEngine.judge(tx.trace()).status

  test('the statuses', () => {
    assert.equal(st(fixed()), 'succeeded')
    assert.equal(st(new Tx().ask('fix the bug').call(...edit('/proj/a.ts')).call('Bash', { command: 'npm test' }, '2 tests failed', { error: true })), 'failed')
    assert.equal(st(new Tx().ask('fix the bug').call(...edit('/proj/a.ts')).call('Bash', { command: 'git checkout -- a.ts' })), 'discarded')
    assert.equal(st(new Tx().ask('add x').call(...edit('/proj/a.ts')).call(...edit('/proj/b.ts'),
      "The user doesn't want to proceed with this tool use. The tool use was rejected", { error: true })), 'discarded')
    assert.equal(st(new Tx().ask('add x').call(...edit('/proj/a.ts')).interrupt()), 'abandoned')
    assert.equal(st(new Tx().ask('add x').call(...edit('/proj/a.ts'))), 'unverified')
    assert.equal(st(new Tx().ask('what does this do?').call('Read', { file_path: '/proj/a.ts' })), 'no_change')
  })

  test('created files deleted again are discarded work; commit SHAs are kept', () => {
    const t = new Tx().ask('try a script').call('Write', { file_path: '/proj/tmp.py', content: 'print(1)' }, 'File created successfully at: /proj/tmp.py')
      .call('Bash', { command: 'rm tmp.py' })
    assert.equal(st(t), 'discarded')
    assert.deepEqual(OutcomeEngine.judge(fixed().trace()).signals.commits, ['1a2b3c4'])
  })

  test('the same rules judge Copilot hook events', () => {
    const ev = (o: object) => ({ type: 'tool_result', tool: null, tool_kind: null, command_kind: null, ok: 1, path: null, ...o })
    const sig = OutcomeEngine.signals(OutcomeEngine.activityFromEvents([
      ev({ tool: 'edit', tool_kind: 'code_edit', path: 'a.py' }), ev({ tool: 'bash', tool_kind: 'shell', command_kind: 'test', ok: 0 }),
    ]))
    assert.equal(OutcomeEngine.status(sig).status, 'failed')
    const ok = OutcomeEngine.signals(OutcomeEngine.activityFromEvents([ev({ tool: 'edit', tool_kind: 'code_edit', path: 'a.py' }),
      ev({ tool: 'bash', tool_kind: 'shell', command_kind: 'commit' })]))
    assert.equal(OutcomeEngine.status(ok).status, 'succeeded')
  })

  test('category, quality and marks', () => {
    const v = OutcomeEngine.judge(fixed().trace())
    assert.equal(OutcomeEngine.category(['fix the login redirect'], v.signals), 'bug_fix')
    assert.equal(OutcomeEngine.category(['explain the auth flow'], OutcomeEngine.signals([])), 'research')
    assert.ok(OutcomeEngine.quality(v.signals)! > 0.7)
    assert.equal(OutcomeEngine.quality(OutcomeEngine.signals([])), null, 'no evidence, no score')
    assert.equal(OutcomeEngine.applyMark('unverified', 'discarded'), 'discarded')
  })
})

describe('TelemetryEngine: one event format for both platforms', () => {
  test('Claude Code and Copilot payloads normalise to the same shape, with no text kept', () => {
    const cc = TelemetryEngine.normalise(getAdapter('claude-code'), { session_id: 'a', cwd: ROOT, hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command: 'npm test -- secret' } }, 'guard')
    const cp = TelemetryEngine.normalise(getAdapter('copilot'), { sessionId: 'b', cwd: ROOT, toolName: 'bash',
      toolArgs: '{"command":"npm test -- secret"}', toolResult: { resultType: 'failure' } }, 'tool')
    assert.equal(cc.type, 'tool_call')
    assert.equal(cp.type, 'tool_result')
    assert.deepEqual(Object.keys(cc).sort(), Object.keys(cp).sort())
    for (const e of [cc, cp]) {
      assert.equal(e.tool_kind, 'shell')
      assert.equal(e.command_kind, 'test')
      assert.equal(e.project, 'tokenomics')
      assert.ok(!JSON.stringify(e).includes('secret'))
    }
    assert.equal(cp.ok, false)
    const p = TelemetryEngine.normalise(getAdapter('copilot'), { sessionId: 'b', prompt: 'my private words' }, 'prompt')
    assert.equal(p.prompt_chars, 16)
    assert.ok(!JSON.stringify(p).includes('private'))
  })

  test('edit paths are kept relative to the project', () => {
    const e = TelemetryEngine.normalise(getAdapter('copilot'), { sessionId: 'b', cwd: ROOT, toolName: 'edit',
      toolArgs: { path: join(ROOT, 'scripts', 'cli.ts') } }, 'tool')
    assert.equal(e.path, 'scripts/cli.ts')
  })

  test('spendlens stores the shared event on every hook run, silently; TOKENOMICS_TELEMETRY=off stops it', (c) => {
    const t = useTemp(c)
    for (const [mode, payload] of [['prompt', { sessionId: 'cp', cwd: '/w', prompt: 'add a flag' }],
      ['tool', { sessionId: 'cp', cwd: '/w', toolName: 'edit', toolArgs: { path: '/w/a.py' }, toolResult: { resultType: 'success' } }],
      ['finalize', { sessionId: 'cp', cwd: '/w' }]] as const) {
      const p = t.hook(mode, 'copilot', payload)
      assert.equal(p.status, 0)
      assert.equal(p.stdout, '')
    }
    const rows = t.rows('SELECT type, tool_kind, path, ok FROM telemetry_events WHERE session_id=? ORDER BY id', 'cp')
    assert.deepEqual(rows.map((r) => r.type), ['prompt', 'tool_result', 'session_end'])
    assert.deepEqual([rows[1].tool_kind, rows[1].path, rows[1].ok], ['code_edit', 'a.py', 1])
    t.hook('prompt', 'copilot', { sessionId: 'off', prompt: 'x' }, { TOKENOMICS_TELEMETRY: 'off' })
    assert.equal(t.rows("SELECT COUNT(*) AS n FROM telemetry_events WHERE session_id='off'")[0].n, 0)
  })

  test('breakdown: cost by agent and by model, with provider and latency', () => {
    const b = TelemetryEngine.breakdown(new Tx().ask('x').agent('Explore', 2).call('Read', { file_path: '/proj/a.ts' }).trace())
    assert.deepEqual(Object.keys(b.agents).sort(), ['Explore', 'main'])
    assert.equal(b.models[SONNET].provider, 'anthropic')
    assert.equal(b.models[SONNET].turns, 4)
  })
})

describe('CostEngine', () => {
  test('provider from the model id', () => {
    assert.equal(CostEngine.provider('us.anthropic.claude-sonnet-5-5-v1:0'), 'bedrock')
    assert.equal(CostEngine.provider('claude-sonnet-5-5@20261001'), 'vertex')
    assert.equal(CostEngine.provider('claude-opus-5-5', {}), 'anthropic')
    assert.equal(CostEngine.provider('claude-opus-5-5', { CLAUDE_CODE_USE_BEDROCK: '1' }), 'bedrock')
    assert.equal(CostEngine.provider('gpt-5'), 'openai')
  })

  test('offerings: Claude rows priced from the model price file; your file overrides and adds', () => {
    const list = CostEngine.offerings()
    const sonnet = list.find((o) => o.id === 'anthropic/sonnet-5.5')!
    assert.deepEqual([sonnet.input, sonnet.output, sonnet.cacheRead], [2, 10, 0.1])
    const mine = CostEngine.offerings({ offerings: [{ id: 'bedrock/sonnet-5.5', price_multiplier: 0.8 }, { id: 'acme/x', provider: 'acme', input: 1, output: 2, tier: 'balanced' }] })
    assert.equal(mine.find((o) => o.id === 'bedrock/sonnet-5.5')!.input, 1.6)
    const acme = mine.find((o) => o.id === 'acme/x')!
    assert.equal(acme.cacheRead, null)
    assert.equal(CostEngine.workloadCostUsd(CostEngine.workload({ cacheRead: 1e6 }), acme), 1, 'no cached price: billed as input')
  })

  test('projection: the brief\'s example, by hand', () => {
    const s = CostEngine.scenario({ developers: 10, tasksPerDay: 20, workingDays: 21, inputPerTask: 50_000, outputPerTask: 5_000, cacheHit: 0 })
    const o = CostEngine.offerings().find((x) => x.id === 'anthropic/sonnet-5.5')!
    const p = CostEngine.project(s, o)
    assert.equal(CostEngine.tasksPerMonth(s), 4200)
    assert.ok(Math.abs(p.monthlyUsd - 4200 * (50_000 * 2 + 5_000 * 10) / 1e6) < 1e-9)
  })
})

describe('PolicyEngine', () => {
  test('ask is a confirm prompt in Claude Code and a refusal that says to ask in Copilot', () => {
    const cc = PolicyEngine.enforce(getAdapter('claude-code'), 'ask', 'why')!
    assert.equal(cc.hookSpecificOutput.permissionDecision, 'ask')
    const cp = PolicyEngine.enforce(getAdapter('copilot'), 'ask', 'why')!
    assert.equal(cp.permissionDecision, 'deny')
    assert.match(cp.permissionDecisionReason, /Ask the user/)
    assert.equal(PolicyEngine.enforce(getAdapter('copilot'), 'warn', 'x'), null, 'never stricter than asked')
    assert.equal(PolicyEngine.effective(getAdapter('copilot'), 'ask'), 'deny')
  })

  test('settings', async () => {
    process.env.TK_TEST_MODE = 'WARN'
    process.env.TK_TEST_N = '£1,500'
    assert.equal(PolicyEngine.mode('TK_TEST_MODE', 'block', ['block', 'warn']), 'warn')
    assert.equal(PolicyEngine.threshold('TK_TEST_N', 3), 1500)
    assert.equal(PolicyEngine.threshold('TK_TEST_N', 3, { max: 100 }), 3)
    delete process.env.TK_TEST_MODE
    delete process.env.TK_TEST_N
  })
})

describe('InsightsEngine', () => {
  test('task scope', () => {
    const s = InsightsEngine.taskScope('fix the redirect in `src/auth/login.ts` and `handleCallback`')
    assert.deepEqual(s.paths, ['src/auth/login.ts'])
    assert.ok(s.names.includes('handleCallback'))
    assert.equal(s.wantsDocs, false)
    assert.equal(InsightsEngine.taskScope('clean up the whole codebase').broad, true)
  })

  test('scope rules', () => {
    const s = InsightsEngine.taskScope('fix the redirect in src/auth/login.ts')
    const j = (path: string, o: Partial<InsightsEngine.Change> = {}, touched: string[] = []) =>
      InsightsEngine.judgeChange(s, { path, created: false, oldText: 'a', newText: 'b', ...o }, touched)?.rule ?? null
    assert.equal(j('src/auth/login.ts'), null)
    assert.equal(j('src/auth/session.ts'), null, 'same area')
    assert.equal(j('src/auth/login.test.ts', { created: true }), null, 'the named file\'s own test')
    assert.equal(j('README.md'), 'unrequested_docs')
    assert.equal(j('tests/new_thing.test.ts', { created: true }), 'unrequested_tests')
    assert.equal(j('package.json'), 'dependency_change')
    assert.equal(j('.github/workflows/ci.yml'), 'config_change')
    assert.equal(j('src/auth/login.ts', { oldText: 'a  =  1', newText: 'a = 1' }), 'formatting_only')
    assert.equal(j('src/auth/util.ts', { oldText: 'const fooBar = 1; use(fooBar)', newText: 'const bazQux = 1; use(bazQux)' }), 'unrelated_rename')
    assert.equal(j('lib/payments/stripe.ts'), 'outside_area')
    assert.equal(j('src/auth/x7.ts', {}, ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `src/auth/${x}.ts`)), 'file_count')
    const docs = InsightsEngine.taskScope('update the README')
    assert.equal(InsightsEngine.judgeChange(docs, { path: 'README.md', created: false, oldText: '', newText: '' }, []), null)
  })

  test('scope review of a session: later requests widen the scope', () => {
    const t = new Tx().ask('fix the redirect in src/auth/login.ts').call(...edit('/proj/src/auth/login.ts'))
      .call(...edit('/proj/README.md')).ask('now update the docs').call(...edit('/proj/docs/auth.md')).trace()
    const r = InsightsEngine.scopeReview(t)
    assert.deepEqual(r.findings.map((f) => f.rule), ['unrequested_docs'])
    assert.ok(r.out_of_scope_usd > 0)
  })

  test('dead work: whole failed sessions, and debugging churn inside a success', () => {
    const failed = new Tx().ask('fix').call(...edit('/proj/a.ts')).call('Bash', { command: 'npm test' }, '1 test failed', { error: true }).trace()
    const d = InsightsEngine.deadWork(failed, OutcomeEngine.judge(failed))
    assert.equal(d.items[0].kind, 'failed')
    assert.ok(Math.abs(d.dead_usd - trace.costUsd(failed)) < 1e-6)
    const churn = new Tx().ask('fix').call(...edit('/proj/a.ts'))
    for (let i = 0; i < 4; i++) churn.call('Bash', { command: 'npm test' }, '1 test failed', { error: true }).call(...edit('/proj/a.ts', `x${i}`, `y${i}`))
    churn.call('Bash', { command: 'npm test' }, '# pass 2\n# fail 0')
    const t = churn.trace()
    const c = InsightsEngine.deadWork(t, OutcomeEngine.judge(t))
    assert.equal(c.status, 'succeeded')
    assert.equal(c.items[0].kind, 'debug_churn')
    assert.ok(c.dead_usd > 0 && c.dead_usd < trace.costUsd(t))
  })

  test('arbitrage: same model on a cheaper cloud wins; weaker tiers and unknown quality are left out', () => {
    const list = CostEngine.offerings({ offerings: [{ id: 'vertex/sonnet-5.5', price_multiplier: 0.7 }] })
    const w = CostEngine.workload({ cacheWrite: 1e6, cacheRead: 1e7, output: 1e6 })
    const r = InsightsEngine.arbitrage(w, SONNET, list, { [SONNET]: { sessions: 10, success_rate: 0.8, latency_s: 4, availability: 1 } }, { minQuality: 50 })
    assert.equal(r.current!.id, 'anthropic/sonnet-5.5')
    assert.equal(r.best!.id, 'vertex/sonnet-5.5')
    assert.ok(r.best!.saving_usd > 0)
    assert.equal(r.candidates.find((c) => c.id === 'anthropic/haiku-5.5')!.eligible, false)
    assert.equal(r.candidates.find((c) => c.id === 'openai/gpt')!.why_not, 'no quality evidence')
  })

  test('attribution splits a session by weight', () => {
    const g = InsightsEngine.attribute([{ c: 10, parts: { main: { cost_usd: 3 }, Explore: { cost_usd: 1 } } }],
      (r) => InsightsEngine.weights(r.parts, 'main'), (r) => r.c)
    assert.deepEqual(g.map((x) => [x.key, x.cost_usd]), [['main', 7.5], ['Explore', 2.5]])
  })
})

/** Ledger rows from transcripts, through the real value pipeline. */
function seed(t: TempEnv): void {
  const dir = t.mkdir('tx')
  const sessions = [fixed('ok1'), fixed('ok2'), fixed('ok3'),
    new Tx('bad1').ask('add an export button').call(...edit('/proj/src/ui.ts')).call('Bash', { command: 'npm test' }, '3 tests failed', { error: true }),
    new Tx('gone1').ask('add caching to src/cache.ts').call(...edit('/proj/src/cache.ts')).call('Bash', { command: 'git reset --hard' }),
    new Tx('qa1').ask('what does the auth module do?').agent('Explore', 3)]
  for (const s of sessions) value.recordTranscript(t.db, s.write(dir))
}

describe('the value pipeline writes the enriched ledger', () => {
  test('attribution columns and status', (c) => {
    const t = useTemp(c)
    seed(t)
    const rows = withDb(t.db, (db) => ledger.rows(db, null))
    const by = Object.fromEntries(rows.map((r) => [r.session_id, r]))
    assert.equal(by.ok1.status, 'succeeded')
    assert.equal(by.ok1.category, 'bug_fix')
    assert.equal(by.ok1.provider, 'anthropic')
    assert.deepEqual(by.ok1.commits, ['1a2b3c4'])
    assert.equal(by.bad1.status, 'failed')
    assert.ok(by.bad1.dead_usd! > 0)
    assert.equal(by.gone1.status, 'discarded')
    assert.equal(by.qa1.status, 'no_change')
    assert.ok(by.qa1.agents!.Explore.cost_usd > 0)
    assert.ok(by.ok1.usage!.cache_read > 0)
  })

  test('older ledgers gain the new columns', (c) => {
    const t = useTemp(c)
    withDb(t.db, (db) => db.exec(`CREATE TABLE ledger(session_id TEXT PRIMARY KEY, ts TEXT, day TEXT, cwd TEXT, model TEXT, label TEXT, cost_usd REAL,
      turns INTEGER, tool_calls INTEGER, peak_ctx INTEGER, avg_ctx INTEGER, input_tokens INTEGER, output_tokens INTEGER, prompts INTEGER,
      tools TEXT, outcomes TEXT, primary_outcome TEXT)`))
    seed(t)
    assert.ok(t.rows('SELECT status FROM ledger').every((r) => r.status))
  })
})

describe('splitthebill', () => {
  test('splits by every dimension, and exports CSV', (c) => {
    const t = useTemp(c)
    seed(t)
    const r = splitthebill.build(['--days', '0'], [t.db])
    assert.equal(r.sessions, 6)
    assert.deepEqual(r.dimensions.agent.map((g: any) => g.key).sort(), ['Explore', 'main'])
    const status = Object.fromEntries(r.dimensions.status.map((g: any) => [g.key, g.sessions]))
    assert.deepEqual(status, { succeeded: 3, failed: 1, discarded: 1, no_change: 1 })
    assert.equal(r.dimensions.provider[0].key, 'anthropic')
    assert.ok(r.dimensions.category.some((g: any) => g.key === 'bug_fix' && g.sessions === 3))
    assert.ok(r.dead_usd > 0)
    assert.match(splitthebill.markdown(r), /By agent and subagent/)
    const p = runScript('splitthebill.ts', ['--csv', '--days', '0', '--currency', 'USD'], { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    const lines = p.stdout.trim().split('\n')
    assert.match(lines[0], /^day,session_id,platform,project,developer,.*cost_usd/)
    assert.equal(lines.length, 7)
  })

  test('two people\'s databases make one team view, and Copilot is counted but not priced', (c) => {
    const a = useTemp(c)
    const b = useTemp(c)
    seed(a)
    for (const [mode, payload] of [['prompt', { sessionId: 'cp1', cwd: '/w', prompt: 'add a flag' }],
      ['tool', { sessionId: 'cp1', cwd: '/w', toolName: 'edit', toolArgs: { path: '/w/a.py' }, toolResult: { resultType: 'success' } }],
      ['tool', { sessionId: 'cp1', cwd: '/w', toolName: 'bash', toolArgs: { command: 'git commit -am x' }, toolResult: { resultType: 'success' } }]] as const) {
      b.hook(mode, 'copilot', payload, { TOKENOMICS_DEVELOPER: 'bob' })
    }
    const r = splitthebill.build(['--days', '0'], [a.db, b.db])
    assert.equal(r.sessions, 6)
    assert.equal(r.copilot.sessions, 1)
    assert.equal(r.copilot.by_developer[0].key, 'bob')
    assert.equal(r.copilot.by_status.succeeded, 1)
  })
})

describe('deadwood', () => {
  test('the monthly report counts only dead work, and marks override', (c) => {
    const t = useTemp(c)
    seed(t)
    const r = deadwood.build(['--days', '0'], t.db)
    const kinds = r.by_kind.map((k: any) => k.kind).sort()
    assert.deepEqual(kinds, ['discarded', 'failed'])
    assert.ok(r.dead_share > 0 && r.dead_share < 1)
    assert.equal(r.by_status.no_change.sessions, 1, 'research is not waste')
    assert.match(deadwood.markdown(r), /bought nothing/)
    const p = runScript('deadwood.ts', ['mark', 'accepted', '--session', 'bad1'], { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    const after = deadwood.build(['--days', '0'], t.db)
    assert.deepEqual(after.by_kind.map((k: any) => k.kind), ['discarded'])
    assert.equal(after.by_status.succeeded.sessions, 4)
  })

  test('marks never count as outcomes', (c) => {
    const t = useTemp(c)
    seed(t)
    const db = store.connect(t.db)
    try {
      ledger.mark(db, 'ok1', 'discarded', null)
    } finally {
      db.close()
    }
    const row = withDb(t.db, (d) => ledger.rows(d, null)).find((r) => r.session_id === 'ok1')!
    assert.equal(row.status, 'discarded')
    assert.equal(row.outcomes.discarded, undefined)
  })

  test('this month by default', (c) => {
    const t = useTemp(c)
    const r = deadwood.build([], t.db)
    assert.equal(r.period, today().slice(0, 7))
  })
})

describe('bazaar', () => {
  test('prices your own workload across the market', (c) => {
    const t = useTemp(c)
    seed(t)
    const list = CostEngine.offerings({ offerings: [{ id: 'bedrock/sonnet-5.5', price_multiplier: 0.5 }] })
    const r = bazaar.build(['--days', '0'], t.db, list)
    const m = r.models.find((x: any) => x.model === SONNET)
    assert.equal(m.sessions, 6)
    assert.equal(m.observed.success_rate, 0.6, '3 of 5 judged sessions succeeded')
    assert.equal(m.best.id, 'bedrock/sonnet-5.5')
    assert.ok(r.potential_saving_usd > 0)
    assert.match(bazaar.markdown(r), /Best value: bedrock\/sonnet-5.5/)
  })

  test('a one-task quote across providers', () => {
    const q = bazaar.quote(['--input', '50000', '--output', '5000', '--model', 'opus'])
    assert.equal(q.reference, 'anthropic/opus-5.5')
    assert.ok(q.candidates.length >= 10)
  })
})

describe('crystalball', () => {
  test('the brief\'s scenario, a routed mix and growth', () => {
    const r = crystalball.simulate(['--devs', '10', '--tasks', '20', '--input', '50k', '--output', '5000', '--cache', '0',
      '--mix', 'haiku=60,sonnet=40', '--growth', '10', '--months', '3'], CostEngine.offerings(), '/nonexistent.db')
    assert.equal(r.tasks_per_month, 4200)
    const sonnet = r.offerings.find((o: any) => o.id === 'anthropic/sonnet-5.5')
    assert.equal(sonnet.month_usd, 630)
    assert.equal(r.reference, 'anthropic/sonnet-5.5')
    assert.ok(r.mix.month_usd < 630)
    assert.deepEqual(r.growth.months, [630, 693, 762.3])
    assert.match(crystalball.markdown(r), /4,200 tasks a month/)
  })

  test('from history', (c) => {
    const t = useTemp(c)
    seed(t)
    const h = crystalball.fromHistory(t.db, 30)
    assert.equal(h.sessions, 6)
    assert.ok(h.inputPerTask! > 0 && h.cacheHit! > 0.5)
  })
})

describe('blinkers', () => {
  const claude = (t: TempEnv, payload: object, env = {}) => runScript('blinkers.ts', ['guard', 'claude-code'], { input: JSON.stringify(payload), env: t.env(env) })

  test('the hook asks before expanding the scope, once per file', (c) => {
    const t = useTemp(c)
    const cwd = t.mkdir('repo')
    const prompt = runScript('blinkers.ts', ['prompt', 'claude-code'], { input: JSON.stringify({ session_id: 'b1', cwd, prompt: 'fix the redirect in src/auth/login.ts' }), env: t.env() })
    assert.equal(prompt.stdout, '')
    const ok = claude(t, { session_id: 'b1', cwd, tool_name: 'Edit', tool_input: { file_path: join(cwd, 'src/auth/login.ts'), old_string: 'a', new_string: 'b' } })
    assert.equal(ok.stdout, '')
    const docs = claude(t, { session_id: 'b1', cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, 'README.md'), content: '# hi' } })
    const out = JSON.parse(docs.stdout)
    assert.equal(out.hookSpecificOutput.permissionDecision, 'ask')
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /documentation/)
    const again = claude(t, { session_id: 'b1', cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, 'README.md'), content: '# hi' } })
    assert.equal(again.stdout, '', 'asked once already')
    assert.deepEqual(t.rows('SELECT rule, action FROM blinkers_events').map((r) => [r.rule, r.action]),
      [['unrequested_docs', 'asked'], ['unrequested_docs', 'allowed']])
  })

  test('Copilot: refused with an instruction to ask; warn and off modes; no task, no opinion', (c) => {
    const t = useTemp(c)
    const run = (mode: string, payload: object, env = {}) => runScript('blinkers.ts', [mode, 'copilot'], { input: JSON.stringify(payload), env: t.env(env) })
    run('prompt', { sessionId: 'c1', cwd: '/w', prompt: 'fix src/a.py' })
    const out = JSON.parse(run('guard', { sessionId: 'c1', cwd: '/w', toolName: 'edit', toolArgs: { path: '/w/package.json' } }).stdout)
    assert.equal(out.permissionDecision, 'deny')
    assert.match(out.permissionDecisionReason, /dependencies/)
    assert.equal(run('guard', { sessionId: 'c1', cwd: '/w', toolName: 'edit', toolArgs: { path: '/w/Dockerfile' } }, { TOKENOMICS_BLINKERS: 'warn' }).stdout, '',
      'Copilot cannot show a notice, so warn prints nothing')
    assert.equal(run('guard', { sessionId: 'c1', cwd: '/w', toolName: 'edit', toolArgs: { path: '/w/docs/x.md' } }, { TOKENOMICS_BLINKERS: 'off' }).stdout, '')
    assert.equal(run('guard', { sessionId: 'unknown', cwd: '/w', toolName: 'edit', toolArgs: { path: '/w/README.md' } }).stdout, '')
    run('prompt', { sessionId: 'c1', prompt: 'blinkers off' })
    assert.equal(run('guard', { sessionId: 'c1', cwd: '/w', toolName: 'edit', toolArgs: { path: '/w/README.md' } }).stdout, '')
  })

  test('bad input never blocks', (c) => {
    const t = useTemp(c)
    for (const input of ['', 'not json', '{}', '[1]']) {
      for (const mode of ['prompt', 'guard']) {
        const p = runScript('blinkers.ts', [mode, 'claude-code'], { input, env: t.env() })
        assert.equal(p.status, 0)
        assert.equal(p.stdout, '')
        assert.equal(p.stderr, '')
      }
    }
  })

  test('check a session, and diff a branch against a task', (c) => {
    const t = useTemp(c)
    const path = new Tx('rev').ask('fix the redirect in src/auth/login.ts').call(...edit('/proj/src/auth/login.ts'))
      .call(...edit('/proj/.github/workflows/ci.yml')).write(t.home)
    const r = blinkers.check(['--transcript', path])!
    assert.deepEqual(r.findings.map((f: any) => f.rule), ['config_change'])
    const repo = t.mkdir('g')
    const git = (...a: string[]) => spawnSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { encoding: 'utf8' })
    git('init', '-q', '-b', 'main')
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src', 'login.ts'), 'a')
    git('add', '.')
    git('commit', '-qm', 'init')
    writeFileSync(join(repo, 'src', 'login.ts'), 'b')
    writeFileSync(join(repo, 'CHANGELOG.md'), 'x')
    const d = blinkers.diff(['--task', 'fix src/login.ts'], repo)
    assert.deepEqual(d.findings.map((f: any) => [f.rule, f.path]), [['unrequested_docs', 'CHANGELOG.md']])
  })
})

describe('wiring', () => {
  test('hooks, CLI and the quality gate', () => {
    const cc = readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')
    const cp = readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8')
    for (const s of [cc, cp]) {
      assert.match(s, /blinkers\.ts prompt/)
      assert.match(s, /blinkers\.ts guard/)
    }
    const cli = readFileSync(join(ROOT, 'scripts', 'cli.ts'), 'utf8')
    for (const name of ['splitthebill', 'bazaar', 'blinkers', 'crystalball', 'deadwood', "'value-meter'", "'agent-forensics'", "'quality-gate'"]) {
      assert.ok(cli.includes(`${name}: [`), name)
    }
    for (const name of ['splitthebill', 'bazaar', 'blinkers', 'crystalball', 'deadwood']) {
      const skill = readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8')
      assert.match(skill, new RegExp(`^---\\nname: ${name}\\ndescription: `))
    }
    assert.ok(GATE_FAILS.has('false-economy') && !GATE_FAILS.has('safe-saving'))
  })

  test('the CLI runs each new tool', (c) => {
    const t = useTemp(c)
    for (const args of [['crystalball', '--devs', '2'], ['bazaar', 'list'], ['splitthebill'], ['deadwood'], ['spend-simulator', '--json']]) {
      const p = runScript('cli.ts', args, { env: t.env() })
      assert.equal(p.status, 0, `${args.join(' ')}: ${p.stderr}`)
      assert.ok(p.stdout.length > 20, args.join(' '))
    }
  })
})
