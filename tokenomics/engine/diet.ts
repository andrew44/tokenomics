/**
 * Context diet: catch tool calls that would pour a lot of low-value text into the context.
 *
 * Platform-independent. Input is a normalised ToolCall (adapters map Read/view and Bash/shell
 * onto TOOL_READ and TOOL_SHELL). Output is a Verdict with a reason written for the model:
 * the hook denies the call and the model retries with a narrower one (a range, a filter, a
 * --tail), which is almost always what a person would want anyway.
 *
 * Rules are deliberately conservative: a command that already pipes, redirects or limits its
 * output is left alone, and files that cannot be found are never blocked.
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'

import { fmt } from '../util.ts'
import { TOOL_READ, TOOL_SHELL, type ToolCall } from './evidence.ts'
import { shlexSplit } from './shlex.ts'

export const BYPASS = '# diet-ok'
const LOCKFILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock',
  'poetry.lock', 'pipfile.lock', 'uv.lock', 'cargo.lock', 'gemfile.lock', 'composer.lock',
  'go.sum', 'packages.lock.json', 'podfile.lock', 'flake.lock'])
const GENERATED_RE = /\.(min\.(js|css|mjs)|map|bundle\.js|chunk\.js|pb\.go|snap)$/i
const SEGMENT_SPLIT = /&&|\|\||;|\n/

export type Verdict = {
  rule: string
  reason: string               // shown to the model (and the user in warn mode)
  estTokens: number | null     // rough size of what was avoided, when knowable
}

const verdict = (rule: string, reason: string, estTokens: number | null = null): Verdict => ({ rule, reason, estTokens })

export function maxBytes(): number {
  const v = Number.parseInt(process.env.TOKENOMICS_DIET_MAX_KB ?? '64', 10)
  return (Number.isNaN(v) ? 64 : Math.max(1, v)) * 1024
}

export function expandUser(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

function size(path: string, cwd: string | null): number | null {
  try {
    let p = expandUser(path)
    if (!isAbsolute(p) && cwd) p = join(cwd, p)
    const st = statSync(p)
    return st.isFile() ? st.size : null
  } catch {
    return null
  }
}

function generated(name: string): boolean {
  const base = basename(name).toLowerCase()
  return LOCKFILES.has(base) || GENERATED_RE.test(base)
}

export function check(call: ToolCall, cwd: string | null = null): Verdict | null {
  if (call.kind === TOOL_READ) return checkRead(call, cwd)
  if (call.kind === TOOL_SHELL) return checkShell(call.command || '', cwd)
  return null
}

// ---- reads ------------------------------------------------------------------------------

function checkRead(call: ToolCall, cwd: string | null): Verdict | null {
  if (!call.path || call.ranged) return null
  const n = size(call.path, cwd)
  if (n === null || n < maxBytes() || !generated(call.path)) return null
  const tokens = Math.floor(n / 4)
  return verdict('generated-file',
    `tokenomics diet: ${basename(call.path)} is a generated file of about ${fmt(tokens)} tokens; reading it whole ` +
    'is rarely useful. Search it instead (e.g. grep for the package or symbol you need), or read ' +
    'a small range with offset/limit.', tokens)
}

// ---- shell commands -----------------------------------------------------------------------

function words(segment: string): string[] | null {
  try {
    return shlexSplit(segment)
  } catch {
    return null
  }
}

function has(ws: string[], ...flags: string[]): boolean {
  for (const w of ws) {
    for (const f of flags) {
      if (w === f || (f.startsWith('--') && w.startsWith(f + '='))) return true
      if (!f.startsWith('--') && f.length === 2 && w.startsWith(f) && /^\d+$/.test(w.slice(2))) return true   // -n50
    }
  }
  return false
}

function shortFlag(ws: string[], letter: string): boolean {
  return ws.some((w) => w.startsWith('-') && !w.startsWith('--') && w.slice(1).includes(letter))
}

/** First positional word after the command, skipping global flags (`kubectl -n prod logs`). */
function verb(ws: string[]): string {
  let skip = false
  for (const w of ws.slice(1)) {
    if (skip) {
      skip = false
      continue
    }
    if (w.startsWith('-')) {
      skip = !w.includes('=') && ['-n', '--namespace', '--context', '--kubeconfig', '-c', '--cluster'].includes(w)
      continue
    }
    return w
  }
  return ''
}

function checkShell(command: string, cwd: string | null): Verdict | null {
  if (command.includes(BYPASS)) return null
  for (let seg of command.split(SEGMENT_SPLIT)) {
    seg = seg.trim()
    if (!seg || seg.includes('|') || seg.includes('>')) continue      // already filtered or sent to a file
    let ws = words(seg)
    if (!ws || !ws.length) continue
    while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0])) ws = ws.slice(1)   // FOO=1 cmd ...
    while (ws.length && ['sudo', 'time', 'nice', 'command'].includes(ws[0])) ws = ws.slice(1)
    if (!ws.length) continue
    const v = shellRule(ws, cwd)
    if (v) {
      v.reason += ` If you really need the full output, append \`${BYPASS}\` to the command.`
      return v
    }
  }
  return null
}

function shellRule(w: string[], cwd: string | null): Verdict | null {
  const cmd = basename(w[0])
  const sub = w.length > 1 ? w[1] : ''

  if ((cmd === 'kubectl' || cmd === 'oc') && verb(w) === 'logs') {
    if (!has(w, '--tail', '--since', '--since-time', '-f', '--follow')) {
      return verdict('unbounded-logs', 'tokenomics diet: `kubectl logs` without a limit can return ' +
        'thousands of lines. Add `--tail=200` or `--since=15m` (and grep for the error).')
    }
  }
  if (((cmd === 'docker' || cmd === 'podman') && (sub === 'logs' || (sub === 'compose' && w.includes('logs')))) ||
      (cmd === 'docker-compose' && sub === 'logs')) {
    if (!has(w, '--tail', '-n', '--since', '-f', '--follow')) {
      return verdict('unbounded-logs', 'tokenomics diet: container logs without a limit can be huge. ' +
        'Add `--tail 200` or `--since 15m`.')
    }
  }
  if (cmd === 'journalctl' && !has(w, '-n', '--lines', '--since', '-S', '--until', '-f', '--follow')) {
    return verdict('unbounded-logs', 'tokenomics diet: `journalctl` without a limit dumps the whole ' +
      "journal. Add `-n 200` or `--since '15 min ago'` (and `-u <unit>`).")
  }
  if (cmd === 'git' && (sub === 'log' || sub === 'reflog')) {
    const bounded = has(w, '-n', '--max-count', '--since', '--after', '--until') ||
      w.slice(2).some((x) => /^-\d+$/.test(x) || x.includes('..'))
    if (!bounded) {
      return verdict('unbounded-git-log', 'tokenomics diet: `git log` without a limit prints the whole ' +
        'history. Add `-n 20` (and `--oneline` unless you need full messages).')
    }
  }
  if (cmd === 'find' && w.length > 1 && ['/', '~', homedir()].includes(w[1]) && !has(w, '-maxdepth')) {
    return verdict('unbounded-find', 'tokenomics diet: `find` from / or ~ walks the whole disk. Start from ' +
      'the project folder, add `-maxdepth 3`, or pipe to `head`.')
  }
  if (cmd === 'ls' && (shortFlag(w, 'R') || w.includes('--recursive'))) {
    return verdict('recursive-listing', 'tokenomics diet: a recursive `ls` lists every file (node_modules, ' +
      '.git ...). Use `git ls-files`, `find . -maxdepth 2`, or a Glob pattern.')
  }
  if (cmd === 'tree' && !has(w, '-L')) {
    return verdict('recursive-listing', 'tokenomics diet: `tree` without `-L` prints every file. ' +
      'Add `-L 2` (and `-I node_modules`).')
  }
  if (['cat', 'less', 'more', 'bat'].includes(cmd)) {
    for (const arg of w.slice(1)) {
      if (arg.startsWith('-')) continue
      const n = size(arg, cwd)
      if (n === null || n < maxBytes()) continue
      const kind = generated(arg) ? 'a generated file' : 'a large file'
      const tokens = Math.floor(n / 4)
      return verdict('large-cat', `tokenomics diet: ${basename(arg)} is ${kind} of about ` +
        `${fmt(tokens)} tokens. Use \`grep -n\`, \`head\`/\`tail\`, or \`sed -n 'A,Bp'\` to read ` +
        'only the part you need.', tokens)
    }
  }
  return null
}
