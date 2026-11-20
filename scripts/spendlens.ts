#!/usr/bin/env node
/**
 * tokenomics / spendlens: tag each AI coding session OPEX (run) or CAPEX (build), logged by session id.
 *
 * Thin hook runner. The logic lives in the shared engine (tokenomics/engine); the platform
 * named by [source] picks its adapter (tokenomics/adapters). Same engine for every platform.
 *
 * Usage (hook command):
 *   spendlens.ts prompt   [source]   # every user prompt   (Claude: UserPromptSubmit, Copilot: userPromptSubmitted)
 *   spendlens.ts tool     [source]   # every tool call     (Copilot: postToolUse; Claude reads its transcript instead)
 *   spendlens.ts finalize [source]   # turn / session end  (Claude: Stop, SessionEnd; Copilot: sessionEnd)
 *   spendlens.ts capabilities        # print what each platform adapter supports (JSON)
 *
 * [source] is claude-code (default) or copilot. Reads the hook JSON on stdin, prints NOTHING
 * on hook runs (UserPromptSubmit stdout is injected into the model context), and always exits 0
 * so it can never block a session. Errors go to <db>.err. Node.js 22.18+, built-ins only.
 *
 * Every run also hands the hook's lifecycle event to the TelemetryEngine (tokenomics/services/telemetry.ts),
 * which stores it in the shared event format (TOKENOMICS_TELEMETRY=off to stop).
 *
 * Settings (env): TOKENOMICS_DB, TOKENOMICS_STORE_PROMPT, TOKENOMICS_SKILL_MAP,
 * TOKENOMICS_LLM, TOKENOMICS_LLM_URL, TOKENOMICS_LLM_KEY, TOKENOMICS_LLM_MODEL, TOKENOMICS_LLM_TIMEOUT.
 * See docs/configuration.md.
 */
import { defaultDbPath, loadSettings } from '../tokenomics/config.ts'
import * as session from '../tokenomics/engine/session.ts'
import { getAdapter, report } from '../tokenomics/platform/registry.ts'
import { TelemetryEngine } from '../tokenomics/services/index.ts'
import { errText, logErr, readPayload } from '../tokenomics/util.ts'

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'prompt'
  const source = process.argv[3] ?? 'claude-code'
  try {
    if (mode === 'capabilities') {
      process.stdout.write(JSON.stringify(report(), null, 2) + '\n')
      return
    }
    const payload = readPayload()
    const settings = loadSettings()
    const adapter = getAdapter(source)
    if (mode === 'finalize') await session.finalize(adapter, payload, settings)
    else if (mode === 'tool') session.recordTool(adapter, payload, settings)
    else session.recordPrompt(adapter, payload, settings)
    TelemetryEngine.ingest(adapter, payload, mode, settings.dbPath)     // the shared event, for every platform
  } catch (e) {
    logErr(defaultDbPath(), `spendlens\n${errText(e)}`)
  }
}

await main()
process.exitCode = 0
