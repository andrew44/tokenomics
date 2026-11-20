/** The standalone scripts: coach, dashboard, doggybag, statusline, pennywise, the CLI and launchers. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'

import { assistant, ROOT, runScript, SCRIPTS, USAGE, useTemp, user, withEnv, writeTranscript, type Env, type TempEnv } from './helpers.ts'

import * as dashboard from '../scripts/dashboard.ts'
import * as doggybag from '../scripts/doggybag.ts'
import * as pennywise from '../scripts/pennywise.ts'
import * as statusline from '../scripts/statusline.ts'
import * as store from '../tokenomics/engine/store.ts'

const POSIX = process.platform !== 'win32'

describe('modules', () => {
  test('every module loads on its own (no import cycles)', () => {
    const dir = join(ROOT, 'tokenomics')
    const mods = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'))
    assert.ok(mods.length > 10)
    for (const m of mods) {
      const url = pathToFileURL(join(dir, m)).href
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], { encoding: 'utf8', timeout: 30_000 })
      assert.equal(r.status, 0, `${m}: ${r.stderr}`)
      assert.equal(r.stderr, '', `${m} printed a warning`)
    }
  })

  test('no Python is left', () => {
    const skip = new Set(['node_modules', '.git'])
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      skip.has(e.name) ? [] : e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])
    assert.deepEqual(walk(ROOT).filter((f) => f.endsWith('.py')).map((f) => relative(ROOT, f)), [])
  })
})

describe('coach', () => {
  test('runs and scores topics', (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 'cf', [
      user('write a python function and add unit tests for the api'), assistant('m1'),
      user('implement a new endpoint class in the service and refactor the code'), assistant('m2'),
      user('why is p99 latency up in grafana? check the loki logs'), assistant('m3'),
      user('check the grafana dashboard metrics and alerts'), assistant('m4'),
    ])
    const r = runScript('coach.ts', ['--transcript', path, '--json'], { env: t.env() })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.equal(out.prompts, 4)
    assert.deepEqual(out.prompt_stats.leaning, { capex: 2, opex: 2 })
    assert.ok(out.flags.includes('mixed_topics_in_one_session'))
  })
})

describe('dashboard', () => {
  test('demo seed and build', (c) => {
    const t = useTemp(c)
    dashboard.seedDemo(t.db)
    const data = dashboard.build(t.db, 30)
    assert.equal(data.empty, false)
    assert.equal(data.daily.length, 30)
    assert.ok(Object.values(data.totals).reduce((a: number, v: any) => a + v.sessions, 0) > 0)
  })

  test('all time with undated rows only', (c) => {
    const t = useTemp(c)
    const db = store.connect(t.db)
    db.run("INSERT INTO sessions(session_id, label) VALUES('x', 'opex')")
    db.close()
    const data = dashboard.build(t.db, 0)
    assert.equal(data.totals.opex.sessions, 1)
    assert.deepEqual(data.daily, [])
  })

  test('a missing db', (c) => {
    const t = useTemp(c)
    assert.equal(dashboard.build(join(t.home, 'nope.db'), 30).reason, 'no-database')
  })

  test('serves the page and the data', async (c) => {
    const t = useTemp(c)
    dashboard.seedDemo(t.db)
    const srv = await new Promise<Server>((resolve) => {
      const s = dashboard.serve(t.db, 0, () => resolve(s))
    })
    c.after(() => srv.close())
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`
    assert.ok((await (await fetch(base + '/')).text()).includes('<html'))
    const data = await (await fetch(base + '/api/data?days=7')).json() as any
    assert.equal(data.daily.length, 7)
    assert.equal((await fetch(base + '/nope')).status, 404)
  })
})

describe('doggybag', () => {
  function setup(c: Parameters<typeof useTemp>[0]) {
    const t = useTemp(c)
    const cwd = t.mkdir('proj')
    const meta = (extra: object = {}) => {
      const d = doggybag.bagDir(cwd, true)
      writeFileSync(join(d, 'old.md'), '# Doggybag')
      writeFileSync(join(d, 'old.json'), JSON.stringify({ session_id: 'old', cwd, written: Date.now() / 1000, path: join(d, 'old.md'), ...extra }))
    }
    const transcript = (ts: string) => {
      const rec = assistant('m1', [['Edit', { file_path: '/w/login.py' }]], { ...USAGE, cache_read_input_tokens: 50000 })
      rec.timestamp = ts
      return writeTranscript(t.home, 'sess', [user('add a login page'), rec])
    }
    return { t, cwd, meta, transcript }
  }

  test('the folder is inside the project and ignores itself', (c) => {
    const { cwd } = setup(c)
    const d = doggybag.bagDir(cwd, true)
    assert.equal(d, join(cwd, '.doggybag'))
    assert.ok(readFileSync(join(d, '.gitignore'), 'utf8').includes('*'))
  })

  test('pack writes the session file and latest.md', (c) => {
    const { cwd, transcript } = setup(c)
    const path = transcript('2026-01-01T00:00:00Z')
    const m = doggybag.pack({ session_id: 'sess', cwd, transcript_path: path }, 'claude-code', 'manual')!
    const d = join(cwd, '.doggybag')
    assert.equal(m.path, join(d, 'sess.md'))
    assert.ok(readFileSync(join(d, 'latest.md'), 'utf8').startsWith('# Doggybag: session sess'))
    assert.ok(readFileSync(join(d, 'sess.md'), 'utf8').includes('.doggybag/latest.md'))
  })

  test('start injects the latest doggybag by default', (c) => {
    const { cwd, meta } = setup(c)
    meta({ handoff_tokens: 900, ctx_tokens: 150000 })
    const out = doggybag.start({ session_id: 'new', cwd, source: 'clear' })!
    assert.ok(out.systemMessage.includes('about 900 tokens vs 150,000'))
    assert.ok(out.hookSpecificOutput.additionalContext.includes('# Doggybag'))
  })

  test('start can just say it exists', (c) => {
    const { cwd, meta } = setup(c)
    meta()
    return withEnv({ TOKENOMICS_DOGGYBAG_INJECT: '0' }, () => {
      const out = doggybag.start({ session_id: 'new', cwd, source: 'startup' })!
      assert.ok(out.systemMessage.includes('about ? tokens vs ?'))
      assert.ok(!('hookSpecificOutput' in out))
    })
  })

  test('a cold prompt packs and warns', (c) => {
    const { cwd, transcript } = setup(c)
    const path = transcript('2020-01-01T00:00:00Z')                    // cache long expired
    return withEnv({ TOKENOMICS_DOGGYBAG_COLD_MIN_TOKENS: '0' }, () => {
      const out = doggybag.prompt({ session_id: 'sess', cwd, transcript_path: path, prompt: 'carry on' }, 'claude-code')!
      assert.ok(out.systemMessage.includes('went cold'))
      assert.ok(existsSync(join(cwd, '.doggybag', 'latest.md')))
    })
  })

  test('a cold prompt is paused once in block mode', (c) => {
    const { cwd, transcript } = setup(c)
    const d = { session_id: 'sess', cwd, transcript_path: transcript('2020-01-01T00:00:00Z'), prompt: 'carry on' }
    return withEnv({ TOKENOMICS_DOGGYBAG_COLD_MIN_TOKENS: '0', TOKENOMICS_DOGGYBAG_COLD: 'block' }, () => {
      assert.equal(doggybag.prompt(d, 'claude-code')!.decision, 'block')
      assert.ok(!('decision' in doggybag.prompt(d, 'claude-code')!))
    })
  })

  test('a warm prompt is silent', (c) => {
    const { cwd, transcript } = setup(c)
    const path = transcript(new Date().toISOString())
    assert.equal(doggybag.prompt({ session_id: 'sess', cwd, transcript_path: path, prompt: 'carry on' }, 'claude-code'), null)
  })

  test('Copilot prefers its own session transcript', (c) => {
    const { t } = setup(c)
    const root = t.mkdir('session-state')
    let when = Date.now() / 1000 - 100
    for (const sid of ['mine', 'other']) {                          // "other" is newer
      mkdirSync(join(root, sid))
      writeFileSync(join(root, sid, 'events.jsonl'), '{}\n')
      utimesSync(join(root, sid, 'events.jsonl'), when, when)
      when += 50
    }
    assert.ok(doggybag.resolveTranscript({ sessionId: 'mine', transcript_path: root }, 'copilot')!.includes(`${sep}mine${sep}`))
    assert.ok(doggybag.resolveTranscript({ transcript_path: root }, 'copilot')!.includes(`${sep}other${sep}`))
  })

  test('digest', (c) => {
    const { t } = setup(c)
    const path = writeTranscript(t.home, 'h', [user('add a login page'),
      assistant('m1', [['Edit', { file_path: '/w/login.py' }], ['Bash', { command: 'pytest -q' }]])])
    const r = doggybag.digest(path)
    assert.deepEqual([r.prompts, r.files, r.cmds], [['add a login page'], ['/w/login.py'], ['pytest -q']])
  })

  test('the hook commands run quietly', (c) => {
    const { t, cwd, transcript } = setup(c)
    const path = transcript('2020-01-01T00:00:00Z')
    const env = t.env({ TOKENOMICS_DOGGYBAG_COLD_MIN_TOKENS: '0' })
    const p = runScript('doggybag.ts', ['prompt', 'claude-code'], { env,
      input: JSON.stringify({ session_id: 'sess', cwd, transcript_path: path, prompt: 'carry on' }) })
    assert.deepEqual([p.status, p.stderr], [0, ''])
    assert.ok(JSON.parse(p.stdout).systemMessage.includes('went cold'))
    for (const mode of ['start', 'end', 'prompt', 'write']) {
      const q = runScript('doggybag.ts', [mode], { env, input: 'not json' })
      assert.deepEqual([q.status, q.stderr], [0, ''], mode)
    }
  })
})

describe('statusline', () => {
  test('the most specific price wins', () => {
    const cfg = { prices: { opus: [9, 90], 'claude-opus-4-6': [6, 30] } }
    const r = statusline.ratesFor('claude-opus-4-6', cfg)
    assert.deepEqual([r.input, r.output], [6, 30])
    assert.ok(Math.abs(r.cache_read - 0.6) < 1e-9)
    assert.equal(statusline.ratesFor('claude-opus-4-7', cfg).input, 9)   // only the family override matches
    assert.deepEqual(statusline.priceFor('mystery', {}), statusline.DEFAULT_PRICE)
  })

  test('gather accepts a string model', () => {
    const info = statusline.gather({ model: 'gpt-5', context_window: { used_percentage: 40 } }, { ...statusline.DEFAULT_CFG }, {})
    assert.deepEqual([info.model, info.pct], ['gpt-5', 40])
  })

  test('the live transcript survives the cache trim', (c) => {
    const t = useTemp(c)
    const state: Record<string, any> = { transcripts: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/old/${i}.jsonl`, { offset: 1e9, seen: i }])) }
    const path = writeTranscript(t.home, 'live', [assistant('m1')])
    statusline.scanTranscript(path, state, { ...statusline.DEFAULT_CFG })
    assert.ok(path in state.transcripts)
    assert.equal(Object.keys(state.transcripts).length, 20)
  })

  test('streamed copies of one message count once', (c) => {
    const t = useTemp(c)
    const path = writeTranscript(t.home, 'stream', [assistant('m1', [], { output_tokens: 5 }), assistant('m1', [], { output_tokens: 50 }), assistant('m2', [], { output_tokens: 1 })])
    const st = statusline.scanTranscript(path, {}, { ...statusline.DEFAULT_CFG })!
    assert.deepEqual([st.msgs, st.tok.output], [2, 51])
  })

  test('a plain render', () => {
    const info = { model: 'Sonnet', total: 12_300, cost: 1.5, symbol: '£', estimated: true, pct: 50, ttl: 300, remaining: 90 }
    const line = statusline.render(info, new statusline.Style('dark', false, true), { ...statusline.DEFAULT_CFG })
    assert.equal(line, '* Sonnet | ctx ######------ 50% | tok 12.3K | ~£1.50 | [# ] 01:30')
  })
})

describe('statusline install', () => {
  // --sync is the plugin's SessionStart hook: it offers, auto-installs and refreshes the CLI
  // statusline, and moves an older ("statusbar", or Python) install to the current names.
  function setup(c: Parameters<typeof useTemp>[0]) {
    const t = useTemp(c)
    const h = t.home
    const env = t.env({ TOKENOMICS_HOME: join(h, '.tokenomics'), CLAUDE_CONFIG_DIR: join(h, '.claude'), COPILOT_HOME: join(h, '.copilot') })
    const settings = join(h, '.claude', 'settings.json')
    const copy = join(h, '.tokenomics', 'statusline.mts')
    const run = (args: string[], extra: Env = {}) => {
      const p = runScript('statusline.ts', args, { input: '{}', env: { ...env, ...extra } })
      assert.equal(p.status, 0, p.stderr)
      return p.stdout
    }
    const cmd = (path = settings) => JSON.parse(readFileSync(path, 'utf8')).statusLine.command as string
    return { t, h, env, settings, copy, run, cmd }
  }

  test('installs by default', (c) => {
    const { run, copy, cmd } = setup(c)
    assert.ok(JSON.parse(run(['--sync'])).systemMessage.includes('installed'))
    assert.ok(cmd().includes(copy))
  })

  test('the installed command really renders', (c) => {
    const { run, cmd } = setup(c)
    run(['--sync'])
    const p = spawnSync(cmd(), { shell: true, input: JSON.stringify({ model: { display_name: 'Opus' }, context_window: { used_percentage: 40 } }),
      encoding: 'utf8', cwd: '/' })
    assert.equal(p.status, 0, p.stderr)
    assert.ok(p.stdout.includes('Opus'))
    assert.equal(p.stderr, '')
  })

  test('ask offers once, then stays quiet', (c) => {
    const { run, settings } = setup(c)
    assert.ok(JSON.parse(run(['--sync'], { TOKENOMICS_STATUSLINE: 'ask' })).systemMessage.includes('/tokenomics:statusline'))
    assert.equal(run(['--sync'], { TOKENOMICS_STATUSLINE: 'ask' }), '')
    assert.ok(!existsSync(settings))
  })

  test('--keep-existing skips another status line', (c) => {
    const { run, settings, copy, cmd } = setup(c)
    mkdirSync(join(settings, '..'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    assert.ok(run(['--install', 'claude', '--keep-existing']).includes('Skipped claude'))
    assert.equal(cmd(), 'mine')
    run(['--install', 'claude'])                                       // without the flag it replaces it
    assert.ok(cmd().includes(copy))
  })

  test('a settings file that is not JSON is left alone', (c) => {
    const { env, settings } = setup(c)
    mkdirSync(join(settings, '..'), { recursive: true })
    writeFileSync(settings, '{ nope')
    const p = runScript('statusline.ts', ['--install', 'claude'], { env })
    assert.equal(p.status, 1)
    assert.ok(p.stderr.includes('is not valid JSON'))
    assert.equal(readFileSync(settings, 'utf8'), '{ nope')
  })

  test('off never offers', (c) => {
    const { run } = setup(c)
    assert.equal(run(['--sync'], { TOKENOMICS_STATUSLINE: 'off' }), '')
    assert.equal(run(['--sync'], { TOKENOMICS_STATUSBAR: 'off' }), '')    // the old name still works
  })

  test('auto installs and refreshes', (c) => {
    const { run, copy, cmd } = setup(c)
    assert.ok(run(['--sync'], { TOKENOMICS_STATUSLINE: 'auto' }).includes('installed'))
    assert.ok(cmd().includes(copy))
    writeFileSync(copy, '// stale\n')
    assert.equal(run(['--sync']), '')
    assert.ok(readFileSync(copy).equals(readFileSync(join(SCRIPTS, 'statusline.ts'))))
    assert.ok(existsSync(join(copy, '..', 'model-prices.json')))
    assert.ok(run(['--status']).includes('claude statusline: installed'))
    assert.ok(run(['--status']).includes('claude band (desktop app): on'))
  })

  test('leaves another status line alone', (c) => {
    const { run, settings, cmd } = setup(c)
    mkdirSync(join(settings, '..'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    assert.equal(run(['--sync'], { TOKENOMICS_STATUSLINE: 'auto' }), '')
    assert.equal(cmd(), 'mine')
    assert.ok(run(['--status']).includes('another status line'))
  })

  test('the sync message names the band in the desktop app', (c) => {
    const { run } = setup(c)
    const msg = JSON.parse(run(['--sync'], { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' })).systemMessage
    assert.ok(msg.includes('statusline installed'))
    assert.ok(msg.includes('in the band above the prompt box'))
    run(['--uninstall', 'claude'])
    assert.ok(JSON.parse(run(['--sync'])).systemMessage.includes('restart Claude Code'))
  })

  for (const [what, oldName, extra] of [
    ['a pre-v1.4 statusbar install', 'statusbar.py', true],
    ['a Python statusline install', 'statusline.py', false],
  ] as [string, string, boolean][]) {
    test(`migrates ${what}`, (c) => {
      const { h, run, settings, copy, cmd } = setup(c)
      const home = join(h, '.tokenomics')
      mkdirSync(home, { recursive: true })
      const old = join(home, oldName)
      writeFileSync(old, '# the old copy\n')
      writeFileSync(join(home, extra ? 'statusbar.json' : 'statusline.json'), JSON.stringify({ currency: 'EUR' }))
      if (extra) {
        writeFileSync(join(home, 'statusbar-offered'), 'x')
        writeFileSync(join(home, 'statusbar-state.json'), '{}')
      }
      const copilot = join(h, '.copilot', 'settings.json')
      for (const [path, flags] of [[settings, {}], [copilot, { feature_flags: { enabled: ['STATUS_LINE'] } }]] as [string, object][]) {
        mkdirSync(join(path, '..'), { recursive: true })
        writeFileSync(path, JSON.stringify({ statusLine: { type: 'command', command: `"python3" "${old}"` }, ...flags }))
      }
      // still read as ours, and its config, before anything has moved
      assert.ok(run(['--status']).includes('claude statusline: installed'))
      assert.ok(run(['--no-color']).includes('€'))

      assert.equal(run(['--sync']), '')
      for (const path of [settings, copilot]) assert.ok(cmd(path).includes(copy), path)
      assert.equal(JSON.parse(readFileSync(join(home, 'statusline.json'), 'utf8')).currency, 'EUR')
      if (extra) assert.ok(existsSync(join(home, 'statusline-offered')))
      for (const gone of [oldName, 'statusbar.json', 'statusbar-offered', 'statusbar-state.json']) assert.ok(!existsSync(join(home, gone)), gone)
      assert.ok(statSync(copy).isFile())
      assert.ok(run(['--no-color']).includes('€'))
    })
  }
})

describe('pennywise', () => {
  test('score tiers', () => {
    const tiers = ['create a hello world console app', 'add a /health endpoint to the flask api',
      'refactor the auth module across all services and migrate the database schema',
      'design the architecture for a distributed queue and compare the trade-offs'].map((p) => pennywise.score(p).tier)
    assert.deepEqual(tiers, ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'])
  })

  test('the tier map from env', () => withEnv({ TOKENOMICS_ROUTER_TIERS: 'REASONING=fable' }, () => {
    const r = pennywise.score('design the architecture and compare the trade-offs', 0, pennywise.loadConfig())
    assert.equal(r.model, 'fable')
    assert.ok(pennywise.resolveModel('fable').startsWith('claude-fable'))
  }))

  test('tierOf', () => {
    assert.deepEqual(['claude-haiku-x', 'Sonnet', 'opus', 'claude-fable-5-2', 'gpt-5'].map(pennywise.tierOf), [1, 2, 3, 4, null])
  })

  const handle = (c: Parameters<typeof useTemp>[0], prompt: string, model = 'claude-opus-5-5', mode = 'route') => {
    const t = useTemp(c)
    return withEnv({ TOKENOMICS_PENNYWISE: mode, ANTHROPIC_BASE_URL: '', TOKENOMICS_DB: join(t.home, 'db.sqlite') },
      () => pennywise.handle({ session_id: 's', model, prompt }))
  }

  test('routes a simple prompt down', async (c) => {
    const out = (await handle(c, 'create a hello world console app'))!
    assert.ok(!('decision' in out))
    assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit')
    assert.ok(out.hookSpecificOutput.additionalContext.includes('model: "haiku"'))
    assert.ok(out.systemMessage.includes('down to Haiku'))
  })

  test('routes a hard prompt up', async (c) => {
    const out = (await handle(c, 'design the architecture for a distributed queue and compare trade-offs', 'claude-haiku-5-5'))!
    assert.ok(out.hookSpecificOutput.additionalContext.includes('model: "opus"'))
  })

  test('a forced model', async (c) => {
    const out = (await handle(c, 'sonnet: summarise the README'))!
    assert.ok(out.hookSpecificOutput.additionalContext.includes('model: "sonnet"'))
  })

  test('leaves follow-ups, the bypass and the same tier alone', async (c) => {
    assert.equal(await handle(c, 'yes, do it'), null)
    assert.equal(await handle(c, 'create a hello world console app', 'claude-haiku-5-5'), null)
    assert.equal(await handle(c, 'keep-model: create a hello world console app'), null)
    assert.equal(await handle(c, 'create a hello world console app', 'claude-opus-5-5', 'proxy'), null)
  })

  test('block mode still pauses', async (c) => {
    assert.equal((await handle(c, 'create a hello world console app', 'claude-opus-5-5', 'block'))!.decision, 'block')
  })

  test('the hook command is quiet on bad input', (c) => {
    const t = useTemp(c)
    for (const input of ['', 'nope', '[1]', '{}']) {
      const p = runScript('pennywise.ts', [], { input, env: t.env() })
      assert.deepEqual([p.status, p.stdout, p.stderr], [0, '', ''])
    }
  })
})

describe('pennywise proxy', () => {
  // The routing proxy against a fake upstream.
  test('routing', async (c) => {
    const t = useTemp(c)
    const seen: string[] = []
    const up = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (b) => chunks.push(b))
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        const b = JSON.parse(text)
        seen.push(b.model)
        if (b.model.startsWith('claude-haiku') && text.includes('FAIL')) {
          res.writeHead(529)
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        for (let i = 0; i < 3; i++) res.write(`data: ${i}\n\n`)
        res.end()
      })
    })
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r))
    c.after(() => up.close())
    await withEnv({ TOKENOMICS_DB: join(t.home, 'db.sqlite') }, async () => {
      const srv = await pennywise.serve(0, { upstream: `http://127.0.0.1:${(up.address() as AddressInfo).port}` })
      c.after(() => srv.close())
      const port = (srv.address() as AddressInfo).port
      const call = async (msgs: object[], model = 'pennywise') => (await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, system: 's', messages: msgs }),
      })).text()

      const first = { role: 'user', content: 'create a hello world console app' }
      assert.equal((await call([first])).split('data:').length - 1, 3)            // the stream passes through
      const loop = [first, { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }]
      await call(loop)
      const hard = [...loop, { role: 'assistant', content: 'done' },
        { role: 'user', content: 'design the architecture for a queue and compare trade-offs' }]
      await call(hard)
      await call([...hard, { role: 'assistant', content: 'x'.repeat(200000) }, { role: 'user', content: 'fix the typo' }])   // warm + big context: stays put
      await call([{ role: 'user', content: 'FAIL fix the typo' }])                // haiku fails -> fallback
      await call([first], 'claude-haiku-5-5')                                      // not ours: untouched
      assert.deepEqual(seen.map((m) => m.split('-')[1]), ['haiku', 'haiku', 'opus', 'opus', 'haiku', 'opus', 'haiku'])
      const health = await (await fetch(`http://127.0.0.1:${port}/pennywise/health`)).json() as any
      assert.equal(health.ok, true)
    })
  })
})

describe('the tokenomics command', { skip: !POSIX && 'uses a shell-script stand-in for claude' }, () => {
  function setup(c: Parameters<typeof useTemp>[0]) {
    const t = useTemp(c)
    const h = t.home
    const fakebin = t.mkdir('fakebin')
    const log = join(h, 'claude.log')
    writeFileSync(join(fakebin, 'claude'), `#!/bin/sh\necho "$*" >> "${log}"\n`)
    chmodSync(join(fakebin, 'claude'), 0o755)
    const env: Env = t.env({ TOKENOMICS_HOME: join(h, '.tokenomics'), CLAUDE_CONFIG_DIR: join(h, '.claude'),
      COPILOT_HOME: join(h, '.copilot'), SHELL: '/bin/bash', PATH: `${fakebin}:/usr/bin:/bin` })
    const settings = join(h, '.claude', 'settings.json')
    const cli = (...args: string[]) => {
      const p = runScript('cli.ts', args, { env, timeout: 60_000 })
      assert.equal(p.status, 0, p.stderr)
      return p.stdout
    }
    return { t, h, env, settings, log, cli }
  }

  test('setup installs the plugin, the statusline and the launcher', (c) => {
    const { h, settings, log, cli } = setup(c)
    assert.ok(cli('setup').includes('plugin installed'))
    assert.ok(readFileSync(log, 'utf8').includes('plugin install tokenomics@tokenomics'))
    assert.ok(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command.includes('statusline.mts'))
    const launcher = join(h, '.local', 'bin', 'tokenomics')
    assert.ok(statSync(launcher).isFile())
    const rc = join(h, process.platform === 'darwin' ? '.bash_profile' : '.bashrc')   // what bash reads
    assert.ok(readFileSync(rc, 'utf8').includes('added by the tokenomics installer'))
    assert.equal(readFileSync(join(h, '.tokenomics', 'node'), 'utf8').trim(), process.execPath.replaceAll('\\', '/'))
    const p = spawnSync(launcher, ['help'], { encoding: 'utf8' })                      // the launcher runs the CLI
    assert.ok(p.stdout.includes('one command for setup'), p.stderr)
    cli('setup')                                                                       // idempotent: one PATH line only
    assert.equal(readFileSync(rc, 'utf8').split('tokenomics installer').length - 1, 1)

    cli('uninstall')
    assert.ok(!('statusLine' in JSON.parse(readFileSync(settings, 'utf8'))))
    assert.ok(!existsSync(launcher))
    assert.ok(!readFileSync(rc, 'utf8').includes('tokenomics'))
    assert.ok(readFileSync(log, 'utf8').includes('plugin uninstall tokenomics@tokenomics'))
  })

  test("setup keeps someone else's status line", (c) => {
    const { settings, cli } = setup(c)
    mkdirSync(join(settings, '..'), { recursive: true })
    writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }))
    assert.ok(cli('setup', '--no-plugin').includes('kept your existing status line'))
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command, 'mine')
    cli('uninstall')                                                                  // and uninstall leaves it alone too
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).statusLine.command, 'mine')
  })

  test('no assistant found still gives a command', (c) => {
    const { t, env, cli } = setup(c)
    env.PATH = join(t.home, 'empty')
    assert.ok(cli('setup').includes('Neither Claude Code'))
  })

  test('the dashboard runs in the background and stops', async (c) => {
    const { cli } = setup(c)
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port
        s.close(() => resolve(p))
      })
    })
    const out = cli('dashboard', '--demo', '--no-open', '--port', String(port))
    try {
      assert.ok(out.includes('running on'))
      assert.ok(await dashboard.portBusy(port))
    } finally {
      assert.ok(cli('dashboard', '--stop').includes('Stopped'))
    }
  })
})

describe('installer scripts', () => {
  test('install.sh is valid and runs cli setup', () => {
    const text = readFileSync(join(ROOT, 'install.sh'), 'utf8')
    assert.ok(text.includes('scripts/cli.ts" setup'))
    assert.ok(text.trimEnd().endsWith('main "$@"'))                     // nothing runs until fully downloaded
    if (POSIX) {
      const r = spawnSync('sh', ['-n', join(ROOT, 'install.sh')], { encoding: 'utf8' })
      assert.equal(r.status, 0, r.stderr)
    }
  })

  test('install.ps1 runs cli setup', () => {
    assert.ok(readFileSync(join(ROOT, 'install.ps1'), 'utf8').includes("scripts\\cli.ts') setup"))
  })

  test('both pin the same Node.js release', () => {
    const v = (f: string) => /v24\.\d+\.\d+/.exec(readFileSync(join(ROOT, f), 'utf8'))?.[0]
    assert.ok(v('install.sh'))
    assert.equal(v('install.sh'), v('install.ps1'))
  })
})

describe('run.sh', { skip: !POSIX && 'needs a POSIX sh; Windows CI runs it through Git Bash' }, () => {
  // scripts/run.sh: how every hook and skill finds Node.js, on any OS.
  function setup(c: Parameters<typeof useTemp>[0]) {
    const t = useTemp(c)
    const bin = t.mkdir('bin')
    const nodebin = t.mkdir('nodebin')                                  // Node.js lives here, on PATH or not
    const cache = join(t.home, '.tokenomics', 'node')
    const probe = join(SCRIPTS, `_run_probe_${process.pid}.ts`)
    writeFileSync(probe, "import { readFileSync } from 'node:fs'\nconsole.log(readFileSync(0, 'utf8').toUpperCase(), JSON.stringify(process.argv.slice(2)))\nprocess.exitCode = 3\n")
    c.after(() => unlinkSync(probe))
    for (const tool of ['dirname', 'head', 'tr', 'mkdir']) {             // what run.sh itself needs
      const which = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim()
      symlinkSync(which, join(bin, tool))
    }
    const link = (name: string) => symlinkSync(process.execPath, join(nodebin, name))
    const runSh = (onPath = true) => spawnSync('/bin/sh', [join(SCRIPTS, 'run.sh'), probe.split(sep).at(-1)!, 'a', 'b c'], {
      input: 'hi', encoding: 'utf8', timeout: 30_000, env: t.env({ PATH: onPath ? `${bin}:${nodebin}` : bin }) as NodeJS.ProcessEnv })
    return { t, bin, nodebin, cache, link, runSh }
  }

  test('passes stdin, args and the exit code through, and caches the Node.js it found', (c) => {
    const { cache, link, runSh } = setup(c)
    link('node')
    const r = runSh()
    assert.equal(r.status, 3, r.stderr + r.stdout)
    assert.ok(r.stdout.includes('HI ["a","b c"]'))
    assert.equal(r.stderr, '')
    assert.equal(realpathSync(readFileSync(cache, 'utf8').trim()), realpathSync(process.execPath))
    assert.equal(runSh(false).status, 3)                                // only the cache can work
  })

  test('a stale cache falls back, and a missing Node.js never blocks', (c) => {
    const { cache, link, runSh } = setup(c)
    mkdirSync(join(cache, '..'), { recursive: true })
    writeFileSync(cache, '/nowhere/node.exe\n')
    const r = runSh()
    assert.equal(r.status, 0)                                           // no Node.js at all: warn, don't block
    assert.ok(r.stderr.includes('Node.js 22.18+ not found'))
    link('node')
    assert.equal(runSh().status, 3)
  })

  test('an old Node.js is not used', (c) => {
    const { nodebin, runSh } = setup(c)
    writeFileSync(join(nodebin, 'node'), '#!/bin/sh\nexit 1\n')          // fails the version probe, like Node 20 would
    chmodSync(join(nodebin, 'node'), 0o755)
    const r = runSh()
    assert.equal(r.status, 0)
    assert.ok(r.stderr.includes('Node.js 22.18+ not found'))
  })
})

describe('launcher wiring', () => {
  test('every hook and skill goes through the launcher', () => {
    const cc = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))
    const cp = JSON.parse(readFileSync(join(ROOT, 'copilot-hooks.json'), 'utf8'))
    const cmds: string[] = Object.values(cc.hooks).flatMap((arms: any) => arms.flatMap((g: any) => g.hooks.map((h: any) => h.command)))
    cmds.push(...Object.values(cp.hooks).flatMap((arms: any) => arms.map((h: any) => h.bash)))
    for (const cmd of cmds) {
      assert.match(cmd, /^sh \S*run\.sh"? \w+\.ts/, cmd)
      assert.ok(statSync(join(SCRIPTS, cmd.split('run.sh')[1].replaceAll('"', '').trim().split(/\s+/)[0])).isFile(), cmd)
    }
    for (const h of Object.values(cp.hooks).flat() as any[]) {
      assert.ok(h.powershell.includes('.tokenomics/node'))
      assert.ok(/scripts\\\w+\.ts/.test(h.powershell))
    }
    for (const skill of readdirSync(join(ROOT, 'skills'))) {
      const text = readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8')
      assert.ok(!text.includes('node "${CLAUDE_PLUGIN_ROOT}'), skill)
      assert.ok(!/\.py\b/.test(text), skill)
    }
    assert.ok(readFileSync(join(ROOT, 'hooks', 'band.tsx'), 'utf8').includes("'statusline.ts', '--json'"))
  })
})
