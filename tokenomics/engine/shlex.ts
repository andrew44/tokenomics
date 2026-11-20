/** POSIX shell word splitting, as Python's shlex.split(s, posix=True) does it (no comments). */
export class ShlexError extends Error {}

export function shlexSplit(s: string): string[] {
  const words: string[] = []
  let word = ''
  let inWord = false
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === "'") {
      const end = s.indexOf("'", i + 1)
      if (end < 0) throw new ShlexError('No closing quotation')
      word += s.slice(i + 1, end)
      inWord = true
      i = end + 1
    } else if (ch === '"') {
      i++
      for (;;) {
        if (i >= s.length) throw new ShlexError('No closing quotation')
        const c = s[i]
        if (c === '"') break
        if (c === '\\' && i + 1 < s.length && '\\"$`\n'.includes(s[i + 1])) {
          word += s[i + 1]
          i += 2
          continue
        }
        word += c
        i++
      }
      inWord = true
      i++
    } else if (ch === '\\') {
      if (i + 1 >= s.length) throw new ShlexError('No escaped character')
      word += s[i + 1]
      inWord = true
      i += 2
    } else if (/\s/.test(ch)) {
      if (inWord) words.push(word)
      word = ''
      inWord = false
      i++
    } else {
      word += ch
      inWord = true
      i++
    }
  }
  if (inWord) words.push(word)
  return words
}
