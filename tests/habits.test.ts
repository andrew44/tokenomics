/** coldsnap (prompt-cache misses), parrot (what you keep repeating) and allyoucaneat (plan fit). */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { runScript, useTemp, withEnv } from './helpers.ts'

import * as allyoucaneat from '../scripts/allyoucaneat.ts'
import * as coldsnap from '../scripts/coldsnap.ts'
import * as parrot from '../scripts/parrot.ts'
import { analyse } from '../tokenomics/engine/coldcache.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { corrections, normalise, phrases, repeats, sentences } from '../tokenomics/engine/parrot.ts'
import { ratesFor } from '../tokenomics/engine/pricing.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'

const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

/** Transcript records: prompts and requests with explicit cache writes, reads, models and times. */
class Tx {
  recs: object[] = []
  n = 0
  sid: string
  cwd: string
  start: number
  constructor(sid = 's1', cwd = '/proj', start = Date.UTC(2026, 10, 20, 9, 0, 0)) {
    this.sid = sid
    this.cwd = cwd
    this.start = start
  }

  at(sec: number): string {
    return new Date(this.start + sec * 1000).toISOString()
  }

  ask(sec: number, text: string): this {
    this.recs.push({ type: 'user', sessionId: this.sid, cwd: this.cwd, timestamp: this.at(sec), message: { role: 'user', content: text } })
    return this
  }

  req(sec: number, write: number, read: number, model = SONNET, oneHour = false): this {
    this.recs.push({ type: 'assistant', sessionId: this.sid, cwd: this.cwd, timestamp: this.at(sec), message: { id: `m${++this.n}`, model,
      content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 20, cache_creation_input_tokens: write,
        cache_read_input_tokens: read, cache_creation: oneHour ? { ephemeral_1h_input_tokens: write } : {} } } })
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

describe('coldsnap: why the cache went cold', () => {
  test('names each rebuild: break, model switch, compaction, prefix change; the first write is not one', () => {
    const t = new Tx().ask(0, 'start').req(1, 50_000, 0)        // first request: a write, not a rebuild
      .req(30, 1_000, 50_000)                                    // warm
      .req(30 + 600, 51_000, 0)                                  // 10-minute break on the 5-minute cache
      .req(640, 52_000, 0, OPUS)                                 // model switch
      .req(650, 20_000, 0, OPUS)                                 // compacted: 52k -> 20k
      .req(660, 21_000, 0, OPUS)                                 // nothing else changed: prefix change
      .trace()
    const c = analyse(t)
    assert.deepEqual(c.rebuilds.map((r) => r.cause), ['idle', 'model_switch', 'compaction', 'prefix_change'])
    assert.equal(c.rebuilds[1].from_model, SONNET)
    assert.equal(c.rebuilds.find((r) => r.cause === 'compaction')!.avoidable, false)
    assert.ok(c.avoidable_usd < c.rebuild_usd)
    const r = ratesFor(SONNET)
    assert.ok(Math.abs(c.rebuilds[0].usd - 51_000 * (r.cache_write_5m - r.cache_read) / 1e6) < 1e-6)
    assert.ok(c.ttl_1h && c.ttl_1h.saved_usd > 0)
  })

  test('the 1-hour cache: a 10-minute break is warm, and no what-if is offered', () => {
    const t = new Tx().ask(0, 'start').req(1, 50_000, 0, SONNET, true).req(600, 1_000, 50_000, SONNET, true)
      .req(600 + 4000, 51_000, 0, SONNET, true).trace()
    const c = analyse(t)
    assert.deepEqual(c.rebuilds.map((r) => r.cause), ['idle'])            // only the 66-minute break
    assert.equal(c.ttl_1h, null)
    const r = ratesFor(SONNET)
    assert.ok(Math.abs(c.rebuilds[0].usd - 51_000 * (r.cache_write_1h - r.cache_read) / 1e6) < 1e-6)
  })

  test('report, period and CLI', (ctx) => {
    const e = useTemp(ctx)
    const tx = new Tx().ask(0, 'start').req(1, 50_000, 0).req(900, 51_000, 0)
    const r = coldsnap.forTrace(tx.trace())
    assert.equal(r.rebuild_count, 1)
    assert.match(coldsnap.markdown(r), /rebuilt 1 time/)
    assert.ok(r.tips.some((x: string) => /doggybag/.test(x)))
    const proj = join(e.home, 'projects', '-proj')
    mkdirSync(proj, { recursive: true })
    tx.write(proj)
    new Tx('s2').ask(0, 'hi').req(1, 30_000, 0).req(20, 500, 30_000).write(proj)
    const p = coldsnap.forPeriod(0, join(e.home, 'projects'))
    assert.equal(p.sessions, 2)
    assert.equal(p.worst_sessions.length, 1)
    const out = runScript('coldsnap.ts', ['--transcript', join(proj, 's1.jsonl'), '--json'], { env: e.env() })
    assert.equal(out.status, 0)
    assert.equal(JSON.parse(out.stdout).by_cause[0].cause, 'idle')
    assert.match(coldsnap.markdown(coldsnap.forTrace(new Tx('s3').ask(0, 'x').req(1, 20_000, 0).req(5, 100, 20_000).trace())), /never went cold/)
  })
})

describe('parrot: what you keep telling the AI', () => {
  test('phrases: rules, a leading correction and the whole prompt; slash commands are skipped', () => {
    assert.equal(normalise('Please, ALWAYS use `pnpm`!'), 'always use pnpm')
    assert.deepEqual(sentences('- one thing.\n- Two things. Three'), ['one thing.', 'Two things.', 'Three'])
    const ph = phrases('No, that’s wrong again. Always use pnpm instead of npm. Fix the build please and run the tests')
    assert.deepEqual(ph.map((p) => p.kind), ['correction', 'rule', 'prompt'])
    assert.deepEqual(phrases('/compact keep the notes'), [])
    assert.deepEqual(phrases('fix it'), [])
    assert.equal(phrases('Always use pnpm.')[0].key, phrases('always use PNPM')[0].key)
  })

  test('repeats: across sessions only, with the fix; already-written rules are noticed', () => {
    const traces = ['a', 'b', 'c'].map((sid, i) => new Tx(sid, i < 2 ? '/proj' : '/other').ask(0, 'Always use pnpm, never npm. Then fix the failing auth tests')
      .req(1, 10_000, 0).ask(10, 'always use pnpm, never npm').trace())
    const r = repeats(traces, 3, () => '')
    const rule = r.find((x) => x.kind === 'rule')!
    assert.equal(rule.sessions, 3)
    assert.equal(rule.times, 6)
    assert.match(rule.suggestion, /^Add one line to CLAUDE\.md: "- Always use pnpm, never npm\."/)
    assert.equal(repeats(traces.slice(0, 2), 3, () => '').length, 0)
    const known = repeats(traces, 3, (cwd) => (cwd === '/proj' ? 'rules always use pnpm never npm and more' : ''))
    assert.equal(known.find((x) => x.kind === 'rule')!.in_instructions, true)
  })

  test('corrections cost the work before them', () => {
    const t = new Tx().ask(0, 'add a currency column').req(1, 20_000, 0).req(5, 500, 20_000).ask(20, 'no, you forgot the migration').req(21, 500, 20_500).trace()
    const c = corrections(t)
    assert.equal(c.length, 1)
    assert.ok(c[0].usd > 0 && Math.abs(c[0].usd - (t.turns[0].costUsd + t.turns[1].costUsd)) < 1e-6)
  })

  test('the hook counts hashes per project and speaks once, at the third session', (ctx) => {
    const e = useTemp(ctx)
    const send = (sid: string, prompt = 'Always run the linter before you commit anything', env = {}) => runScript('parrot.ts', ['claude-code'],
      { input: JSON.stringify({ session_id: sid, cwd: e.home, prompt }), env: e.env(env) })
    assert.equal(send('s1').stdout, '')
    assert.equal(send('s1').stdout, '')                          // same session again: still one
    assert.equal(send('s2').stdout, '')
    const third = send('s3')
    assert.equal(third.status, 0)
    assert.match(JSON.parse(third.stdout).systemMessage, /^parrot: you've told the AI "Always run the linter before you commit anything" in 3 sessions/)
    assert.equal(send('s4').stdout, '')                          // once
    assert.ok(e.rows('SELECT key FROM parrot_events').every((r) => /^[0-9a-f]{16}$/.test(r.key)))
    assert.equal(e.rows("SELECT * FROM parrot_events WHERE action='nudged'").length, 2)   // the rule and the whole prompt
    assert.equal(send('s5', 'Never edit generated files by hand ok', { TOKENOMICS_PARROT: 'off' }).stdout, '')
    assert.equal(e.rows("SELECT * FROM parrot_events WHERE session_id='s5'").length, 0)
    assert.equal(runScript('parrot.ts', ['claude-code'], { input: 'not json', env: e.env() }).status, 0)
  })

  test('a written-down rule gets a different notice; whole prompts become slash commands', (ctx) => {
    const e = useTemp(ctx)
    writeFileSync(join(e.home, 'CLAUDE.md'), '# Rules\n\n- Always run the linter before you commit anything\n')
    const ph = phrases('Always run the linter before you commit anything')
    assert.match(parrot.message(ph, 3, e.home), /already in your instruction file/)
    const pr = phrases('summarise the open pull requests and list the reviewers for each').filter((p) => p.kind === 'prompt')
    assert.match(parrot.message(pr, 3, e.home), /\.claude\/commands\/summarise-open-pull\.md/)
  })

  test('report over transcripts', async (ctx) => {
    const e = useTemp(ctx)
    const proj = join(e.home, 'projects', '-proj')
    mkdirSync(proj, { recursive: true })
    for (const sid of ['a', 'b', 'c']) new Tx(sid).ask(0, 'Never add comments to the code').req(1, 10_000, 0).ask(5, 'no, that is not what I asked').req(6, 100, 10_000).write(proj)
    const r = await withEnv({}, () => parrot.report(['--days', '0', '--projects', join(e.home, 'projects')]))
    assert.equal(r.sessions, 3)
    assert.ok(r.repeats.some((x: any) => x.kind === 'rule' && x.sessions === 3))
    assert.equal(r.corrections, 3)
    assert.match(parrot.markdown(r), /Never add comments to the code/)
  })
})

describe('allyoucaneat: plan fit', () => {
  function seed(db: string, days: [string, number][]) {
    withDb(db, (d) => {
      store.connect(db).close()
      for (const [day, usd] of days) d.run('INSERT INTO cost_events(session_id,ts,day,usd) VALUES(?,?,?,?)', 'x', `${day}T10:00:00+0000`, day, usd)
    })
  }
  const month = (m: string, perDay: number) => Array.from({ length: 30 }, (_, i) => [`${m}-${String(i + 1).padStart(2, '0')}`, perDay] as [string, number])

  test('peak windows', () => {
    const ev = [{ t: 0, usd: 1 }, { t: 3600, usd: 2 }, { t: 6 * 3600, usd: 4 }]
    assert.equal(allyoucaneat.peakWindow(ev, 5 * 3600), 4)
    assert.equal(allyoucaneat.peakWindow(ev, 7 * 3600), 7)
  })

  test('pay-as-you-go heavy user: subscriptions below their spend are candidates', async (ctx) => {
    const e = useTemp(ctx)
    seed(e.db, [...month('2026-09', 10), ...month('2026-10', 10)])
    const r = await withEnv({ TOKENOMICS_CURRENCY: 'USD' }, () => allyoucaneat.build(['--plan', 'api'], e.db, '2026-11-03'))
    assert.equal(r.typical_usd, 300)
    assert.equal(r.verdict, 'consider_subscription')
    assert.match(r.advice[0], /Claude Pro.*Max 5x.*Max 20x/)
    assert.equal(r.options.find((o: any) => o.id === 'max20').vs_payg_usd, -100)
    assert.equal(r.peak_5h_usd, 10)
    assert.match(allyoucaneat.markdown(r), /A typical month/)
  })

  test('light user on Max: overpaying, with the cheaper plan named', async (ctx) => {
    const e = useTemp(ctx)
    seed(e.db, month('2026-10', 1))                                  // $30 a month
    const r = await withEnv({ TOKENOMICS_CURRENCY: 'USD' }, () => allyoucaneat.build(['--plan', 'max20'], e.db, '2026-11-03'))
    assert.equal(r.verdict, 'overpaying')
    assert.match(r.advice[1], /Max 5x.*\$100/)
    const good = await withEnv({ TOKENOMICS_CURRENCY: 'USD' }, () => allyoucaneat.build(['--plan', 'pro'], e.db, '2026-11-03'))
    assert.equal(good.verdict, 'good_value')
    const light = await withEnv({ TOKENOMICS_CURRENCY: 'USD' }, () => allyoucaneat.build([], e.db, '2026-11-03'))
    assert.equal(light.verdict, 'consider_subscription')             // $30 > Pro's $20
    assert.match(light.advice.at(-1), /--plan/)
  })

  test('partial months project; empty and too early say so; plans can be overridden', async (ctx) => {
    const e = useTemp(ctx)
    assert.equal(allyoucaneat.build([], e.db, '2026-11-03').empty, true)
    seed(e.db, [['2026-11-01', 5], ['2026-11-02', 5]])
    assert.equal(allyoucaneat.build([], e.db, '2026-11-03').too_early, true)
    const r = allyoucaneat.build([], e.db, '2026-11-10')
    assert.equal(r.typical_usd, 30)                                  // $10 in 10 days, 30-day month
    assert.match(r.basis, /projected/)
    const ps = allyoucaneat.plans({ plans: [{ id: 'pro', usd_per_month: 17 }, { id: 'max20', disabled: true }, { id: 'team', name: 'Team', usd_per_month: 30 }] })
    assert.deepEqual(ps.map((p) => [p.id, p.usd_per_month]), [['api', 0], ['pro', 17], ['team', 30], ['max5', 100]])
    const out = runScript('allyoucaneat.ts', ['--plan', 'nope'], { env: e.env() })
    assert.equal(out.status, 0)
    assert.match(out.stdout, /Unknown plan "nope"/)
  })
})
