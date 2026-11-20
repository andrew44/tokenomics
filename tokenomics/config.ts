/**
 * Shared configuration. Read once per hook run from environment variables.
 *
 * Everything here applies to every platform. Platform-specific settings live in the adapter
 * that needs them, so changing one platform's settings cannot affect the other.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_LLM_URL = 'https://api.openai.com/v1/chat/completions'

function floatEnv(name: string, fallback: number, cap: number): number {
  const v = Number(process.env[name] ?? String(fallback))
  return Number.isFinite(v) ? Math.min(v, cap) : fallback
}

function loadSkillMap(path: string): Record<string, string> {
  try {
    if (path && existsSync(path) && statSync(path).isFile()) {
      const data = JSON.parse(readFileSync(path, 'utf8'))
      return Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k).toLowerCase(), String(v).toLowerCase()]))
    }
  } catch {
    // a broken map is ignored
  }
  return {}
}

export function defaultDbPath(): string {
  return process.env.TOKENOMICS_DB || join(homedir(), '.tokenomics', 'spendlens.db')
}

export type Settings = {
  dbPath: string
  storePrompt: boolean
  skillMap: Record<string, string>
  llmEnabled: boolean
  llmUrl: string
  llmKey: string
  llmModel: string
  /** seconds */
  llmTimeout: number
}

export function settings(over: Partial<Settings> & { dbPath: string }): Settings {
  return {
    storePrompt: false, skillMap: {}, llmEnabled: false, llmUrl: DEFAULT_LLM_URL, llmKey: '',
    llmModel: 'gpt-4o-mini', llmTimeout: 12, ...over,
  }
}

export function llmUsable(s: Settings): boolean {
  if (!s.llmEnabled) return false
  return Boolean(s.llmKey) || s.llmUrl !== DEFAULT_LLM_URL      // local endpoints need no key
}

export function loadSettings(): Settings {
  const e = process.env
  return settings({
    dbPath: defaultDbPath(),
    storePrompt: e.TOKENOMICS_STORE_PROMPT === '1',
    skillMap: loadSkillMap(e.TOKENOMICS_SKILL_MAP ?? ''),
    llmEnabled: e.TOKENOMICS_LLM === '1',
    llmUrl: e.TOKENOMICS_LLM_URL ?? DEFAULT_LLM_URL,
    llmKey: e.TOKENOMICS_LLM_KEY || e.OPENAI_API_KEY || '',
    llmModel: e.TOKENOMICS_LLM_MODEL ?? 'gpt-4o-mini',
    llmTimeout: floatEnv('TOKENOMICS_LLM_TIMEOUT', 12, 15),
  })
}
