/**
 * Claude Code adapter: hook payloads + JSONL transcript -> engine evidence.
 *
 * Translation only. Scoring, labelling and storage live in tokenomics/engine.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  addUsage, prompt, TOOL_CODE_EDIT, TOOL_OTHER, TOOL_READ, TOOL_SHELL, TOOL_SKILL, toolCall, tokenUsage,
  type SessionEvidence, type ToolCall, type TokenUsage,
} from '../engine/evidence.ts'
import { PlatformAdapter, type LifecycleEvent } from '../platform/adapter.ts'
import { BILLING_ANTHROPIC_TOKENS, Capability, NATIVE, NONE, PARTIAL, support } from '../platform/capabilities.ts'
import { first, frontmatterDescription, int, isObj, walkStrings, type Obj } from '../util.ts'
import { findFiles, isDir, isFile } from './fsutil.ts'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const CMD_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/
const LISTING_RE = /^- ([A-Za-z0-9_.:-]+): (.{12,})$/gm

function userText(msg: Obj): string {
  const content = msg?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.filter((p) => isObj(p) && p.type === 'text').map((p) => p.text ?? '').join(' ')
  }
  return ''
}

function toUsage(u: Obj): TokenUsage {
  const cc = isObj(u.cache_creation) ? u.cache_creation : {}
  return tokenUsage({
    inputTokens: int(u.input_tokens),
    outputTokens: int(u.output_tokens),
    cacheCreationTokens: int(u.cache_creation_input_tokens),
    cacheReadTokens: int(u.cache_read_input_tokens),
    cacheCreation1hTokens: int(cc.ephemeral_1h_input_tokens),
    fast: u.speed === 'fast',
  })
}

export class ClaudeCodeAdapter extends PlatformAdapter {
  override name = 'claude-code'
  override billingModel = BILLING_ANTHROPIC_TOKENS
  override capabilities = {
    [Capability.HOOKS]: support(NATIVE, 'UserPromptSubmit, Stop, SessionStart, SessionEnd, Pre/PostToolUse'),
    [Capability.SESSION_INFO]: support(NATIVE, 'session_id in every hook payload'),
    [Capability.TRANSCRIPT]: support(NATIVE, 'transcript_path JSONL'),
    [Capability.TOKEN_USAGE]: support(NATIVE, 'usage on assistant messages in the transcript'),
    [Capability.CACHE_INFO]: support(NATIVE, 'cache_creation/cache_read_input_tokens'),
    [Capability.SKILL_TRACKING]: support(NATIVE, 'Skill tool calls and slash commands'),
    [Capability.MODEL_SELECTION]: support(PARTIAL, 'model visible in transcript and statusline payload'),
    [Capability.CONTEXT_INFO]: support(PARTIAL, 'derivable from transcript usage'),
    [Capability.CONTEXT_INJECTION]: support(NATIVE, 'UserPromptSubmit / SessionStart stdout'),
    [Capability.TOOL_OUTPUT_INTERCEPTION]: support(NATIVE, 'PostToolUse'),
    [Capability.TOOL_EVENTS]: support(NATIVE, 'not needed: the transcript has every tool call'),
    [Capability.BILLING_INFO]: support(PARTIAL, 'tokens only; prices come from a price table'),
    [Capability.AVAILABLE_MODELS]: support(NONE, ''),
  }

  override lifecycle(payload: Obj, mode: string): LifecycleEvent {
    const name = String(first(payload, ['hook_event_name', 'hookEventName'], ''))
    const map: Record<string, LifecycleEvent> = { UserPromptSubmit: 'prompt', PreToolUse: 'tool_call', PostToolUse: 'tool_result',
      Stop: 'turn_end', SubagentStop: 'turn_end', SessionStart: 'session_start', SessionEnd: 'session_end' }
    return map[name] ?? super.lifecycle(payload, mode)
  }

  override event(payload: Obj, mode: string): string {
    if (mode === 'prompt' || mode === 'tool') return mode
    const name = first(payload, ['hook_event_name', 'hookEventName'], '')
    return name === 'Stop' ? 'turn_end' : 'session_end'
  }

  // ---- transcript replay -------------------------------------------------------------
  override sessionEvidence(payload: Obj): SessionEvidence | null {
    const path = first(payload, ['transcript_path', 'transcriptPath'])
    if (!(path && isFile(String(path)))) return null
    const ev = this.baseEvidence(payload, 'finalize')
    ev.complete = true
    const listed = new Map<string, string>()
    const skillNames: string[] = []
    const usage = new Map<unknown, [string, Obj]>()   // message id -> (model, last usage); streamed entries repeat ids
    let parsed = false
    let llmCount = 0
    for (const line of readFileSync(String(path), 'utf8').split('\n')) {
      let rec: unknown
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (!isObj(rec)) continue
      parsed = true
      if (line.toLowerCase().includes('skill')) {        // skill listings: "- name: description" lines
        for (const s of walkStrings(rec)) {
          for (const m of s.matchAll(LISTING_RE)) {
            const key = m[1].toLowerCase()
            if (!listed.has(key)) listed.set(key, m[2].trim())
          }
        }
      }
      const kind = rec.type
      const msg: Obj = isObj(rec.message) ? rec.message : {}
      if (kind === 'user' && !rec.isMeta) {
        const txt = userText(msg)
        if (txt) {
          const m = CMD_RE.exec(txt)                     // slash-command skill, e.g. /grafana-triage
          if (m && !skillNames.includes(m[1])) skillNames.push(m[1])
          let llmText: string | null = null
          if (llmCount < 5 && !txt.trimStart().startsWith('<')) llmText = txt
          else if (llmCount < 5 && m) llmText = `/${m[1]}`
          if (llmText) llmCount++
          ev.prompts.push(prompt(txt, llmText, Boolean(m)))
        }
      } else if (kind === 'assistant') {
        const u = msg.usage
        const model = msg.model
        if (model && !String(model).startsWith('<')) ev.model = String(model)
        if (isObj(u)) {
          const key = msg.id || rec.uuid || usage.size
          usage.set(key, [String(model || ev.model || ''), u])
        }
      }
      if (kind === 'assistant' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (isObj(part) && part.type === 'tool_use') {
            const call = this.tool(part.name ?? '', isObj(part.input) ? part.input : {})
            ev.toolCalls.push(call)
            if (call.kind === TOOL_SKILL && call.skill && !skillNames.includes(call.skill)) skillNames.push(call.skill)
          }
        }
      }
    }
    if (!parsed) return null
    for (const sk of skillNames) {
      const bare = sk.replace(/^\/+/, '')
      const leaf = bare.split(':').at(-1)!.toLowerCase()
      const desc = this.skillDescription(sk, ev.cwd) || listed.get(bare.toLowerCase()) || listed.get(leaf) || null
      ev.skills.push({ name: sk, description: desc })
    }
    ev.usage = tokenUsage()
    for (const [model, u] of usage.values()) {
      const tu = toUsage(u)
      addUsage(ev.usage, tu)
      ev.usageRecords.push([model, tu])
    }
    return ev
  }

  tool(name: string, inp: Obj): ToolCall {
    if (name === 'Skill') return toolCall(name, TOOL_SKILL, { skill: String(inp.skill || inp.name || '') })
    if (EDIT_TOOLS.has(name)) return toolCall(name, TOOL_CODE_EDIT, { path: String(inp.file_path || inp.notebook_path || '') })
    if (name === 'Bash') return toolCall(name, TOOL_SHELL, { command: String(inp.command ?? '') })
    if (name === 'Read') {
      return toolCall(name, TOOL_READ, { path: String(inp.file_path || ''),
        ranged: (inp.offset !== undefined && inp.offset !== null) || (inp.limit !== undefined && inp.limit !== null) })
    }
    return toolCall(name, TOOL_OTHER)
  }

  override toolCall(payload: Obj): ToolCall | null {
    const name = first(payload, ['tool_name'], '')
    return name ? this.tool(String(name), isObj(payload.tool_input) ? payload.tool_input : {}) : null
  }

  // ---- hook output ---------------------------------------------------------------------
  override denyTool(reason: string): Obj {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }
  }

  override askTool(reason: string): Obj {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }
  }

  override blockPrompt(reason: string): Obj {
    return { decision: 'block', reason }
  }

  override notify(message: string): Obj {
    return { systemMessage: message }
  }

  override interrupt(reason: string): Obj {
    return { continue: false, stopReason: reason, systemMessage: reason }
  }

  override addContext(text: string): Obj {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }
  }

  // ---- skills on disk ----------------------------------------------------------------
  override skillRoots(cwd: string | null): string[] {
    return [...(cwd ? [join(cwd, '.claude')] : []), join(homedir(), '.claude')]
  }

  override skillDescription(name: string, cwd: string | null): string | null {
    const n = name.trim().replace(/^\/+/, '')
    const i = n.lastIndexOf(':')
    const plugin = i >= 0 ? n.slice(0, i) : ''
    const leaf = i >= 0 ? n.slice(i + 1) : n
    for (const r of this.skillRoots(cwd)) {
      for (const p of [join(r, 'skills', leaf, 'SKILL.md'), join(r, 'commands', `${leaf}.md`)]) {
        if (isFile(p)) {
          const d = frontmatterDescription(p)
          if (d) return d
        }
      }
    }
    const base = join(homedir(), '.claude', 'plugins')
    if (isDir(base)) {
      const hits = [
        ...findFiles(base, (rel) => rel.endsWith(`skills/${leaf}/SKILL.md`), 20),
        ...findFiles(base, (rel) => rel.endsWith(`commands/${leaf}.md`), 20),
      ]
      if (plugin) hits.sort((a, b) => Number(!a.includes(plugin)) - Number(!b.includes(plugin)))   // prefer matching plugin
      for (const p of hits) {
        const d = frontmatterDescription(p)
        if (d) return d
      }
    }
    return null
  }
}
