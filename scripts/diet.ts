#!/usr/bin/env node
/**
 * tokenomics / diet: stop tool calls that would flood the context with low-value text.
 *
 * Pre-tool hook (Claude Code: PreToolUse on Read|Bash; Copilot: preToolUse). Denies, with a
 * reason the model acts on, things like reading package-lock.json whole, `kubectl logs` with no
 * --tail, `git log` with no -n, `cat` of a 2 MB file or `ls -R`. The model then retries with a
 * narrower call. Commands that already pipe, redirect or limit their output are left alone.
 *
 * Usage (hook command):  diet.ts [source]      source = claude-code (default) | copilot
 *
 * Env:
 *   TOKENOMICS_DIET         block (default) | warn (notice only, never denies) | off
 *   TOKENOMICS_DIET_MAX_KB  files below this size are never blocked (default 64)
 * Bypass for one command: append `# diet-ok`. Rules: tokenomics/engine/diet.ts.
 * Always exits 0; a crash never blocks a tool call (errors go to <db>.err).
 */
import { defaultDbPath, loadSettings } from '../tokenomics/config.ts'
import * as diet from '../tokenomics/engine/diet.ts'
import * as events from '../tokenomics/engine/events.ts'
import { getAdapter } from '../tokenomics/platform/registry.ts'
import { errText, logErr, readPayload } from '../tokenomics/util.ts'

function main(): void {
  const source = process.argv[2] ?? 'claude-code'
  const mode = (process.env.TOKENOMICS_DIET ?? 'block').trim().toLowerCase()
  try {
    if (mode === 'off') return
    const payload = readPayload()
    const adapter = getAdapter(source)
    const call = adapter.toolCall(payload)
    if (call === null) return
    const verdict = diet.check(call, payload.cwd ?? null)
    if (verdict === null) return
    const action = mode === 'warn' ? 'warned' : 'denied'
    const out = action === 'warned' ? adapter.notify(verdict.reason) : adapter.denyTool(verdict.reason)
    events.log(loadSettings().dbPath, 'diet_events', { session_id: adapter.sessionId(payload), source: adapter.name,
      tool: call.name, rule: verdict.rule, est_tokens: verdict.estTokens, action })
    if (out) process.stdout.write(JSON.stringify(out) + '\n')
  } catch (e) {
    logErr(defaultDbPath(), `diet\n${errText(e)}`)
  }
}

main()
process.exitCode = 0
