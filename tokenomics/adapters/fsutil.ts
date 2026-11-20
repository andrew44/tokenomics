/** Small filesystem helpers the adapters share (no platform logic here). */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** Every file under `dir` (recursively) whose path, relative to `dir`, satisfies `match`. */
export function findFiles(dir: string, match: (rel: string) => boolean, limit = Infinity): string[] {
  const out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  } catch {
    return out
  }
  for (const rel of entries) {
    if (out.length >= limit) break
    const norm = rel.replaceAll('\\', '/')
    if (match(norm) && isFile(join(dir, rel))) out.push(join(dir, rel))
  }
  return out
}
