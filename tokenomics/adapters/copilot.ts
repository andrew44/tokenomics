/**
 * GitHub Copilot adapter (Copilot CLI / cloud agent hooks; VS Code-compatible payloads too).
 *
 * Translation only. Scoring, labelling and storage live in tokenomics/engine.
 *
 * What Copilot gives hooks (docs.github.com, CLI hooks reference):
 *   userPromptSubmitted  sessionId, timestamp, cwd, prompt
 *   postToolUse          sessionId, timestamp, cwd, toolName, toolArgs, toolResult
 *   sessionEnd           sessionId, timestamp, cwd, reason
 *   (PascalCase event names deliver snake_case: session_id, tool_name, tool_input ...)
 * No hook payload carries token usage, model or premium-request counts, and the transcript
 * format is undocumented, so the engine classifies Copilot sessions from prompt and tool
 * events and records usage as unavailable. Copilot bills premium requests, not tokens:
 * no money or token figure is invented for it.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { TOOL_CODE_EDIT, TOOL_OTHER, TOOL_READ, TOOL_SHELL, TOOL_SKILL, toolCall, type ToolCall } from '../engine/evidence.ts'
import { PlatformAdapter, type LifecycleEvent } from '../platform/adapter.ts'
import { BILLING_COPILOT_PREMIUM_REQUESTS, Capability, NATIVE, NONE, PARTIAL, support } from '../platform/capabilities.ts'
import { asDict, first, frontmatterDescription, isObj, type Obj } from '../util.ts'
import { isFile } from './fsutil.ts'

const EDIT_TOOLS = new Set(['edit', 'create', 'write', 'str_replace', 'apply_patch', 'multi_edit',
  'edit_file', 'create_file', 'replace_string_in_file', 'insert_edit_into_file',
  'multi_replace_string_in_file', 'editfiles', 'createfile'])
const SHELL_TOOLS = new Set(['bash', 'shell', 'powershell', 'run_in_terminal', 'runinterminal', 'terminal'])
const SKILL_TOOLS = new Set(['skill', 'use_skill'])
const READ_TOOLS = new Set(['view', 'read', 'read_file', 'readfile'])
const RANGE_KEYS = ['view_range', 'startLine', 'start_line', 'offset', 'limit', 'endLine', 'end_line']

export class CopilotAdapter extends PlatformAdapter {
  override name = 'copilot'
  override billingModel = BILLING_COPILOT_PREMIUM_REQUESTS
  override capabilities = {
    [Capability.HOOKS]: support(NATIVE, 'userPromptSubmitted, preToolUse, postToolUse, sessionStart, sessionEnd'),
    [Capability.SESSION_INFO]: support(NATIVE, 'sessionId / session_id in every hook payload'),
    [Capability.TOOL_EVENTS]: support(NATIVE, 'postToolUse: toolName + toolArgs'),
    [Capability.SKILL_TRACKING]: support(PARTIAL, 'only if skill use surfaces as a tool call'),
    [Capability.TRANSCRIPT]: support(NONE, 'sessionEnd has no transcript; format undocumented'),
    [Capability.TOKEN_USAGE]: support(NONE, 'not exposed to hooks'),
    [Capability.CACHE_INFO]: support(NONE, 'not exposed to hooks'),
    [Capability.BILLING_INFO]: support(NONE, 'premium requests; not exposed to hooks'),
    [Capability.MODEL_SELECTION]: support(NONE, 'no model field in hook payloads'),
    [Capability.CONTEXT_INFO]: support(NONE, ''),
    [Capability.CONTEXT_INJECTION]: support(NONE, 'userPromptSubmitted output is ignored'),
    [Capability.TOOL_OUTPUT_INTERCEPTION]: support(PARTIAL, 'postToolUse sees results, cannot rewrite them; ' +
      'preToolUse can deny a call'),
    [Capability.AVAILABLE_MODELS]: support(NONE, ''),
  }

  override toolCall(payload: Obj): ToolCall | null {
    const name = String(first(payload, ['toolName', 'tool_name'], '') || '')
    if (!name) return null
    const args = asDict(first(payload, ['toolArgs', 'tool_input', 'toolInput'], {}))
    const key = name.trim().toLowerCase().split('.').at(-1)!.split('/').at(-1)!
    if (SKILL_TOOLS.has(key)) return toolCall(name, TOOL_SKILL, { skill: String(args.skill || args.name || '') })
    if (key === 'str_replace_editor') {
      const sub = String(args.command || '').toLowerCase()
      return sub === 'view' ? CopilotAdapter.read(name, args) : CopilotAdapter.edit(name, args)
    }
    if (READ_TOOLS.has(key)) return CopilotAdapter.read(name, args)
    if (EDIT_TOOLS.has(key)) return CopilotAdapter.edit(name, args)
    if (SHELL_TOOLS.has(key)) return toolCall(name, TOOL_SHELL, { command: String(args.command || args.cmd || '') })
    return toolCall(name, TOOL_OTHER)
  }

  static edit(name: string, args: Obj): ToolCall {
    return toolCall(name, TOOL_CODE_EDIT, { path: String(first(args, ['path', 'file_path', 'filePath'], '') || '') })
  }

  override lifecycle(payload: Obj, mode: string): LifecycleEvent {
    const name = String(first(payload, ['hookEventName', 'hook_event_name'], '')).toLowerCase()
    const map: Record<string, LifecycleEvent> = { userpromptsubmitted: 'prompt', userpromptsubmit: 'prompt', pretooluse: 'tool_call',
      posttooluse: 'tool_result', sessionstart: 'session_start', sessionend: 'session_end', stop: 'turn_end' }
    if (map[name]) return map[name]
    if (mode === 'tool') return 'tool_result'                 // spendlens tool runs on postToolUse
    return super.lifecycle(payload, mode)
  }

  /** postToolUse: did the call succeed? (toolResult.resultType 'success'); null when not reported. */
  override toolOk(payload: Obj): boolean | null {
    const r = first(payload, ['toolResult', 'tool_result', 'tool_response'])
    const t = isObj(r) ? String(r.resultType ?? r.result_type ?? '') : ''
    return t ? t.toLowerCase() === 'success' : null
  }

  static read(name: string, args: Obj): ToolCall {
    const path = String(first(args, ['path', 'file_path', 'filePath'], '') || '')
    const ranged = RANGE_KEYS.some((k) => args[k] !== undefined && args[k] !== null)
    return toolCall(name, TOOL_READ, { path, ranged })
  }

  override denyTool(reason: string): Obj {
    return { permissionDecision: 'deny', permissionDecisionReason: reason }   // preToolUse
  }

  override skillRoots(cwd: string | null): string[] {
    return [...(cwd ? [join(cwd, '.github'), join(cwd, '.claude')] : []), join(homedir(), '.copilot')]
  }

  override skillDescription(name: string, cwd: string | null): string | null {
    const leaf = name.trim().replace(/^\/+/, '').split(':').at(-1)!
    for (const r of this.skillRoots(cwd)) {
      for (const p of [join(r, 'skills', leaf, 'SKILL.md'), join(r, 'prompts', `${leaf}.prompt.md`)]) {
        if (isFile(p)) {
          const d = frontmatterDescription(p)
          if (d) return d
        }
      }
    }
    return null
  }
}
