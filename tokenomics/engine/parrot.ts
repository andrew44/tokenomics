/**
 * Parrot: what you keep telling the AI, session after session.
 *
 * A standing rule said in a prompt ("always use pnpm", "don't add comments") lasts one session; the
 * same rule in CLAUDE.md lasts for all of them. A correction you keep making ("no, use the v2 client")
 * is paid for twice: once for the work that got it wrong, once to redo it. A whole prompt you keep
 * pasting is a slash command waiting to be written. This module finds all three, from the words of
 * your prompts only:
 *
 *   phrases()    the candidate phrases in one prompt, each with a stable key (a hash of its
 *                normalised words), so the hook can count repeats without storing any text
 *   repeats()    across many sessions: every phrase said in at least `min` different sessions
 *   corrections()  the prompts that correct the agent, and what the corrected work had cost
 *
 * Shared by the parrot hook (UserPromptSubmit: hashes only) and `parrot.ts` (the report, read from
 * your local transcripts). No model call.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sha1 } from '../util.ts'
import { words } from './ballast.ts'
import * as trace from './trace.ts'

export type Kind = 'rule' | 'correction' | 'prompt'

export type Phrase = { key: string, kind: Kind, text: string }

const RULE = /^(always|never|don'?t|do not|dont|make sure|remember|avoid|prefer|stop|keep|no more|only|from now on|going forward|use \S+(?: \S+)? (?:not|instead|rather))\b|\b(instead of|rather than)\b/
export const CORRECTION = /^(no\b|nope|actually|wait\b|that'?s (not|wrong)|still\b|you (didn'?t|missed|forgot)|why did you|undo|revert|not what|try again|that didn'?t|i said|i told you|again[, ]+(you|it))/
const LEAD = /^(?:please|pls|and|also|so|ok(?:ay)?|but)\b[ ,]*/
const MIN_WORDS = 3
const MAX_WORDS = 40

/** Lower case, punctuation to spaces, numbers and paths kept, filler at the start dropped. */
export function normalise(s: string): string {
  let out = s.toLowerCase().replace(/[‘’]/g, "'").replace(/[`"“”*_>#]/g, ' ').replace(/[^a-z0-9'./:@+-]+/g, ' ').replace(/\s+/g, ' ').trim()
  out = out.replace(/[.:;!?,]+$/, '')
  for (let i = 0; i < 3 && LEAD.test(out); i++) out = out.replace(LEAD, '')
  return out.trim()
}

const keyOf = (ns: string, norm: string) => sha1(`${ns}\u0000${norm}`).slice(0, 16)
const wordCount = (s: string) => s.split(' ').filter(Boolean).length

/** Sentences of a prompt: its lines, split again at sentence ends, list markers dropped. */
export function sentences(prompt: string): string[] {
  const out: string[] = []
  for (const line of prompt.split(/\r?\n/)) {
    const l = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()
    if (!l || l.startsWith('```')) continue
    for (const s of l.split(/(?<=[.!?;])\s+(?=[A-Za-z])/)) if (s.trim()) out.push(s.trim())
  }
  return out
}

/** The phrases in one prompt worth counting across sessions. */
export function phrases(prompt: string): Phrase[] {
  const text = prompt.trim()
  if (!text || text.startsWith('/') || text.length > 20_000) return []
  const out: Phrase[] = []
  const seen = new Set<string>()
  sentences(text).forEach((s, i) => {
    const norm = normalise(s)
    const w = wordCount(norm)
    if (w < MIN_WORDS || w > MAX_WORDS) return
    const kind: Kind | null = i === 0 && CORRECTION.test(norm) ? 'correction' : RULE.test(norm) ? 'rule' : null
    if (!kind) return
    const key = keyOf('s', norm)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ key, kind, text: s.slice(0, 160) })
  })
  const whole = normalise(text.replace(/\s+/g, ' '))
  if (wordCount(whole) >= 6 && whole.length <= 600) out.push({ key: keyOf('p', whole), kind: 'prompt', text: text.replace(/\s+/g, ' ').slice(0, 160) })
  return out
}

export type Repeat = {
  key: string
  kind: Kind
  text: string                // as you first wrote it (from your own transcripts; never stored)
  sessions: number            // different sessions it was said in
  times: number               // times said in all
  projects: string[]          // working folders
  last: number | null         // seconds
  in_instructions: boolean    // already in the project's CLAUDE.md / AGENTS.md, and still repeated
  suggestion: string
}

/** A slash-command file name from a prompt's first few content words. */
export function commandName(text: string): string {
  const w = [...words(text)].slice(0, 3)
  return (w.join('-') || 'my-prompt').replace(/[^a-z0-9-]/g, '').slice(0, 40)
}

const INSTRUCTION_FILES = ['CLAUDE.md', join('.claude', 'CLAUDE.md'), 'CLAUDE.local.md', 'AGENTS.md']

/** Normalised text of a project's instruction files ('' when there are none). */
export function instructionsText(cwd: string | null): string {
  if (!cwd) return ''
  let out = ''
  for (const f of INSTRUCTION_FILES) {
    const p = join(cwd, f)
    try {
      if (existsSync(p)) out += ' ' + normalise(readFileSync(p, 'utf8').replace(/\s+/g, ' '))
    } catch {
      // unreadable: treat as absent
    }
  }
  return out
}

/** Every phrase said in at least `min` different sessions, most sessions first. */
export function repeats(traces: trace.Trace[], min = 3, instructions: (cwd: string | null) => string = instructionsText): Repeat[] {
  const acc = new Map<string, { kind: Kind, text: string, sessions: Set<string>, times: number, projects: Set<string>, last: number | null, norm: string }>()
  traces.forEach((t, ti) => {
    const sid = t.sessionId ?? `#${ti}`
    for (const p of t.prompts) {
      for (const ph of phrases(p.text)) {
        const a = acc.get(ph.key) ?? { kind: ph.kind, text: ph.text, sessions: new Set(), times: 0, projects: new Set(), last: null,
          norm: normalise(ph.text) }
        if (ph.kind === 'correction') a.kind = 'correction'
        a.sessions.add(sid)
        a.times++
        if (t.cwd) a.projects.add(t.cwd)
        if (p.ts !== null && (a.last === null || p.ts > a.last)) a.last = p.ts
        acc.set(ph.key, a)
      }
    }
  })
  const cache = new Map<string, string>()
  const instr = (cwd: string) => {
    if (!cache.has(cwd)) cache.set(cwd, instructions(cwd))
    return cache.get(cwd)!
  }
  const out: Repeat[] = []
  for (const [key, a] of acc) {
    if (a.sessions.size < min) continue
    const projects = [...a.projects]
    const inInstr = a.kind !== 'prompt' && projects.some((c) => instr(c).includes(a.norm))
    const suggestion = a.kind === 'prompt'
      ? `Save it as a slash command: put the prompt in .claude/commands/${commandName(a.text)}.md and type /${commandName(a.text)}.`
      : inInstr
        ? 'It is already in your instruction file, yet you keep saying it: check the file loads (/memory), and make the line short, specific and near the top.'
        : `Add one line to CLAUDE.md: "- ${a.text.replace(/^\s*(?:please|pls)\s+/i, '').replace(/^\s*(?:no|nope|actually)[, ]+/i, '').replace(/\s+/g, ' ').trim()}"`
    out.push({ key, kind: a.kind, text: a.text, sessions: a.sessions.size, times: a.times, projects, last: a.last, in_instructions: inInstr, suggestion })
  }
  return out.sort((a, b) => b.sessions - a.sessions || b.times - a.times)
}

export type Correction = { prompt: number, text: string, usd: number }

/** Prompts that correct the agent, with the cost of the main-thread work just before each (the work corrected). */
export function corrections(t: trace.Trace): Correction[] {
  const out: Correction[] = []
  t.prompts.forEach((p, k) => {
    if (k === 0 || !CORRECTION.test(normalise(sentences(p.text)[0] ?? ''))) return
    const from = t.prompts[k - 1].turn
    let usd = 0
    for (let j = from; j < p.turn && j < t.turns.length; j++) usd += t.turns[j].costUsd
    out.push({ prompt: k, text: p.text.replace(/\s+/g, ' ').slice(0, 100), usd: Math.round(usd * 1e6) / 1e6 })
  })
  return out
}
