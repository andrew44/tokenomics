/**
 * Ballast: context a conversation keeps carrying after the work that needed it is finished.
 *
 * Every step of an agent re-sends the whole conversation. While the cache is warm that is billed as
 * cache reads (a tenth of the input price), so it feels free, but an agent makes dozens of requests
 * per task: 150,000 tokens of finished work, re-read 40 times, is 6 million tokens.
 *
 * The rules here are shared by the ballast hook (UserPromptSubmit) and `ballast.ts check` (a replay):
 *
 *   topicShift()   does a new prompt start a different task? (little vocabulary in common with the
 *                  recent prompts and the files the agent touched, or an explicit "new task" cue)
 *   carry()        a finished session replayed: at each topic shift over the threshold, what the old
 *                  context cost to keep re-reading until it was compacted, cleared or the session ended
 *
 * Words only, no model call, nothing stored.
 */
import { basename, extname } from 'node:path'

import { ratesFor } from './pricing.ts'
import * as trace from './trace.ts'

const STOP = new Set(('the a an and or but if then than so to of in on at for from by with without into onto about as is are was were be ' +
  'been being it its this that these those there here what which who whom whose when where why how can could should would will shall ' +
  'may might must do does did done doing have has had having i me my we our you your he she they them their not no yes please thanks ' +
  'thank just also too very really some any all each every more most less much many one two now then again still ok okay let lets ' +
  'make sure use using want need like get got go going see look check try add fix change update file files code thing things way ' +
  'something anything everything work works working into out up down over under after before while because same new old other').split(' '))

const CUE = /\b(new task|unrelated|different (task|topic|question|thing)|something (else|different)|change of (subject|topic)|separate (question|task|issue)|switch(ing)? (gears|topics?|tasks?)|on another note|moving on to)\b/i

/** Content words of a piece of text (lower case, no stop words, plural s dropped). */
export function words(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}/g)) {
    let w = m[0]
    if (STOP.has(w)) continue
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
    out.add(w)
  }
  return out
}

export type Shift = { shift: boolean, overlap: number, cue: boolean, words: number }

/** Does `prompt` start a different task from the conversation so far? */
export function topicShift(prompt: string, t: trace.Trace, upToTurn = Infinity, recent = 5): Shift {
  const mine = words(prompt)
  const cue = CUE.test(prompt)
  const earlier = t.prompts.filter((p) => p.turn <= upToTurn && p.text !== prompt)
  if (!earlier.length) return { shift: false, overlap: 1, cue, words: mine.size }
  const vocab = new Set<string>()
  for (const p of earlier.slice(-recent)) for (const w of words(p.text)) vocab.add(w)
  for (const s of t.steps) {
    if (s.turn > upToTurn) break
    const f = trace.filePath(s)
    if (!f) continue
    for (const part of f.split(/[\\/]/).slice(-3)) for (const w of words(basename(part, extname(part)).replace(/[-.]/g, ' '))) vocab.add(w)
  }
  let common = 0
  for (const w of mine) if (vocab.has(w)) common++
  const overlap = mine.size ? Math.round(common / mine.size * 100) / 100 : 1
  return { shift: cue || (mine.size >= 4 && overlap <= 0.15), overlap, cue, words: mine.size }
}

/** The newest main-thread request with a context size: [ctx tokens, model, ts, 1h cache?]. */
export function lastContext(t: trace.Trace, beforeTurn = Infinity): { ctx: number, model: string, ts: number | null, ttl1h: boolean } | null {
  for (let i = Math.min(t.turns.length, beforeTurn) - 1; i >= 0; i--) {
    const x = t.turns[i]
    if (!x.sidechain && x.ctx > 0) return { ctx: x.ctx, model: x.model, ts: x.ts, ttl1h: x.usage.cacheCreation1hTokens > 0 }
  }
  return null
}

/** USD to re-read `tokens` once from a warm cache on `model`. */
export function readCostUsd(tokens: number, model: string | null | undefined): number {
  return tokens * ratesFor(model).cache_read / 1e6
}

/** Average main-thread requests per prompt in this session (a "task like your last ones"), at least 1. */
export function stepsPerPrompt(t: trace.Trace): number {
  const main = t.turns.filter((x) => !x.sidechain).length
  return Math.max(1, Math.round(main / Math.max(1, t.prompts.length)))
}

export type Carry = {
  prompt: number          // index into t.prompts
  turn: number            // first turn of the new task
  ctx: number             // context carried into it
  steps: number           // requests that re-read it before compaction / the next shift / the end
  usd: number
  overlap: number
  cue: boolean
  preview: string
}

/** Replay a session: every topic shift that started with at least `minTokens` of context, and its carry cost. */
export function carry(t: trace.Trace, minTokens: number): Carry[] {
  const out: Carry[] = []
  t.prompts.forEach((p, k) => {
    if (k === 0) return
    const before = lastContext(t, p.turn)
    if (!before || before.ctx < minTokens) return
    const s = topicShift(p.text, t, p.turn - 1)
    if (!s.shift) return
    const end = t.prompts.slice(k + 1).find((q) => topicShift(q.text, t, q.turn - 1).shift)?.turn ?? t.turns.length
    let steps = 0
    let usd = 0
    let prev = before.ctx
    for (let j = p.turn; j < end; j++) {
      const x = t.turns[j]
      if (!x || x.sidechain || !x.ctx) continue
      if (x.ctx < prev * 0.5) break             // compacted or cleared: the old context is gone
      prev = x.ctx
      steps++
      usd += readCostUsd(before.ctx, x.model)
    }
    out.push({ prompt: k, turn: p.turn, ctx: before.ctx, steps, usd, overlap: s.overlap, cue: s.cue,
      preview: p.text.replace(/\s+/g, ' ').slice(0, 70) })
  })
  return out
}
