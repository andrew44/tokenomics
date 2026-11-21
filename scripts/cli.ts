#!/usr/bin/env node
/**
 * tokenomics: one command for setup, the dashboard, reports and updates.
 *
 * Installed by the one-line installer (install.sh / install.ps1) as `tokenomics` on your PATH:
 *
 *   tokenomics                    what's installed, and what to try next
 *   tokenomics dashboard [--demo] open the dashboard (runs in the background; --stop to stop it)
 *   tokenomics report [--days N]  spend report in the terminal
 *   tokenomics statusline [...]   statusline and band options, e.g. --demo, --set-currency USD,
 *                                 --band-off, --status   ("statusbar", the old name, still works)
 *   tokenomics router [...]       pennywise model router: serve [--port N], explain "prompt", env
 *   tokenomics doggybag           pack a doggybag (resume note) for this folder's latest session now
 *   tokenomics bangforbuck [...]  cost per outcome: per feature, bug fixed, passing suite (alias: value)
 *   tokenomics waistline [...]    cost regression: is the same work getting dearer? (--ci for pipelines)
 *   tokenomics sherlock [...]     agent forensics: where this folder's latest session wasted money
 *   tokenomics tastetest [...]    compare two runs of a task: cost vs quality (--a ... --b ...)
 *   tokenomics haggle [...]       quote a task before it starts: haggle quote "task" --price 2
 *   tokenomics springclean        audit CLAUDE.md / AGENTS.md for duplicate, stale and bloated context
 *   tokenomics groundhog          list the loops this folder's latest session went round
 *   tokenomics splitthebill [...] who and what spent the budget: project, developer, agent, model ... (--csv)
 *   tokenomics bazaar [...]       the best-value provider for the same work (quote, list)
 *   tokenomics blinkers [...]     scope creep in a session (check) or a branch (diff --task "...")
 *   tokenomics crystalball [...]  what a team's AI adoption will cost a month (--devs 10 --tasks 20 ...)
 *   tokenomics deadwood [...]     this month's spend on work that produced nothing (session, mark)
 *   tokenomics packlight [...]    what every request carries (MCP servers, skills) and which you never use
 *   tokenomics ballast [...]      context carried from one task into the next in a session, and its cost
 *   tokenomics waffle [...]       output spend: long replies, recaps, whole-file rewrites, thinking (--days 7)
 *   tokenomics coldsnap [...]     every time the prompt cache went cold, why (break, model switch, prefix change), and its cost
 *   tokenomics parrot [...]       what you keep telling the AI across sessions: rules, corrections, prompts (report)
 *   tokenomics allyoucaneat [...] pay-as-you-go or a subscription: which plan fits your spend (--plan pro|max5|max20)
 *
 * Signature features: value-meter (bangforbuck), agent-forensics (sherlock), quality-gate (tastetest).
 *   tokenomics update             fetch the latest version and refresh everything
 *   tokenomics uninstall [--purge]  remove it all (--purge also deletes your recorded data)
 *   tokenomics setup              (re)do the setup the installer does; idempotent
 *
 * Setup does, for each assistant it finds on this computer:
 *   Claude Code  -> adds the plugin (skills + hooks + the desktop app's band) and the statusline
 *   Copilot CLI  -> adds the plugin and the statusline
 * It never replaces a status line you already have. Node.js 22.18+, built-ins only.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as statusline from './statusline.ts'

const HERE = import.meta.dirname
const SELF = fileURLToPath(import.meta.url)
const HOME = homedir()
const TK_HOME = process.env.TOKENOMICS_HOME || join(HOME, '.tokenomics')
const APP_DIR = join(TK_HOME, 'app')
const REPO = process.env.TOKENOMICS_REPO || 'andrew44/tokenomics'
const REF = process.env.TOKENOMICS_REF || 'main'
const MARKETPLACE = 'tokenomics'
const PLUGIN = 'tokenomics@tokenomics'
const WINDOWS = process.platform === 'win32'
const RC_MARK = '# added by the tokenomics installer'
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning']

const say = (msg = '') => process.stdout.write(msg + '\n')

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Full path of a command on PATH (with PATHEXT on Windows), or null. */
export function which(cmd: string): string | null {
  // Windows: a bare name only runs through PATHEXT (claude -> claude.cmd), as cmd.exe and Python's
  // shutil.which resolve it. npm also puts an extension-less sh shim beside claude.cmd that Node
  // can't start, so that one must never be picked.
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const exts = !WINDOWS ? [''] : pathext.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase())) ? [''] : pathext
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = join(dir, cmd + ext)
      try {
        if (isFile(p)) {
          if (!WINDOWS) accessSync(p, constants.X_OK)
          return p
        }
      } catch {
        // not executable
      }
    }
  }
  return null
}

/** Run a command; true on success. Never reads our stdin (the installer may be piped in). */
function run(cmd: string[], quiet = true): boolean {
  const exe = which(cmd[0])          // on Windows `claude` is often claude.cmd, which needs a shell
  if (!exe) return false
  try {
    const stdio: ('ignore' | 'pipe' | 'inherit')[] = ['ignore', quiet ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit']
    // A .cmd/.bat only runs through cmd.exe: hand it one quoted command line (passing an args
    // array with shell: true is deprecated, as the args aren't escaped).
    const p = WINDOWS && /\.(cmd|bat)$/i.test(exe)
      ? spawnSync([exe, ...cmd.slice(1)].map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a)).join(' '),
        { stdio, timeout: 300_000, shell: true, windowsHide: true })
      : spawnSync(exe, cmd.slice(1), { stdio, timeout: 300_000, windowsHide: true })
    return p.status === 0
  } catch {
    return false
  }
}

function script(name: string, ...args: string[]): number {
  const p = spawnSync(process.execPath, [...NODE_FLAGS, join(HERE, name), ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
  return p.status ?? 1
}

// ---- assistants ---------------------------------------------------------------------------------

const has = (cli: string) => which(cli) !== null

function claudePlugin(action: 'install' | 'update' | 'uninstall'): boolean {
  if (action === 'install') {
    run(['claude', 'plugin', 'marketplace', 'add', REPO])
    run(['claude', 'plugin', 'marketplace', 'update', MARKETPLACE])
    return run(['claude', 'plugin', 'install', PLUGIN]) || run(['claude', 'plugin', 'update', PLUGIN])
  }
  if (action === 'update') {
    run(['claude', 'plugin', 'marketplace', 'update', MARKETPLACE])
    return run(['claude', 'plugin', 'update', PLUGIN])
  }
  const ok = run(['claude', 'plugin', 'uninstall', PLUGIN])
  run(['claude', 'plugin', 'marketplace', 'remove', MARKETPLACE])
  return ok
}

function copilotPlugin(action: 'install' | 'update' | 'uninstall'): boolean {
  if (action === 'install') return run(['copilot', 'plugin', 'install', REPO]) || run(['copilot', 'plugin', 'update', 'tokenomics'])
  if (action === 'update') return run(['copilot', 'plugin', 'update', 'tokenomics']) || run(['copilot', 'plugin', 'install', REPO])
  return run(['copilot', 'plugin', 'uninstall', 'tokenomics'])
}

// ---- the `tokenomics` launcher ------------------------------------------------------------------

function real(p: string): string {
  let r: string
  try {
    r = realpathSync(p)
  } catch {
    r = resolve(p)
  }
  return WINDOWS ? r.toLowerCase() : r
}

function onPath(d: string): boolean {
  return (process.env.PATH || '').split(delimiter).filter(Boolean).map(real).includes(real(d))
}

function binDir(): string {
  if (WINDOWS) return join(TK_HOME, 'bin')
  for (const d of [join(HOME, '.local', 'bin'), join(HOME, 'bin')]) if (onPath(d)) return d
  return join(HOME, '.local', 'bin')
}

function rcFiles(): string[] {
  const shell = basename(process.env.SHELL || '')
  if (shell === 'zsh') return [join(HOME, '.zshrc')]
  if (shell === 'bash') return [join(HOME, process.platform === 'darwin' ? '.bash_profile' : '.bashrc')]
  if (shell === 'fish') return []
  return [join(HOME, '.profile')]
}

/** Record this Node.js for scripts/run.sh and the Copilot hooks, so they never have to guess. */
function rememberNode(): void {
  try {
    mkdirSync(TK_HOME, { recursive: true })
    writeFileSync(join(TK_HOME, 'node'), process.execPath.replaceAll('\\', '/') + '\n', 'utf8')
  } catch {
    // run.sh will look for one itself
  }
}

/** Write the `tokenomics` command; returns [path, needsNewTerminal]. */
function installLauncher(): [string, boolean] {
  const d = binDir()
  mkdirSync(d, { recursive: true })
  let path: string
  if (WINDOWS) {
    path = join(d, 'tokenomics.cmd')
    writeFileSync(path, `@"${process.execPath}" ${NODE_FLAGS.join(' ')} "${SELF}" %*\r\n`, 'utf8')
  } else {
    path = join(d, 'tokenomics')
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" ${NODE_FLAGS.join(' ')} "${SELF}" "$@"\n`, 'utf8')
    chmodSync(path, 0o755)
  }
  if (onPath(d)) return [path, false]
  if (WINDOWS) return [path, true]                         // install.ps1 puts this folder on PATH
  const line = `export PATH="${d}:$PATH"  ${RC_MARK}\n`
  for (const rc of rcFiles()) {
    try {
      const text = existsSync(rc) ? readFileSync(rc, 'utf8') : ''
      if (!text.includes(RC_MARK)) appendFileSync(rc, (text && !text.endsWith('\n') ? '\n' : '') + line, 'utf8')
    } catch {
      // the user can add it by hand
    }
  }
  if (basename(process.env.SHELL || '') === 'fish') {
    const fish = join(HOME, '.config', 'fish', 'conf.d')
    mkdirSync(fish, { recursive: true })
    writeFileSync(join(fish, 'tokenomics.fish'), `fish_add_path ${d}  ${RC_MARK}\n`, 'utf8')
  }
  return [path, true]
}

/** Windows: delete a file or folder a few seconds from now, from a detached process, for
 *  things in use by this very command (its .cmd launcher, the Node.js running it). */
function deleteLater(path: string): void {
  const rm = isDir(path) ? `rmdir /s /q "${path}"` : `del /f /q "${path}"`
  spawn('cmd', ['/c', `ping -n 3 127.0.0.1 >nul & ${rm}`], { stdio: 'ignore', detached: true, windowsHide: true, shell: false }).unref()
}

function removeLauncher(): void {
  for (const d of new Set([join(HOME, '.local', 'bin'), join(HOME, 'bin'), join(TK_HOME, 'bin')])) {
    for (const name of ['tokenomics', 'tokenomics.cmd']) {
      const p = join(d, name)
      if (!isFile(p)) continue
      // cmd.exe is still running this very file and re-reads it when node exits, so deleting it
      // now makes cmd fail with "The batch file cannot be found".
      if (WINDOWS && name.endsWith('.cmd')) deleteLater(p)
      else unlinkSync(p)
    }
  }
  for (const rc of ['.zshrc', '.bashrc', '.bash_profile', '.profile'].map((n) => join(HOME, n))) {
    let text: string
    try {
      text = readFileSync(rc, 'utf8')
    } catch {
      continue
    }
    if (text.includes(RC_MARK)) {
      writeFileSync(rc, text.split(/(?<=\n)/).filter((l) => !l.includes(RC_MARK)).join(''), 'utf8')
    }
  }
  const fish = join(HOME, '.config', 'fish', 'conf.d', 'tokenomics.fish')
  if (isFile(fish)) unlinkSync(fish)
}

// ---- commands -----------------------------------------------------------------------------------

function setup(args: string[]): number {
  const wantPlugin = !args.includes('--no-plugin')
  const wantLine = !args.includes('--no-statusline') && !args.includes('--no-statusbar')   // --no-statusbar: the old name
  const found = ['claude', 'copilot'].filter(has)
  say('Setting up tokenomics')
  say('')
  if (!found.length) {
    say("  ! Neither Claude Code ('claude') nor GitHub Copilot CLI ('copilot') was found on PATH.")
    say('    Install one (https://claude.com/claude-code), then run: tokenomics setup')
  }
  for (const cli of found) {
    const name = cli === 'claude' ? 'Claude Code' : 'Copilot CLI'
    if (wantPlugin) {
      if (cli === 'claude' ? claudePlugin('install') : copilotPlugin('install')) {
        say(`  ✓ ${name}: plugin installed (skills + hooks)`)
      } else {
        const manual = cli === 'claude' ? `claude plugin marketplace add ${REPO} && claude plugin install ${PLUGIN}`
          : `copilot plugin install ${REPO}`
        say(`  ! ${name}: couldn't add the plugin automatically. Run: ${manual}`)
      }
    }
    if (wantLine) {
      const lines: string[] = []
      statusline.migrate()                                   // an older "statusbar" or Python install
      try {
        statusline.install(cli, { keepExisting: true, out: (s) => lines.push(s) })
      } catch (e) {                                          // e.g. settings.json isn't valid JSON
        lines.push(`Skipped ${cli}: ${e instanceof Error ? e.message : e}`)
      }
      if (lines.join('\n').includes('Skipped')) {
        say(`  · ${name}: kept your existing status line (replace it with: tokenomics statusline --install ${cli})`)
      } else {
        say(`  ✓ ${name}: statusline installed`)
      }
    }
  }
  rememberNode()
  const [path, newTerminal] = installLauncher()
  say(`  ✓ 'tokenomics' command: ${path}`)
  say('')
  const names = found.map((c) => (c === 'claude' ? 'Claude Code' : 'Copilot CLI')).join(' / ')
  let step: number
  if (found.length) {
    say('Done! Next steps:')
    say(`  1. Quit and reopen ${names} (type /exit, then start it again).`)
    say('  2. Ask it: "coach, review my prompts" or "spend report".')
    step = 3
    if (found.includes('claude')) {
      say('  3. Get updates automatically: in Claude Code open /plugin > Marketplaces > tokenomics')
      say('     and turn on auto-update.')
      step = 4
    }
  } else {
    say('Done (no assistant to connect yet). Next steps:')
    step = 1
  }
  say(newTerminal ? `  ${step}. Open a new terminal window, then try: tokenomics dashboard --demo`
    : `  ${step}. See where your tokens go: tokenomics dashboard --demo`)
  return 0
}

class CliError extends Error {}

/** Fetch REPO@REF into dest (replacing it). fetch() first, then curl. */
async function download(dest: string): Promise<void> {
  const url = `https://github.com/${REPO}/archive/${REF}.tar.gz`
  const tmp = mkdtempSync(join(tmpdir(), 'tokenomics-'))
  try {
    const tgz = join(tmp, 'src.tar.gz')
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      writeFileSync(tgz, Buffer.from(await r.arrayBuffer()))
    } catch {
      if (!run(['curl', '-fsSL', '-o', tgz, url])) throw new CliError(`Couldn't download ${url}. Check your connection and try again.`)
    }
    const list = spawnSync('tar', ['-tvzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const names = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (list.status !== 0 || names.status !== 0) throw new CliError("Couldn't read the download.")
    const unsafe = String(names.stdout).split('\n').filter(Boolean).some((n) => n.startsWith('/') || n.split(/[/\\]/).includes('..')) ||
      String(list.stdout).split('\n').some((l) => /^[lh]/.test(l))
    if (unsafe) throw new CliError('Refusing an archive with unsafe paths.')
    const out = join(tmp, 'src')
    mkdirSync(out)
    if (spawnSync('tar', ['-xzf', tgz, '-C', out]).status !== 0) throw new CliError("Couldn't unpack the download.")
    const tops = readdirSync(out).map((f) => join(out, f)).filter(isDir)
    if (tops.length !== 1) throw new CliError("The download doesn't look like tokenomics.")
    const staged = dest + '.new'
    rmSync(staged, { recursive: true, force: true })
    renameSync(tops[0], staged)
    rmSync(dest, { recursive: true, force: true })
    renameSync(staged, dest)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function update(args: string[]): Promise<number> {
  say(`Downloading the latest tokenomics (${REPO}@${REF})...`)
  try {
    await download(APP_DIR)
  } catch (e) {
    if (!(e instanceof CliError)) throw e
    process.stderr.write(e.message + '\n')
    return 1
  }
  if (has('claude')) say(claudePlugin('update') ? '  ✓ Claude Code plugin updated' : '  · Claude Code plugin: no update applied')
  if (has('copilot')) say(copilotPlugin('update') ? '  ✓ Copilot CLI plugin updated' : '  · Copilot CLI plugin: no update applied')
  // Re-run setup from the fresh copy so the statusline, launcher and anything new are current.
  return spawnSync(process.execPath, [...NODE_FLAGS, join(APP_DIR, 'scripts', 'cli.ts'), 'setup', '--no-plugin', ...args],
    { stdio: ['ignore', 'inherit', 'inherit'] }).status ?? 1
}

function uninstall(args: string[]): number {
  for (const t of ['claude', 'copilot']) {
    if (statusline.isOurs(statusline.statusLine(t))) statusline.install(t, { remove: true })
  }
  if (has('claude') && claudePlugin('uninstall')) say('Removed the Claude Code plugin.')
  if (has('copilot') && copilotPlugin('uninstall')) say('Removed the Copilot CLI plugin.')
  removeLauncher()
  spawnSync(process.execPath, [...NODE_FLAGS, join(HERE, 'dashboard.ts'), '--stop'], { stdio: 'ignore' })
  if (args.includes('--purge')) {
    rmSync(TK_HOME, { recursive: true, force: true })
    say(`Deleted ${TK_HOME} (all recorded data).`)
    return 0
  }
  rmSync(APP_DIR, { recursive: true, force: true })
  const runtime = join(TK_HOME, 'runtime')                 // the private Node.js (or older Python), if any
  if (WINDOWS && isDir(runtime)) deleteLater(runtime)      // it may be running this command
  else rmSync(runtime, { recursive: true, force: true })
  for (const name of ['statusline.mts', 'statusline.py', 'statusbar.py', 'model-prices.json', 'node', 'python']) {
    try {
      unlinkSync(join(TK_HOME, name))
    } catch {
      // not there
    }
  }
  say(`tokenomics is uninstalled. Your recorded data is kept in ${TK_HOME}; delete that folder to remove it too.`)
  return 0
}

function doc(): string {
  const text = readFileSync(SELF, 'utf8')
  const m = /\/\*\*\n([\s\S]*?)\*\//.exec(text)
  return m ? m[1].split('\n').map((l) => l.replace(/^ \* ?/, '').replace(/^ \*$/, '')).join('\n').trimEnd() : ''
}

function overview(): number {
  say(doc().split('\n\n')[0])
  say('')
  for (const [cli, name] of [['claude', 'Claude Code'], ['copilot', 'Copilot CLI']]) say(`  ${name.padEnd(12)} ${has(cli) ? 'found' : 'not found'}`)
  script('statusline.ts', '--status')
  const db = process.env.TOKENOMICS_DB || join(TK_HOME, 'spendlens.db')
  say(`  data         ${existsSync(db) ? db : 'nothing recorded yet'}`)
  say('')
  say('Commands: dashboard [--demo] · report · bangforbuck · waistline · sherlock · tastetest · haggle · springclean · groundhog')
  say('          splitthebill · bazaar · blinkers · crystalball · deadwood · packlight · ballast · waffle')
  say('          coldsnap · parrot · allyoucaneat')
  say('          statusline · router · doggybag · update · uninstall · setup')
  return 0
}

/** name -> [script, its subcommands, what to run when none is given]. */
const TOOLS: Record<string, [string, string[], string[]]> = {
  bangforbuck: ['bangforbuck.ts', ['report', 'session', 'mark', 'ingest'], ['report']],
  value: ['bangforbuck.ts', ['report', 'session', 'mark', 'ingest'], ['report']],
  waistline: ['waistline.ts', [], []],
  sherlock: ['sherlock.ts', [], []],
  tastetest: ['tastetest.ts', ['history'], []],
  haggle: ['haggle.ts', ['quote', 'status'], ['status']],
  springclean: ['springclean.ts', [], []],
  groundhog: ['groundhog.ts', ['check'], ['check']],
  splitthebill: ['splitthebill.ts', [], []],
  bazaar: ['bazaar.ts', ['quote', 'list'], []],
  blinkers: ['blinkers.ts', ['check', 'diff'], ['check']],
  crystalball: ['crystalball.ts', [], []],
  deadwood: ['deadwood.ts', ['report', 'session', 'mark'], ['report']],
  packlight: ['packlight.ts', [], []],
  ballast: ['ballast.ts', ['check'], ['check']],
  waffle: ['waffle.ts', [], []],
  coldsnap: ['coldsnap.ts', [], []],
  parrot: ['parrot.ts', ['report'], ['report']],
  allyoucaneat: ['allyoucaneat.ts', [], []],
  // the signature features, by what they do
  'value-meter': ['bangforbuck.ts', ['report', 'session', 'mark', 'ingest'], ['report']],
  'agent-forensics': ['sherlock.ts', [], []],
  forensics: ['sherlock.ts', [], []],
  'quality-gate': ['tastetest.ts', ['history'], []],
  // descriptive names for the new helpers
  'cost-attribution': ['splitthebill.ts', [], []],
  'provider-arbitrage': ['bazaar.ts', ['quote', 'list'], []],
  'scope-guard': ['blinkers.ts', ['check', 'diff'], ['check']],
  'spend-simulator': ['crystalball.ts', [], []],
  'dead-work': ['deadwood.ts', ['report', 'session', 'mark'], ['report']],
  'fixed-overhead': ['packlight.ts', [], []],
  'context-carry': ['ballast.ts', ['check'], ['check']],
  'output-audit': ['waffle.ts', [], []],
  'cache-misses': ['coldsnap.ts', [], []],
  'repeated-instructions': ['parrot.ts', ['report'], ['report']],
  'plan-fit': ['allyoucaneat.ts', [], []],
}

export async function main(argv: string[]): Promise<number> {
  const [cmd = '', ...rest] = argv
  if (cmd === '' || cmd === 'status' || cmd === 'doctor') return overview()
  if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    say(doc())
    return 0
  }
  if (cmd === 'setup') return setup(rest)
  if (cmd === 'update') return update(rest)
  if (cmd === 'uninstall') return uninstall(rest)
  if (cmd === 'dashboard') {
    const fg = rest.includes('--foreground')
    let args = rest.filter((a) => a !== '--foreground')
    if (!fg && !args.some((a) => ['--stop', '-h', '--help'].includes(a))) args = ['--background', ...args]
    return script('dashboard.ts', ...args)
  }
  if (cmd === 'report') return script('report.ts', ...rest)
  if (cmd === 'statusline' || cmd === 'statusbar') return script('statusline.ts', ...(rest.length ? rest : ['--status']))   // statusbar: the name before v1.4
  if (cmd === 'router' || cmd === 'pennywise') {
    if (!rest.length || !['serve', 'explain', 'env'].includes(rest[0])) {
      say('Usage: tokenomics router serve [--port N] | explain "prompt" | env [--port N]')
      return 2
    }
    return script('pennywise.ts', ...rest)
  }
  if (cmd === 'doggybag') return script('doggybag.ts', 'write', ...rest)
  const tool = Object.hasOwn(TOOLS, cmd) ? TOOLS[cmd] : undefined
  if (tool) {
    const [file, subs, fallback] = tool
    return script(file, ...(rest.length && subs.includes(rest[0]) ? rest : [...fallback, ...rest]))
  }
  say(`Unknown command: ${cmd}. Run 'tokenomics help'.`)
  return 2
}

function isMain(): boolean {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(SELF)
  } catch {
    return false
  }
}

if (isMain()) process.exitCode = await main(process.argv.slice(2))
