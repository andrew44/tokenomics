/**
 * The engine's platform-neutral session schema.
 *
 * Every adapter produces these objects; the engine only ever reads these, never raw
 * platform payloads. Usage is null when the platform does not report it (never zero-filled).
 */

// Billing models. Kept distinct on purpose: Anthropic bills tokens, Copilot bills premium
// requests. The engine never converts one into the other or invents a money value.
// Defined here (not in tokenomics/platform) so the engine loads without the platform layer;
// tokenomics/platform/capabilities.ts re-exports them.
export const BILLING_ANTHROPIC_TOKENS = 'anthropic_tokens'
export const BILLING_COPILOT_PREMIUM_REQUESTS = 'copilot_premium_requests'
export const BILLING_UNKNOWN = 'unknown'

// Normalised tool kinds. Adapters map their platform's tool names onto these.
export const TOOL_CODE_EDIT = 'code_edit'      // writes or edits files
export const TOOL_SHELL = 'shell'              // runs a command (command text is scored, never stored)
export const TOOL_SKILL = 'skill'              // invokes a skill
export const TOOL_READ = 'read'                // reads a file (path is checked by the context diet, never stored)
export const TOOL_OTHER = 'other'              // anything else (MCP tools etc.; the name is still checked)

export type ToolCall = {
  name: string
  kind: string
  command: string       // shell only
  skill: string         // skill only
  path: string          // read and code_edit: the file it touches (checked, never stored as content)
  ranged: boolean       // read only: an offset/limit (part of the file) was asked for
}

export function toolCall(name: string, kind: string = TOOL_OTHER, extra: Partial<ToolCall> = {}): ToolCall {
  return { name, kind, command: '', skill: '', path: '', ranged: false, ...extra }
}

export type SkillUse = { name: string, description: string | null }

export type Prompt = {
  text: string                  // used for keyword scoring
  llmText: string | null        // what may be sent to the LLM classifier; null = never send
  isCommand: boolean            // slash-command invocation (counts as a prompt, not as prose)
}

/** llmText defaults to the text itself. */
export function prompt(text: string, llmText?: string | null, isCommand = false): Prompt {
  return { text, llmText: llmText === undefined || llmText === '' ? text : llmText, isCommand }
}

export type TokenUsage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  cacheCreation1hTokens: number   // the part of cacheCreationTokens written with the 1-hour TTL
  fast: boolean                   // served in fast mode (priced higher); per request only
}

export function tokenUsage(u: Partial<TokenUsage> = {}): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0,
    cacheCreation1hTokens: 0, fast: false, ...u }
}

export function addUsage(into: TokenUsage, other: TokenUsage): void {
  into.inputTokens += other.inputTokens
  into.outputTokens += other.outputTokens
  into.cacheCreationTokens += other.cacheCreationTokens
  into.cacheReadTokens += other.cacheReadTokens
  into.cacheCreation1hTokens += other.cacheCreation1hTokens
}

export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens
}

export type SessionEvidence = {
  sessionId: string
  platform: string
  cwd: string | null
  event: string                 // prompt | tool | turn_end | session_end
  complete: boolean             // true = full replay of the session (scores replace stored ones)
  prompts: Prompt[]
  toolCalls: ToolCall[]
  skills: SkillUse[]
  usage: TokenUsage | null
  usageRecords: [string, TokenUsage][]   // (model, usage) per request
  model: string | null          // last model used
  billingModel: string
}

export function sessionEvidence(e: Partial<SessionEvidence> & { sessionId: string, platform: string }): SessionEvidence {
  return { cwd: null, event: 'prompt', complete: false, prompts: [], toolCalls: [], skills: [], usage: null,
    usageRecords: [], model: null, billingModel: BILLING_UNKNOWN, ...e }
}
