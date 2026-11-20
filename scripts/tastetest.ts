#!/usr/bin/env node
/**
 * tokenomics / tastetest: never sacrifice quality for savings. A blind taste test of two ways of
 * doing the same task (baseline vs optimised: another model, a trimmed CLAUDE.md, a new prompt):
 * what each cost, how good each result is, and whether the saving survives the quality check.
 *
 * Quality comes from evidence, not opinion:
 *   checks         your tests, linter and type checker, run in each side's working copy
 *                  (auto-detected from package.json, pyproject.toml, Cargo.toml, go.mod; or --check)
 *   agent signals  from each transcript: did the last test run pass, how many tool calls failed
 * Cost comes from each side's transcript (or --a-cost / --b-cost).
 *
 * The result is a quality-adjusted saving: how much cheaper B is per unit of quality,
 * 1 - (cost_B / quality_B) / (cost_A / quality_A). A cheaper run that broke the tests scores
 * below zero: a false economy.
 *
 *   tastetest.ts --a <session-id | transcript.jsonl> --b <...> [--a-dir PATH --b-dir PATH]
 *                [--check "npm test"]... [--tolerance 2] [--save LABEL] [--json]
 *   tastetest.ts history [--json]       earlier taste tests saved with --save
 *
 * Typical A/B: two git worktrees, the same prompt, one run each way:
 *   git worktree add ../try-a && git worktree add ../try-b
 *   (run the task in each) then:  tastetest.ts --a <id-a> --a-dir ../try-a --b <id-b> --b-dir ../try-b
 *
 * Env: TOKENOMICS_TASTETEST_TIMEOUT  seconds per check (default 600)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { findTranscript } from './coach.ts'
import { defaultDbPath } from '../tokenomics/config.ts'
import * as currency from '../tokenomics/engine/currency.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { classifyCommand, passed } from '../tokenomics/engine/outcomes.ts'
import * as store from '../tokenomics/engine/store.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { argValue, isMain, now, type Obj } from '../tokenomics/util.ts'

export type Check = { command: string, exit: number | null, passed: number | null, failed: number | null, score: number, seconds: number }
export type Side = {
  name: string
  source: string | null
  cost_usd: number | null
  tokens: number | null
  turns: number | null
  checks: Check[]
  signals: { final_tests: 'pass' | 'fail' | null, error_rate: number | null }
  quality: number | null
}

/** Pass/fail counts from test output (node:test/TAP, cargo, jest, vitest, pytest, mocha, go ...), or nulls. */
export function counts(out: string): [number | null, number | null] {
  const sum = (ms: RegExpMatchArray[], i = 1) => ms.reduce((a, m) => a + Number(m[i]), 0)
  const tapP = [...out.matchAll(/^# pass\s+(\d+)/gm)]
  const tapF = [...out.matchAll(/^# fail\s+(\d+)/gm)]
  if (tapP.length || tapF.length) return [sum(tapP), sum(tapF)]
  const cargo = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)]
  if (cargo.length) return [sum(cargo, 1), sum(cargo, 2)]
  const lines = out.split('\n').filter((l) => /\b\d+ (tests? )?(passed|passing|failed|failing)\b/i.test(l))
  const last = (re: RegExp) => {
    let v: number | null = null
    for (const l of lines) {
      const m = re.exec(l)
      if (m) v = Number(m[1])
    }
    return v
  }
  const p = last(/(\d+) (?:tests? )?(?:passed|passing)\b/i)
  const f = last(/(\d+) (?:tests? )?(?:failed|failing)\b/i)
  return p === null && f === null ? [null, null] : [p ?? 0, f ?? 0]
}

export function detectChecks(dir: string): string[] {
  const out: string[] = []
  try {
    const scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}
    if (scripts.test && !/no test specified/.test(scripts.test)) out.push('npm test')
    for (const s of ['lint', 'typecheck', 'type-check', 'check']) if (scripts[s]) out.push(`npm run ${s}`)
  } catch {
    // no package.json
  }
  if (existsSync(join(dir, 'pyproject.toml')) || existsSync(join(dir, 'pytest.ini')) || existsSync(join(dir, 'setup.cfg'))) out.push('python -m pytest -q')
  if (existsSync(join(dir, 'Cargo.toml'))) out.push('cargo test')
  if (existsSync(join(dir, 'go.mod'))) out.push('go test ./...', 'go vet ./...')
  return out
}

function runCheck(command: string, dir: string): Check {
  const timeout = Math.max(10, Number(process.env.TOKENOMICS_TASTETEST_TIMEOUT ?? 600) || 600) * 1000
  const t0 = Date.now()
  const p = spawnSync(command, { cwd: dir, shell: true, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } })
  const out = `${p.stdout ?? ''}\n${p.stderr ?? ''}`
  const [ok, bad] = counts(out)
  const exit = p.status
  let score = exit === 0 ? 1 : 0
  if (ok !== null && bad !== null && ok + bad > 0) score = ok / (ok + bad)
  if (exit !== 0 && score === 1) score = 0                  // it failed for some other reason (build error, timeout)
  return { command, exit, passed: ok, failed: bad, score: Math.round(score * 1000) / 1000, seconds: Math.round((Date.now() - t0) / 100) / 10 }
}

function transcriptFor(ref: string | null): string | null {
  if (!ref) return null
  try {
    if (statSync(ref).isFile()) return ref
  } catch {
    // not a path: a session id
  }
  return findTranscript({ session: ref })
}

export function side(name: string, ref: string | null, dir: string | null, checks: string[], costOverride: number | null): Side {
  const s: Side = { name, source: ref, cost_usd: null, tokens: null, turns: null, checks: [], signals: { final_tests: null, error_rate: null }, quality: null }
  const path = transcriptFor(ref)
  if (path) {
    const t = trace.parse(path)
    s.source = path
    s.cost_usd = trace.costUsd(t)
    s.tokens = t.turns.reduce((a, x) => a + x.ctx + x.usage.outputTokens, 0)
    s.turns = t.turns.length
    const tests = t.steps.filter((x) => classifyCommand(trace.command(x)) === 'test' && x.isError !== null)
    if (tests.length) s.signals.final_tests = passed(tests[tests.length - 1]) ? 'pass' : 'fail'
    const done = t.steps.filter((x) => x.isError !== null)
    if (done.length) s.signals.error_rate = Math.round(done.filter((x) => x.isError).length / done.length * 1000) / 1000
  } else if (ref) {
    throw new Error(`no transcript found for ${name}: ${ref}`)
  }
  if (costOverride !== null) s.cost_usd = costOverride
  if (dir) s.checks = (checks.length ? checks : detectChecks(dir)).map((c) => runCheck(c, dir))
  // quality: each check weighs 1; the agent's own signals weigh 0.5 next to checks, 1 without them
  let w = 0
  let q = 0
  for (const c of s.checks) {
    w += 1
    q += c.score
  }
  const sig: number[] = []
  if (s.signals.final_tests) sig.push(s.signals.final_tests === 'pass' ? 1 : 0)
  if (s.signals.error_rate !== null) sig.push(1 - Math.min(1, s.signals.error_rate * 2))
  if (sig.length) {
    const sw = s.checks.length ? 0.5 : 1
    w += sw
    q += sw * sig.reduce((a, b) => a + b, 0) / sig.length
  }
  s.quality = w ? Math.round(q / w * 1000) / 1000 : null
  return s
}

export type Verdict = { verdict: string, saving_pct: number | null, quality_change: number | null, quality_adjusted_saving_pct: number | null,
  summary: string }

// verdicts: safe-saving | cheaper-but-worse | false-economy (quality fell too far, or a check broke) |
//           better-for-more | no-saving | worse | no-cost

export function judge(a: Side, b: Side, tolerance = 0.02): Verdict {
  const ca = a.cost_usd
  const cb = b.cost_usd
  const qa = a.quality ?? 1
  const qb = b.quality ?? 1
  const saving = ca && cb !== null ? Math.round((1 - cb / ca) * 1000) / 10 : null
  const dq = a.quality !== null && b.quality !== null ? Math.round((qb - qa) * 1000) / 10 : null
  let qas: number | null = null
  if (ca && cb !== null) qas = qb <= 0 ? -100 : qa <= 0 ? 100 : Math.round((1 - (cb / qb) / (ca / qa)) * 1000) / 10
  const held = qb >= qa - tolerance
  const broke = b.checks.filter((cb_) => {
    const ca_ = a.checks.find((x) => x.command === cb_.command)
    return ca_ && cb_.score < ca_.score - tolerance
  }).map((x) => `\`${x.command}\``)
  let verdict: string
  let summary: string
  if (saving === null) {
    verdict = 'no-cost'
    summary = 'Could not compare cost: give each side a transcript (or --a-cost / --b-cost).'
  } else if (saving > 0 && held) {
    verdict = 'safe-saving'
    summary = `Safe saving: B is ${saving}% cheaper and quality held (${(qa * 100).toFixed(0)}% → ${(qb * 100).toFixed(0)}%).`
  } else if (saving > 0 && broke.length) {
    verdict = 'false-economy'
    summary = `False economy: B is ${saving}% cheaper but broke ${broke.join(', ')}, which passed for A. A saving that fails the checks is not a saving.`
  } else if (saving > 0 && (qas ?? 0) > 0) {
    verdict = 'cheaper-but-worse'
    summary = `Cheaper but worse: B saves ${saving}% but quality fell ${Math.abs(dq ?? 0)} points; per unit of quality it still saves ${qas}%. Decide if the drop matters.`
  } else if (saving > 0) {
    verdict = 'false-economy'
    summary = `False economy: B is ${saving}% cheaper, but quality fell ${Math.abs(dq ?? 0)} points, so each unit of quality costs ${Math.abs(qas ?? 0)}% more.`
  } else if (!held) {
    verdict = 'worse'
    summary = `Worse on both: B costs ${Math.abs(saving)}% more and quality fell ${Math.abs(dq ?? 0)} points. Keep A.`
  } else if (qb > qa + tolerance) {
    verdict = 'better-for-more'
    summary = `Paid more, got better: B costs ${Math.abs(saving)}% more and quality rose ${dq} points (quality-adjusted ${qas}%).`
  } else {
    verdict = 'no-saving'
    summary = `No saving: B costs ${Math.abs(saving)}% more for the same quality. Keep A.`
  }
  return { verdict, saving_pct: saving, quality_change: dq, quality_adjusted_saving_pct: qas, summary }
}

export function markdown(r: Obj): string {
  const [, symbol, rate] = currency.current()
  const m = (v: number | null) => (v === null ? 'n/a' : currency.formatMoney(v * rate, symbol))
  const q = (v: number | null) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`)
  const a: Side = r.a
  const b: Side = r.b
  const L = ['# tastetest: quality-adjusted saving', '', `**${r.summary}**`, '',
    '| | A (baseline) | B (optimised) |', '|---|---:|---:|',
    `| Cost | ${m(a.cost_usd)} | ${m(b.cost_usd)} |`,
    `| Tokens | ${a.tokens?.toLocaleString('en-US') ?? 'n/a'} | ${b.tokens?.toLocaleString('en-US') ?? 'n/a'} |`,
    `| Turns | ${a.turns ?? 'n/a'} | ${b.turns ?? 'n/a'} |`]
  const names = [...new Set([...a.checks, ...b.checks].map((c) => c.command))]
  for (const n of names) {
    const show = (c?: Check) => (!c ? 'n/a' : c.passed !== null && c.failed !== null ? `${c.passed} ✓ ${c.failed} ✗` : c.exit === 0 ? 'pass' : `fail (${c.exit})`)
    L.push(`| \`${n}\` | ${show(a.checks.find((c) => c.command === n))} | ${show(b.checks.find((c) => c.command === n))} |`)
  }
  L.push(`| Last test run in session | ${a.signals.final_tests ?? 'n/a'} | ${b.signals.final_tests ?? 'n/a'} |`,
    `| Failed tool calls | ${a.signals.error_rate === null ? 'n/a' : q(a.signals.error_rate)} | ${b.signals.error_rate === null ? 'n/a' : q(b.signals.error_rate)} |`,
    `| **Quality** | **${q(a.quality)}** | **${q(b.quality)}** |`, '',
    `Raw saving ${r.saving_pct ?? 'n/a'}% · quality change ${r.quality_change ?? 'n/a'} pts · **quality-adjusted saving ${r.quality_adjusted_saving_pct ?? 'n/a'}%**`, '')
  if (!a.checks.length && !b.checks.length) L.push('_No checks were run: pass --a-dir and --b-dir (each side\'s working copy) for a real quality comparison._', '')
  return L.join('\n')
}

function save(label: string, r: Obj): void {
  const db = store.connect(defaultDbPath())
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS tastetest_runs(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, label TEXT, a_cost_usd REAL,
      b_cost_usd REAL, a_quality REAL, b_quality REAL, saving_pct REAL, quality_adjusted_pct REAL, verdict TEXT)`)
    db.run('INSERT INTO tastetest_runs(ts,label,a_cost_usd,b_cost_usd,a_quality,b_quality,saving_pct,quality_adjusted_pct,verdict) VALUES(?,?,?,?,?,?,?,?,?)',
      now(), label, r.a.cost_usd, r.b.cost_usd, r.a.quality, r.b.quality, r.saving_pct, r.quality_adjusted_saving_pct, r.verdict)
  } finally {
    db.close()
  }
}

function history(args: string[]): number {
  const p = defaultDbPath()
  const rows = existsSync(p) ? withDb(p, (db) => (db.tables().has('tastetest_runs') ? db.all('SELECT * FROM tastetest_runs ORDER BY id DESC LIMIT 30') : []),
    { readOnly: true }) : []
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
    return 0
  }
  if (!rows.length) {
    process.stdout.write('No saved taste tests yet (run one with --save LABEL).\n')
    return 0
  }
  process.stdout.write('| When | Label | Saving | Quality A → B | Quality-adjusted | Verdict |\n|---|---|---:|---|---:|---|\n' +
    rows.map((r) => `| ${String(r.ts).slice(0, 10)} | ${r.label} | ${r.saving_pct ?? 'n/a'}% | ${r.a_quality ?? 'n/a'} → ${r.b_quality ?? 'n/a'} | ` +
      `${r.quality_adjusted_pct ?? 'n/a'}% | ${r.verdict} |`).join('\n') + '\n')
  return 0
}

export function main(args: string[]): number {
  if (args[0] === 'history') return history(args)
  const checks: string[] = []
  args.forEach((x, i) => {
    if (x === '--check' && args[i + 1]) checks.push(args[i + 1])
  })
  const money = (v: string | null) => {
    if (v === null) return null
    const [, , rate] = currency.current()
    const n = Number(v.replace(/^[£$€]/, ''))
    return Number.isFinite(n) ? n / rate : null
  }
  const aRef = argValue(args, '--a')
  const bRef = argValue(args, '--b')
  const aDir = argValue(args, '--a-dir')
  const bDir = argValue(args, '--b-dir')
  if (!(aRef || aDir || argValue(args, '--a-cost')) || !(bRef || bDir || argValue(args, '--b-cost'))) {
    process.stderr.write('Usage: tastetest.ts --a <session|transcript> --b <session|transcript> [--a-dir PATH --b-dir PATH] [--check CMD]...\n')
    return 2
  }
  let a: Side
  let b: Side
  try {
    a = side('A', aRef, aDir ? resolve(aDir) : null, checks, money(argValue(args, '--a-cost')))
    b = side('B', bRef, bDir ? resolve(bDir) : null, checks, money(argValue(args, '--b-cost')))
  } catch (e) {
    process.stderr.write(`tastetest: ${e instanceof Error ? e.message : e}\n`)
    return 1
  }
  const tol = Number(argValue(args, '--tolerance') ?? 2) / 100
  const r = { a, b, ...judge(a, b, Number.isFinite(tol) ? tol : 0.02) }
  const label = argValue(args, '--save')
  if (label) save(label, r)
  process.stdout.write((args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r)) + '\n')
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
