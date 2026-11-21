/** packlight (fixed overhead), ballast (context carried between tasks) and waffle (output spend). */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { ROOT, runScript, useTemp, withEnv } from './helpers.ts'

import * as ballast from '../scripts/ballast.ts'
import * as waffle from '../scripts/waffle.ts'
import { carry, topicShift, words } from '../tokenomics/engine/ballast.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { analyse } from '../tokenomics/engine/verbosity.ts'

const SONNET = 'claude-sonnet-5-5'

/** A small transcript builder: prompts, tool calls and replies, each with a context size. */
class Tx {
  recs: object[] = []
  n = 0
  sec = 0
  sid: string
  start: number
  constructor(sid = 's1', start = Date.UTC(2026, 10, 20, 9, 0, 0)) {
    this.sid = sid
    this.start = start
  }

  ts(): string {
    return new Date(this.start + this.sec * 1000).toISOString()
  }

  ask(text: string): this {
    this.sec += 1
    this.recs.push({ type: 'user', sessionId: this.sid, cwd: '/proj', timestamp: this.ts(), message: { role: 'user', content: text } })
    return this
  }

  call(name: string, input: object, ctx = 100_000, result = 'ok', out = 200): this {
    const id = `toolu_${++this.n}`
    this.sec += 2
    this.recs.push({ type: 'assistant', sessionId: this.sid, timestamp: this.ts(), message: { id: `msg_${this.n}`, model: SONNET,
      content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx - 10 } } })
    this.sec += 1
    this.recs.push({ type: 'user', timestamp: this.ts(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] } })
    return this
  }

  reply(text: string, ctx = 100_000, out?: number): this {
    this.sec += 2
    this.recs.push({ type: 'assistant', sessionId: this.sid, timestamp: this.ts(), message: { id: `msg_r${++this.n}`, model: SONNET,
      content: [{ type: 'text', text }], usage: { input_tokens: 10, output_tokens: out ?? Math.ceil(text.length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: ctx - 10 } } })
    return this
  }

  trace(): trace.Trace {
    return trace.parseText(this.text())
  }

  text(): string {
    return this.recs.map((r) => JSON.stringify(r) + '\n').join('')
  }

  write(dir: string): string {
    const p = join(dir, `${this.sid}.jsonl`)
    writeFileSync(p, this.text())
    return p
  }
}

const auth = () => new Tx().ask('fix the login redirect bug in the auth middleware').call('Read', { file_path: '/proj/src/auth/middleware.ts' })
  .call('Edit', { file_path: '/proj/src/auth/middleware.ts', old_string: 'a', new_string: 'b' }).reply('Fixed the redirect.')

describe('ballast: topic shifts', () => {
  test('words drop stop words and plurals', () => {
    assert.deepEqual([...words('Please fix the failing tests in the billing exports')], ['failing', 'test', 'billing', 'export'])
  })

  test('a follow-up is not a shift; a different task is; a cue always is', () => {
    const t = auth().trace()
    assert.equal(topicShift('the auth redirect still loops after login', t).shift, false)
    assert.equal(topicShift('write a postgres migration adding invoice currency columns', t).shift, true)
    assert.equal(topicShift('unrelated: what time zone do servers use', t).cue, true)
    assert.equal(topicShift('ok thanks', t).shift, false)                       // too few words to judge
  })

  test('check: carry cost from the switch until the context is compacted', () => {
    const t = auth().ask('write a postgres migration adding invoice currency columns')
      .call('Write', { file_path: '/proj/db/0042_invoice_currency.sql', content: 'x' }, 105_000)
      .call('Bash', { command: 'npm run migrate' }, 110_000).reply('Done.', 20_000).trace()
    const c = carry(t, 60_000)
    assert.equal(c.length, 1)
    assert.equal(c[0].ctx, 100_000)
    assert.equal(c[0].steps, 2)                                                 // the 20k reply came after a compaction
    assert.ok(c[0].usd > 0)
    const r = ballast.check(t)
    assert.equal(r.task_switches.length, 1)
    assert.match(ballast.markdown(r), /went on re-reading earlier tasks/)
  })
})

describe('ballast: the hook', () => {
  const now = Date.UTC(2026, 10, 20, 9, 1, 0) / 1000

  test('decide: threshold, slash commands, cold cache, once per band', async () => {
    const t = auth().trace()
    const other = 'write a postgres migration adding invoice currency columns'
    await withEnv({ TOKENOMICS_BALLAST_MIN_TOKENS: '60000' }, () => {
      assert.equal(ballast.decide('/compact keep the auth notes', t, [], now), null)
      assert.equal(ballast.decide(other, t, [], now + 3600), null)              // cache cold: doggybag's job
      const d = ballast.decide(other, t, [], now)!
      assert.equal(d.rule, 'new_task')
      assert.match(d.message, /new task.*100,000 tokens/)
      const h = ballast.decide('the auth redirect still loops after login', t, [], now)!
      assert.equal(h.rule, 'heavy')
      assert.equal(ballast.decide('the auth redirect still loops after login', t, [{ rule: 'heavy', band: 1 }], now), null)
    })
    await withEnv({ TOKENOMICS_BALLAST_MIN_TOKENS: '200000' }, () => assert.equal(ballast.decide(other, t, [], now), null))
  })

  test('warns once through the hook, logs it, and block pauses the prompt', (c) => {
    const t = useTemp(c)
    const tx = new Tx('s1', Date.now() - 60_000)
    tx.ask('fix the login redirect bug in the auth middleware').call('Read', { file_path: '/proj/src/auth/middleware.ts' }).reply('Fixed.')
    const path = tx.write(t.home)
    const payload = JSON.stringify({ session_id: 's1', transcript_path: path, prompt: 'write a postgres migration adding invoice currency columns' })
    const first = runScript('ballast.ts', ['claude-code'], { input: payload, env: t.env() })
    assert.equal(first.status, 0)
    assert.match(JSON.parse(first.stdout).systemMessage, /^ballast: this looks like a new task/)
    assert.equal(runScript('ballast.ts', ['claude-code'], { input: payload, env: t.env() }).stdout, '')
    assert.deepEqual(t.rows('SELECT rule, action FROM ballast_events').map((r) => [r.rule, r.action]), [['new_task', 'warn']])
    const blocked = runScript('ballast.ts', ['claude-code'], { input: payload.replace('"s1"', '"s2"'), env: t.env({ TOKENOMICS_BALLAST: 'block' }) })
    assert.equal(JSON.parse(blocked.stdout).decision, 'block')
    assert.equal(runScript('ballast.ts', ['claude-code'], { input: payload, env: t.env({ TOKENOMICS_BALLAST: 'off' }) }).stdout, '')
    assert.equal(runScript('ballast.ts', ['claude-code'], { input: 'not json', env: t.env() }).status, 0)
  })
})

describe('waffle: output spend', () => {
  test('splits output and finds long replies, recaps and whole-file rewrites', () => {
    const big = 'x'.repeat(8000)
    const t = new Tx().ask('refactor the parser')
      .call('Read', { file_path: '/proj/src/parser.ts' })
      .call('Write', { file_path: '/proj/src/parser.ts', content: big }, 100_000, 'The file /proj/src/parser.ts has been updated.', 2100)
      .reply('word '.repeat(1000), 100_000)
      .ask('and the lexer?').reply('## Summary\n' + 'I changed the lexer. '.repeat(40), 100_000)
      .reply('Short.', 100_000, 3000)                                           // mostly thinking
      .trace()
    const v = analyse(t, 500)
    assert.deepEqual(v.findings.map((f) => f.kind).sort(), ['full_rewrite', 'long_reply', 'recap'])
    assert.equal(v.findings.find((f) => f.kind === 'full_rewrite')!.tokens, 2000)
    assert.equal(v.findings.find((f) => f.kind === 'long_reply')!.tokens, 750)
    assert.ok(v.split.thinking >= 2990)
    assert.ok(v.avoidable_usd > 0 && v.output_share > 0)
    const r = waffle.forTrace(t)
    assert.ok(r.tips.some((x: string) => x.includes('Edit over Write')))
    assert.ok(r.tips.some((x: string) => x.includes('CLAUDE.md')))
    assert.match(waffle.markdown(r), /was avoidable/)
  })

  test('a new file written once is not a rewrite; short replies are fine', () => {
    const v = analyse(new Tx().ask('add a parser').call('Write', { file_path: '/proj/new.ts', content: 'y'.repeat(5000) }, 100_000, 'File created successfully')
      .reply('Added it.').trace())
    assert.deepEqual(v.findings, [])
  })

  test('--days reads every recent session', (c) => {
    const t = useTemp(c)
    const dir = t.mkdir('projects', '-proj')
    auth().write(dir)
    new Tx('s2').ask('explain').reply('word '.repeat(1200)).write(dir)
    const p = runScript('waffle.ts', ['--days', '7', '--projects', join(t.home, 'projects'), '--json'], { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    const r = JSON.parse(p.stdout)
    assert.equal(r.sessions, 2)
    assert.equal(r.worst_sessions[0].session_id, 's2')
  })
})

describe('packlight: fixed overhead', () => {
  test('inventory, usage, unused servers and skills, and the saving', (c) => {
    const t = useTemp(c)
    const proj = t.mkdir('work', 'app')
    writeFileSync(join(t.home, '.claude.json'), JSON.stringify({ mcpServers: { github: {}, jira: {} }, projects: { [proj]: { mcpServers: { local: {} } } } }))
    writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { postgres: {} } }))
    const skill = (dir: string, name: string, desc: string) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\nbody`)
    }
    skill(t.mkdir('.claude', 'skills', 'deploy'), 'deploy', 'Deploys the app. '.repeat(10))
    skill(t.mkdir('.claude', 'skills', 'unused'), 'unused', 'Never used. '.repeat(20))
    skill(t.mkdir('.claude', 'plugins', 'cache', 'mkt', 'kit', '1.0.0', 'skills', 'lint'), 'lint', 'Lints.')
    skill(t.mkdir('.claude', 'plugins', 'cache', 'mkt', 'off', '1.0.0', 'skills', 'gone'), 'gone', 'Disabled plugin.')
    mkdirSync(join(t.home, '.claude'), { recursive: true })
    writeFileSync(join(t.home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'kit@mkt': true, 'off@mkt': false } }))
    const dir = t.mkdir('.claude', 'projects', '-work-app')
    const tx = new Tx('p1', Date.now() - 3600_000).ask('ship it')
    tx.call('mcp__github__create_pull_request', { title: 'x' }, 40_000).call('Skill', { skill: 'deploy' }, 41_000).call('Skill', { skill: 'kit:lint' }, 42_000)
    tx.write(dir)
    const p = runScript('packlight.ts', ['--json', '--dir', proj], { env: t.env() })
    assert.equal(p.status, 0, p.stderr)
    const r = JSON.parse(p.stdout)
    assert.equal(r.sessions, 1)
    assert.equal(r.baseline.median, 40_000 - 2)                                 // first request less the prompt
    assert.deepEqual(r.mcp.map((m: any) => [m.name, m.uses]).sort(), [['github', 1], ['jira', 0], ['local', 0], ['postgres', 0]])
    assert.deepEqual(r.unused.mcp.map((m: any) => m.name).sort(), ['jira', 'local', 'postgres'])
    assert.deepEqual(r.skills.map((s: any) => s.name).sort(), ['deploy', 'lint', 'unused'])
    assert.deepEqual(r.unused.skills.map((s: any) => s.name), ['unused'])
    assert.ok(r.savings.tokens_per_request > 50 && r.savings.per_month_usd > 0)
    assert.ok(r.overhead_usd > 0 && r.overhead_share > 0)
    const md = runScript('packlight.ts', ['--dir', proj], { env: t.env() }).stdout
    assert.match(md, /Every session starts with about 39,998 tokens/)
    assert.match(md, /claude mcp remove/)
  })

  test('no sessions: nothing is called unused', (c) => {
    const t = useTemp(c)
    writeFileSync(join(t.home, '.claude.json'), JSON.stringify({ mcpServers: { github: {} } }))
    const r = JSON.parse(runScript('packlight.ts', ['--json'], { env: t.env() }).stdout)
    assert.equal(r.sessions, 0)
    assert.deepEqual(r.unused.mcp, [])
  })
})

describe('wiring: packlight, ballast, waffle', () => {
  test('hook, CLI and skills', (c) => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks
    assert.ok(hooks.UserPromptSubmit.some((g: any) => g.hooks.some((h: any) => h.command.endsWith('ballast.ts claude-code'))))
    const cli = readFileSync(join(ROOT, 'scripts', 'cli.ts'), 'utf8')
    for (const name of ['packlight', 'ballast', 'waffle']) {
      assert.ok(cli.includes(`${name}: [`), name)
      assert.match(readFileSync(join(ROOT, 'skills', name, 'SKILL.md'), 'utf8'), new RegExp(`^---\\nname: ${name}\\ndescription: `))
    }
    const t = useTemp(c)
    for (const args of [['packlight'], ['waffle', '--days', '1']]) {
      const p = runScript('cli.ts', args, { env: t.env() })
      assert.equal(p.status, 0, `${args.join(' ')}: ${p.stderr}`)
    }
  })
})
