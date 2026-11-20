#!/usr/bin/env node
/**
 * Checks a real one-line install end to end. Run by .github/workflows/installer.yml on macOS,
 * Windows and Linux right after `install.sh` / `install.ps1`; not part of the unit tests.
 *
 *   node installer_check.ts [--expect-private-node] [--expect-plugin-log FILE]
 *
 * It checks what the installer left behind, then runs every Claude Code hook *the way Claude Code
 * does*: the command string from hooks/hooks.json through bash (Git Bash on Windows) with
 * CLAUDE_PLUGIN_ROOT set. On Windows it also runs the Copilot PowerShell hook strings. Finally it
 * exercises the `tokenomics` command and uninstalls. Exits non-zero on the first failure.
 * Self-contained (Node.js built-ins only), so CI can download and run this one file.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

const WINDOWS = process.platform === 'win32'
const HOME = homedir()
const TK = process.env.TOKENOMICS_HOME || join(HOME, '.tokenomics')
const APP = join(TK, 'app')
const CLAUDE_SETTINGS = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'settings.json')
let step = 0

function ok(cond: unknown, what: string, detail = ''): void {
  step++
  process.stdout.write(`${cond ? 'PASS' : 'FAIL'} ${String(step).padStart(2)}. ${what}` + (detail && !cond ? `\n        ${detail}` : '') + '\n')
  if (!cond) process.exit(1)
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile()

function which(cmd: string): string | null {
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const exts = !WINDOWS ? [''] : pathext.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase())) ? [''] : pathext   // as cmd.exe resolves it
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const ext of exts) if (dir && isFile(join(dir, cmd + ext))) return join(dir, cmd + ext)
  }
  return null
}

function bash(): string | null {
  if (WINDOWS) {   // what Claude Code uses on Windows; plain `bash` on PATH can be WSL's
    for (const p of ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']) if (isFile(p)) return p
  }
  return which('bash')
}

function tokenomics(...args: string[]) {
  const launcher = which('tokenomics')
  if (launcher === null) ok(false, "'tokenomics' command is on PATH", process.env.PATH ?? '')
  return spawnSync(launcher!, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, shell: WINDOWS })
}

const sqlite = () => process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite')

async function main(args: string[]): Promise<void> {
  // 1. What the installer left behind
  ok(isFile(join(APP, 'scripts', 'cli.ts')), 'tokenomics downloaded to ~/.tokenomics/app')
  const cached = isFile(join(TK, 'node')) ? readFileSync(join(TK, 'node'), 'utf8').trim() : ''
  ok(cached && isFile(cached), 'installer recorded a working Node.js', cached)
  if (args.includes('--expect-private-node')) ok(cached.replaceAll('\\', '/').includes('runtime'), 'the private Node.js was used', cached)
  const v = spawnSync(cached, ['-p', 'const [a,b]=process.versions.node.split(".").map(Number);a>22||(a===22&&b>=18)'], { encoding: 'utf8' })
  ok(v.stdout.trim() === 'true', 'recorded Node.js is 22.18+', v.stdout + v.stderr)

  const settings = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))
  const cmd: string = settings.statusLine?.command ?? ''
  ok(cmd.includes('statusline.mts'), 'statusline is set in Claude Code settings', JSON.stringify(settings))
  const logArg = args.indexOf('--expect-plugin-log')
  if (logArg >= 0) {
    const log = readFileSync(args[logArg + 1], 'utf8')
    ok(log.includes('plugin install tokenomics@tokenomics'), 'the installer added the Claude Code plugin', log)
  }

  // 2. The statusline renders through the exact command written to settings.json
  const sb = spawnSync(cmd, { shell: true, input: JSON.stringify({ model: { display_name: 'Opus' }, context_window: { used_percentage: 40 } }),
    encoding: 'utf8', timeout: 60_000 })
  ok(sb.status === 0 && sb.stdout.includes('Opus'), 'statusline renders', sb.stdout + sb.stderr)

  // 3. Every Claude Code hook, run as Claude Code runs it
  const hooks = JSON.parse(readFileSync(join(APP, 'hooks', 'hooks.json'), 'utf8')).hooks
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: APP }       // native path, as Claude Code passes it
  const sid = `ci-${Math.floor(Date.now() / 1000)}`
  const payload = { session_id: sid, cwd: HOME, transcript_path: join(HOME, 'none.jsonl'), prompt: 'fix the failing deploy pipeline',
    tool_name: 'Read', tool_input: { file_path: join(HOME, 'x.txt') } }
  const sh = bash()
  ok(sh !== null, 'bash (Git Bash on Windows) is available')
  for (const [event, groups] of Object.entries<any[]>(hooks)) {
    for (const g of groups) {
      for (const h of g.hooks) {
        const p = spawnSync(sh!, ['-c', h.command], { input: JSON.stringify({ ...payload, hook_event_name: event }), encoding: 'utf8', env, timeout: 60_000 })
        ok((p.status === 0 || p.status === 2) && !p.stderr.includes('not found') && !p.stderr.includes('Warning'),
          `hook ${event}: ${h.command.split('run.sh').at(-1).replace(/^[\s"]+|[\s"]+$/g, '')}`, p.stdout + p.stderr)
      }
    }
  }
  const dbPath = join(TK, 'spendlens.db')
  ok(isFile(dbPath), 'spendlens recorded to ~/.tokenomics/spendlens.db')
  const db: DatabaseSync = new (sqlite().DatabaseSync)(dbPath)
  const n = (db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE session_id=?').get(sid) as { n: number }).n
  db.close()
  ok(n === 1, 'the hook-run session is in the database', String(n))

  // 4. Copilot's PowerShell hook strings (Windows only)
  if (WINDOWS) {
    const cp = JSON.parse(readFileSync(join(APP, 'copilot-hooks.json'), 'utf8')).hooks
    const h = cp.userPromptSubmitted[0]
    const p = spawnSync('powershell', ['-NoProfile', '-Command', h.powershell], { cwd: APP, encoding: 'utf8', timeout: 60_000,
      input: JSON.stringify({ sessionId: sid + '-cp', cwd: HOME, prompt: 'deploy' }) })
    ok(p.status === 0, 'Copilot PowerShell hook runs', p.stdout + p.stderr)
  }

  // 5. The `tokenomics` command
  let r = tokenomics()
  ok(r.status === 0 && r.stdout.includes('Claude Code'), '`tokenomics` shows status', r.stdout + r.stderr)
  r = tokenomics('dashboard', '--demo', '--no-open', '--port', '8791')
  ok(r.status === 0 && r.stdout.includes('running on'), '`tokenomics dashboard` starts', r.stdout + r.stderr)
  const resp = await fetch('http://127.0.0.1:8791/api/data?days=30', { signal: AbortSignal.timeout(10_000) })
  ok(resp.status === 200, 'dashboard serves data')
  r = tokenomics('dashboard', '--stop')
  ok(r.stdout.includes('Stopped'), '`tokenomics dashboard --stop`', r.stdout + r.stderr)
  r = tokenomics('report')
  ok(r.status === 0 && r.stdout.includes('tokenomics report'), '`tokenomics report`', r.stdout + r.stderr)

  // 6. Uninstall
  r = tokenomics('uninstall')
  ok(r.status === 0, '`tokenomics uninstall`', r.stdout + r.stderr)
  const after = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))
  ok(!('statusLine' in after), 'uninstall removed the statusline', JSON.stringify(after))
  ok(!existsSync(join(APP, 'scripts')), 'uninstall removed the app')
  ok(isFile(dbPath), 'uninstall kept the recorded data')
  process.stdout.write('\nAll installer checks passed.\n')
}

await main(process.argv.slice(2))
