#!/usr/bin/env node
/**
 * tokenomics / parrot: stop telling the AI the same thing every session.
 *
 * A rule you type in a prompt ("always use pnpm", "don't add comments") lasts one session. Typed again
 * in the next session and the one after, it is a line of CLAUDE.md you haven't written yet; a whole
 * prompt you keep pasting is a slash command; and a correction you keep making is work paid for twice.
 * Rules: tokenomics/engine/parrot.ts.
 *
 * Prompt hook (Claude Code: UserPromptSubmit). Records a hash of each rule, correction and whole
 * prompt (never the text) against this project. When one reaches TOKENOMICS_PARROT_MIN different
 * sessions (default 3) it says so once, with the fix: a CLAUDE.md line or a slash command. Prompts
 * starting with "/" are never checked.
 *
 *   parrot.ts [source]                                  hook (stdin: hook JSON)
 *   parrot.ts report [--days 30] [--projects DIR] [--min 3] [--here] [--json]
 *                     every repeat across your recent sessions (read from your local transcripts),
 *                     corrections and what the corrected work cost; --here: this folder only
 *   add --currency USD. The report is read-only.
 *
 * Env: TOKENOMICS_PARROT = warn (default: a notice) | off, TOKENOMICS_PARROT_MIN (default 3).
 * Always exits 0 as a hook; a crash never blocks a prompt.
 */
import { resolve } from 'node:path'

import { defaultDbPath } from '../tokenomics/config.ts'
import { withDb } from '../tokenomics/engine/db.ts'
import { TABLES } from '../tokenomics/engine/events.ts'
import { commandName, corrections, instructionsText, normalise, phrases, repeats, type Phrase } from '../tokenomics/engine/parrot.ts'
import * as trace from '../tokenomics/engine/trace.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { CostEngine, PolicyEngine } from '../tokenomics/services/index.ts'
import { argValue, errText, first, isMain, logErr, now, readPayload, sha1, type Obj } from '../tokenomics/util.ts'
import { numArg, recentTranscripts, useCurrency, write } from './common.ts'

const minSessions = () => PolicyEngine.threshold('TOKENOMICS_PARROT_MIN', 3, { min: 2, max: 50 })
const projectKey = (cwd: string | null) => sha1(resolve(cwd || '.')).slice(0, 12)

/** Record this prompt's phrases; return the ones that just reached `min` sessions and haven't been mentioned. Exported for tests. */
export function record(dbPath: string, sid: string, source: string, cwd: string | null, list: Phrase[], min = minSessions()): Phrase[] {
  if (!list.length) return []
  const project = projectKey(cwd)
  return withDb(dbPath, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS parrot_events(id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, ${TABLES.parrot_events})`)
    db.exec('CREATE INDEX IF NOT EXISTS idx_parrot_key ON parrot_events(project, key)')
    const due: Phrase[] = []
    db.transaction(() => {
      for (const ph of list) {
        const rows = db.all('SELECT session_id, action FROM parrot_events WHERE project=? AND key=?', project, ph.key)
        if (!rows.some((r) => r.session_id === sid && r.action === 'seen')) {
          db.run('INSERT INTO parrot_events(ts,session_id,source,project,key,kind,action) VALUES(?,?,?,?,?,?,?)', now(), sid, source, project, ph.key, ph.kind, 'seen')
        }
        const sessions = new Set(rows.filter((r) => r.action === 'seen').map((r) => String(r.session_id)))
        sessions.add(sid)
        if (sessions.size >= min && !rows.some((r) => r.action === 'nudged')) due.push(ph)
      }
      for (const ph of due) {
        db.run('INSERT INTO parrot_events(ts,session_id,source,project,key,kind,action) VALUES(?,?,?,?,?,?,?)', now(), sid, source, project, ph.key, ph.kind, 'nudged')
      }
    })
    return due
  })
}

/** The notice for phrases that just became repeats. Exported for tests. */
export function message(due: Phrase[], min: number, cwd: string | null): string {
  const p = due.find((x) => x.kind !== 'prompt') ?? due[0]
  const quote = p.text.length > 90 ? `${p.text.slice(0, 87)}...` : p.text
  if (p.kind === 'prompt') {
    const name = commandName(p.text)
    return `parrot: you've sent this same prompt ("${quote}") in ${min} sessions. Save it as a slash command ` +
      `(.claude/commands/${name}.md, then type /${name}) and stop pasting it.`
  }
  const already = instructionsText(cwd).includes(normalise(p.text))
  const what = p.kind === 'correction' ? 'had to correct the AI with' : 'told the AI'
  const more = due.length > 1 ? ` (and ${due.length - 1} more you keep repeating: \`tokenomics parrot report --here\`)` : ''
  return already
    ? `parrot: you've ${what} "${quote}" in ${min} sessions, though it's already in your instruction file. Check the file loads (/memory) and that the line is short and near the top.${more}`
    : `parrot: you've ${what} "${quote}" in ${min} sessions in this project. One line in CLAUDE.md says it to every session, so you don't have to: ask me to add it.${more}`
}

function hook(source: string): void {
  if (PolicyEngine.mode('TOKENOMICS_PARROT', 'warn', ['warn', 'off']) === 'off') return
  const dbPath = defaultDbPath()
  try {
    const payload = readPayload()
    const adapter = getAdapter(source)
    const sid = adapter.sessionId(payload)
    const cwd = payload.cwd ? String(payload.cwd) : null
    const prompt = String(first(payload, ['prompt', 'userPrompt'], '') || '')
    const min = minSessions()
    const due = record(dbPath, sid, adapter.name, cwd, phrases(prompt), min)
    if (!due.length) return
    const out = PolicyEngine.enforce(adapter, 'warn', message(due, min, cwd))
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(dbPath, `parrot\n${errText(e)}`)
  }
}

export function report(args: string[]): Obj {
  const days = Math.max(0, Math.trunc(numArg(args, '--days', 30)))
  const min = Math.max(2, Math.trunc(numArg(args, '--min', minSessions())))
  const here = args.includes('--here') ? resolve(process.cwd()) : null
  const traces = recentTranscripts(days, argValue(args, '--projects') ?? undefined).map((p) => trace.parse(p))
    .filter((t) => t.prompts.length && (!here || (t.cwd && resolve(t.cwd) === here)))
  const reps = repeats(traces, min)
  const fixes = traces.flatMap((t) => corrections(t).map((c) => ({ ...c, session_id: t.sessionId })))
  const prompts = traces.reduce((a, t) => a + t.prompts.length, 0)
  const tips: string[] = []
  const rules = reps.filter((r) => r.kind !== 'prompt' && !r.in_instructions)
  if (rules.length) tips.push(`Write the ${rules.length} repeated rule${rules.length === 1 ? '' : 's'} into CLAUDE.md once; each session then starts knowing ${rules.length === 1 ? 'it' : 'them'}.`)
  if (reps.some((r) => r.in_instructions)) tips.push('Some repeats are already in your instruction file: a long or contradictory file gets skimmed. springclean finds what to cut.')
  if (reps.some((r) => r.kind === 'prompt')) tips.push('Prompts you paste again and again are slash commands: one file in .claude/commands/ each.')
  if (prompts && fixes.length / prompts >= 0.15) tips.push('More than one prompt in seven corrects the agent. Say what "done" looks like up front (the test to pass, the file to change) and it has less to guess.')
  return {
    period: days ? `last ${days} days` : 'all time', scope: here ? 'this folder' : 'every project', sessions: traces.length, prompts, min_sessions: min,
    repeats: reps.slice(0, 20), repeat_count: reps.length,
    corrections: fixes.length, correction_rate: prompts ? Math.round(fixes.length / prompts * 100) / 100 : 0,
    corrected_usd: Math.round(fixes.reduce((a, c) => a + c.usd, 0) * 1e6) / 1e6,
    costliest_corrections: fixes.sort((a, b) => b.usd - a.usd).slice(0, 5),
    tips,
  }
}

const KIND: Record<string, string> = { rule: 'rule', correction: 'correction', prompt: 'whole prompt' }

export function markdown(r: Obj): string {
  const { fmt } = CostEngine.display()
  const L = [`# parrot: what you keep telling the AI, ${r.period} (${r.scope})`, '']
  if (!r.sessions) {
    L.push('No sessions in this period.')
    return L.join('\n')
  }
  L.push(`${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${r.prompts} prompt${r.prompts === 1 ? '' : 's'}. ${r.repeat_count} thing${r.repeat_count === 1 ? '' : 's'} said in ${r.min_sessions}+ sessions; ` +
    `${r.corrections} correction${r.corrections === 1 ? '' : 's'} (${Math.round(r.correction_rate * 100)}% of prompts), redoing work that had cost ${fmt(r.corrected_usd)}.`, '')
  if (r.repeats.length) {
    L.push('| Said | Sessions | Kind | Fix |', '|---|---:|---|---|')
    for (const x of r.repeats.slice(0, 10)) L.push(`| ${x.text.replace(/\|/g, '\\|')} | ${x.sessions} | ${KIND[x.kind]} | ${x.suggestion.replace(/\|/g, '\\|')} |`)
    L.push('')
  } else {
    L.push('Nothing repeated across sessions: your instructions are already doing their job.', '')
  }
  if (r.costliest_corrections.length) {
    L.push('**Costliest corrections** (the work before each):', '')
    for (const c of r.costliest_corrections) L.push(`- ${fmt(c.usd)}: "${c.text}"`)
    L.push('')
  }
  if (r.tips.length) {
    L.push('## Say it once', '')
    for (const t of r.tips) L.push(`- ${t}`)
    L.push('')
  }
  L.push('_Read from your local transcripts; the hook keeps only hashes. Corrections are judged from the first words of a prompt ("no,", "that\'s wrong", "you forgot")._')
  return L.join('\n')
}

export function main(args: string[]): number {
  if (args[0] !== 'report') {
    hook(args[0] ?? 'claude-code')
    return 0
  }
  if (!useCurrency(args)) return 2
  const r = report(args)
  write(args.includes('--json') ? JSON.stringify(r, null, 2) : markdown(r))
  return 0
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2))
