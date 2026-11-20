/**
 * Capabilities a platform adapter can expose to the shared engine.
 *
 * The engine never assumes a feature exists: it asks the adapter (`adapter.supports(...)`).
 * Each adapter declares a level for every capability, so an unsupported feature is a known,
 * reportable gap rather than a crash.
 */
export { BILLING_ANTHROPIC_TOKENS, BILLING_COPILOT_PREMIUM_REQUESTS, BILLING_UNKNOWN } from '../engine/evidence.ts'

export const Capability = {
  AVAILABLE_MODELS: 'available_models',          // can list the models on offer
  MODEL_SELECTION: 'model_selection',            // can tell / change which model is used
  CONTEXT_INFO: 'context_info',                  // context window size and fill
  TOKEN_USAGE: 'token_usage',                    // per-session input/output token counts
  CACHE_INFO: 'cache_info',                      // prompt-cache read/creation tokens
  TOOL_OUTPUT_INTERCEPTION: 'tool_output_interception',
  HOOKS: 'hooks',                                // lifecycle hooks exist at all
  BILLING_INFO: 'billing_info',                  // money / premium-request consumption
  SESSION_INFO: 'session_info',                  // a real session id in hook payloads
  TRANSCRIPT: 'transcript',                      // a readable, documented session transcript
  TOOL_EVENTS: 'tool_events',                    // per-tool-call hook events
  SKILL_TRACKING: 'skill_tracking',              // can see which skills were used
  CONTEXT_INJECTION: 'context_injection',        // hook output reaches the model
} as const
export type Capability = typeof Capability[keyof typeof Capability]
export const ALL_CAPABILITIES = Object.values(Capability) as Capability[]

export const Level = {
  NATIVE: 'native',        // provided by the platform, reliable
  PARTIAL: 'partial',      // available but incomplete, best effort or undocumented
  NONE: 'none',            // not available: the engine must degrade gracefully
} as const
export type Level = typeof Level[keyof typeof Level]

export const NATIVE = Level.NATIVE
export const PARTIAL = Level.PARTIAL
export const NONE = Level.NONE

export type Support = { readonly level: Level, readonly note: string }

export function support(level: Level, note = ''): Support {
  return Object.freeze({ level, note })
}

export function available(s: Support): boolean {
  return s.level !== NONE
}
