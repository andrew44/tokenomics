/**
 * Engine entry points called by the hook runner. Platform-agnostic.
 *
 * recordPrompt  - every user prompt (all platforms)
 * recordTool    - every tool call, for platforms that expose tool events but no transcript
 * finalize      - turn end / session end: classify the whole session and log it by session id
 *
 * The engine asks the adapter what the platform supports and degrades gracefully:
 *   transcript available  -> full replay, scores replace the running totals
 *   transcript expected but missing -> keep running totals, refresh the label
 *   no transcript at all  -> rebuild from the prompt and tool events stored for the session
 */
import { llmUsable, type Settings } from '../config.ts'
import type { PlatformAdapter } from '../platform/adapter.ts'
import { Capability } from '../platform/capabilities.ts'
import { errText, logErr, type Obj } from '../util.ts'
import { classify, classifyPrompt, labelFor, scoreTool, type SkillDetail } from './classifier.ts'
import type { Db } from './db.ts'
import { BILLING_ANTHROPIC_TOKENS, prompt, type SessionEvidence } from './evidence.ts'
import * as llm from './llm.ts'
import { sessionCostUsd } from './pricing.ts'
import * as store from './store.ts'

export function recordPrompt(adapter: PlatformAdapter, payload: Obj, s: Settings): SessionEvidence {
  const ev = adapter.promptEvidence(payload)
  const prompts = ev.prompts.length ? ev.prompts : [prompt('')]
  const db = store.connect(s.dbPath)
  try {
    db.transaction(() => {
      for (const p of prompts) {
        const [o, c, lab] = classifyPrompt(p)
        store.addPromptEvent(db, ev.sessionId, o, c, lab, s.storePrompt ? p.text.slice(0, 200) : null)
        store.upsert(db, ev.sessionId, adapter.name, ev.cwd, o, c, 1, false, labelFor)
      }
      store.setBilling(db, ev.sessionId, adapter.billingModel)
    })
  } finally {
    db.close()
  }
  return ev
}

export function recordTool(adapter: PlatformAdapter, payload: Obj, s: Settings): void {
  if (!adapter.supports(Capability.TOOL_EVENTS)) return
  const call = adapter.toolCall(payload)
  if (call === null) return
  const sid = adapter.sessionId(payload)
  const [o, c] = scoreTool(call)
  const db = store.connect(s.dbPath)
  try {
    db.transaction(() => {
      store.addToolEvent(db, sid, call.name, call.kind, call.skill, o, c)
      store.upsert(db, sid, adapter.name, payload.cwd ?? null, o, c, 0, false, labelFor)
      store.setBilling(db, sid, adapter.billingModel)
    })
  } finally {
    db.close()
  }
}

export async function finalize(adapter: PlatformAdapter, payload: Obj, s: Settings): Promise<void> {
  const ev = adapter.supports(Capability.TRANSCRIPT) ? adapter.sessionEvidence(payload) : null
  const db = store.connect(s.dbPath)
  try {
    if (ev !== null) {
      await finalizeReplay(db, adapter, ev, s)
    } else if (adapter.supports(Capability.TRANSCRIPT)) {
      const base = adapter.baseEvidence(payload, 'finalize')
      db.transaction(() => {
        store.refreshLabel(db, base.sessionId, labelFor)
        store.setBilling(db, base.sessionId, adapter.billingModel)
      })
    } else {
      await finalizeEvents(db, adapter, adapter.baseEvidence(payload, 'finalize'), s)
    }
  } finally {
    db.close()
  }
}

async function finalizeReplay(db: Db, adapter: PlatformAdapter, ev: SessionEvidence, s: Settings): Promise<void> {
  const cls = classify(ev, s.skillMap)
  const usage = adapter.supports(Capability.TOKEN_USAGE) ? ev.usage : null
  db.transaction(() => {
    store.upsert(db, ev.sessionId, adapter.name, ev.cwd, cls.opexScore, cls.capexScore, cls.promptCount, true, labelFor)
    store.writeDetails(db, ev.sessionId, cls, usage, adapter.billingModel, 'transcript')
    if (usage !== null && ev.usageRecords.length && adapter.billingModel === BILLING_ANTHROPIC_TOKENS) {
      store.setCost(db, ev.sessionId, sessionCostUsd(ev.usageRecords), ev.model)
    }
  })
  // the keyword result is already saved before any network call
  const prompts = ev.prompts.map((p) => p.llmText).filter((t): t is string => Boolean(t)).slice(0, 5)
  await llmStep(db, ev.sessionId, ev.event, prompts, ev.toolCalls.map((t) => t.name), cls.skillDetail, s)
}

async function finalizeEvents(db: Db, adapter: PlatformAdapter, base: SessionEvidence, s: Settings): Promise<void> {
  const sid = base.sessionId
  const [po, pc, n] = store.promptTotals(db, sid)
  const rows = store.toolRows(db, sid)
  const to = rows.reduce((a, r) => a + (r.opex_score || 0), 0)
  const tc = rows.reduce((a, r) => a + (r.capex_score || 0), 0)
  for (const name of new Set(rows.map((r) => r.skill).filter((x): x is string => Boolean(x)))) {
    base.skills.push({ name, description: adapter.skillDescription(name, base.cwd) })
  }
  const cls = classify(base, s.skillMap, [po + to, pc + tc, n])
  db.transaction(() => {
    store.upsert(db, sid, adapter.name, base.cwd, cls.opexScore, cls.capexScore, n, true, labelFor)
    store.writeDetails(db, sid, cls, null, adapter.billingModel, 'hook-events')
  })
  const prompts = s.storePrompt ? store.promptExcerpts(db, sid) : []
  await llmStep(db, sid, base.event, prompts, rows.map((r) => r.tool), cls.skillDetail, s)
}

/** At most one LLM call per distinct input; on any failure the keyword label stands. */
async function llmStep(db: Db, sid: string, event: string, prompts: string[], toolNames: string[],
  skillDetail: SkillDetail[], s: Settings): Promise<void> {
  if (!(llmUsable(s) && prompts.length)) return
  const payload = llm.buildInput(prompts, toolNames, skillDetail)
  const h = llm.inputHash(payload)
  const row = store.llmState(db, sid)
  if (row && row.llm_input_hash === h) return            // nothing new since the last classification
  if (event === 'turn_end' && row && row.llm_label) return  // turn end fires every turn: classify early once
  let res: store.LlmResult
  try {
    res = await llm.client.call(payload, s)
  } catch (e) {
    logErr(s.dbPath, `llm classify failed (${errText(e).split('\n')[0]})`)
    return
  }
  store.writeLlm(db, sid, res, h)
}
