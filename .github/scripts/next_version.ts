#!/usr/bin/env node
/**
 * Work out the next release version and keep the plugin manifests in step with it.
 *
 *   next_version.ts            print KEY=VALUE lines for $GITHUB_OUTPUT:
 *                                version=1.3.1   tag=v1.3.1   bump=true|false   release=true|false
 *   next_version.ts --write V  set "version" in every manifest to V
 *
 * Rules (the manifests are the source of truth; tags are vX.Y.Z):
 *   * No release yet                    -> release the manifest version as it is.
 *   * You raised the manifest version   -> release that version as it is (how you do minor/major).
 *   * Otherwise                         -> bump the patch of the latest release, and the workflow
 *                                          commits that to the manifests (bump=true), because Claude
 *                                          Code only sends a plugin update when the version changes.
 *   * Nothing new since the last tag    -> release=false.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type Version = [number, number, number]

const ROOT = join(import.meta.dirname, '..', '..')
export const MANIFESTS = [join(ROOT, '.claude-plugin', 'plugin.json'), join(ROOT, 'plugin.json')]
const VERSION_RE = /("version"\s*:\s*")([^"]+)(")/

export class VersionError extends Error {}

export function parse(v: string): Version {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  if (!m) throw new VersionError(`Not a MAJOR.MINOR.PATCH version: ${JSON.stringify(v)}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export const fmt = (t: Version) => t.join('.')

export function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

export function manifestVersion(manifests = MANIFESTS): Version {
  const versions = new Set(manifests.map((p) => String(JSON.parse(readFileSync(p, 'utf8')).version)))
  if (versions.size !== 1) throw new VersionError(`The manifests disagree on the version: ${[...versions].sort().join(', ')}. Make them match.`)
  return parse([...versions][0])
}

function git(...args: string[]): string {
  return String(spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout ?? '').trim()
}

function latestTag(): string | null {
  const tags = git('tag', '--list', 'v*').split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
  return tags.length ? tags.reduce((a, b) => (compare(parse(b), parse(a)) > 0 ? b : a)) : null
}

/** [version, bump, release] from the manifest version, the latest tag and whether anything
 *  changed since that tag. */
export function decide(manifest: Version, tag: string | null, changed: boolean): [Version, boolean, boolean] {
  if (tag === null) return [manifest, false, true]
  const last = parse(tag)
  if (compare(manifest, last) > 0) return [manifest, false, true]
  if (!changed) return [last, false, false]
  return [[last[0], last[1], last[2] + 1], true, true]
}

export function write(version: string, manifests = MANIFESTS): void {
  for (const p of manifests) {
    const text = readFileSync(p, 'utf8')
    if (!VERSION_RE.test(text)) throw new VersionError(`No version field in ${p}`)
    writeFileSync(p, text.replace(VERSION_RE, (_m, a, _v, c) => a + version + c), 'utf8')
  }
}

function main(argv: string[]): number {
  try {
    if (argv[0] === '--write') {
      write(fmt(parse(argv[1] ?? '')))
      return 0
    }
    const tag = latestTag()
    const changed = tag === null || Boolean(git('rev-list', `${tag}..HEAD`))
    const [version, bump, release] = decide(manifestVersion(), tag, changed)
    process.stdout.write(`version=${fmt(version)}\ntag=v${fmt(version)}\nbump=${bump}\nrelease=${release}\nprevious=${tag ?? ''}\n`)
    return 0
  } catch (e) {
    if (!(e instanceof VersionError)) throw e
    process.stderr.write(e.message + '\n')
    return 1
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2))
