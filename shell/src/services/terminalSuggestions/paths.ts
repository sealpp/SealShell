/** Literal simple-command operands only; shell expressions remain owned by the terminal. */
interface Word { value: string; start: number; closed: boolean; home: boolean }
interface CommandSpec { flags: string; values: string[]; longFlags: string[]; optionalValues?: string[]; kind: 'directory' | 'file' | 'any' }
const specs: Record<string, CommandSpec> = {
  cd: { flags: 'LPe', values: [], longFlags: [], kind: 'directory' },
  ls: { flags: 'aAbBcCdDfFgGhHiklLmNnOpqQrRsStTuUvwxX1', values: ['I', 'T', 'w', 'ignore', 'hide', 'sort', 'time', 'time-style', 'format', 'quoting-style', 'block-size', 'width', 'tabsize'], longFlags: ['all', 'almost-all', 'directory', 'human-readable', 'recursive', 'reverse', 'size', 'inode', 'numeric-uid-gid'], optionalValues: ['color', 'hyperlink', 'classify'], kind: 'any' },
  cat: { flags: 'AbBeEnstTuv', values: [], longFlags: ['number', 'number-nonblank', 'show-all', 'show-ends', 'show-tabs', 'squeeze-blank'], kind: 'file' },
  less: { flags: 'FIMNRSXefgimnqs', values: ['p', 'P', 'x', 'z'], longFlags: [], kind: 'file' },
  head: { flags: 'qvz', values: ['n', 'c', 'lines', 'bytes'], longFlags: ['quiet', 'silent', 'verbose', 'zero-terminated'], kind: 'file' },
  tail: { flags: 'fFqvz', values: ['n', 'c', 's', 'lines', 'bytes', 'pid', 'sleep-interval', 'max-unchanged-stats'], longFlags: ['retry', 'quiet', 'silent', 'verbose', 'zero-terminated'], optionalValues: ['follow'], kind: 'file' },
  stat: { flags: 'Lft', values: ['c', 'format', 'printf'], longFlags: ['dereference', 'file-system', 'terse'], kind: 'any' },
  du: { flags: '0abcDhHklLmPSsx', values: ['d', 'B', 'max-depth', 'block-size', 'exclude', 'threshold'], longFlags: ['all', 'bytes', 'total', 'human-readable', 'summarize', 'one-file-system', 'apparent-size'], kind: 'any' },
}

export const shellQuote = (text: string) => `'${text.replace(/'/g, "'\\''")}'`
export function hasPathCommand(input: string): boolean { return /^(cd|ls|cat|less|head|tail|stat|du)(?:\s|$)/.test(input) }

function words(input: string): Word[] | undefined {
  if (/[\x00-\x1f\x7f]/.test(input) || /^\s/.test(input)) return undefined
  const result: Word[] = []
  let value = '', quote = '', start = -1, home = false
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!
    if (start < 0 && char === ' ') continue
    if (start < 0) { start = i; home = char === '~' }
    if (quote === "'") { if (char === "'") quote = ''; else value += char }
    else if (char === '\\') {
      const next = input[++i]
      if (next === undefined) return undefined
      if (quote === '"' && !'\\"$`'.includes(next)) value += '\\'
      value += next
    } else if (quote === '"') {
      if (char === '"') quote = ''
      else if ('$`'.includes(char)) return undefined
      else value += char
    } else if (char === '"' || char === "'") quote = char
    else if (char === ' ') { result.push({ value, start, closed: true, home }); value = ''; start = -1 }
    else if (';&|<>($`*?[]{}!)'.includes(char)) return undefined
    else value += char
  }
  if (start >= 0) result.push({ value, start, closed: !quote, home })
  else if (input.endsWith(' ')) result.push({ value: '', start: input.length, closed: true, home: false })
  return result
}

export interface PathCommand {
  verb: string
  fragment: string
  home: boolean
  closed: boolean
  kind: CommandSpec['kind']
  prefix: string
  fixed: string[]
  operands: string[]
  marker: boolean
}

export function parsePathCommand(input: string): PathCommand | undefined {
  const tokens = words(input)
  if (!tokens || tokens.length < 2) return undefined
  const verb = tokens[0]!.value, spec = specs[verb]
  if (!spec || !tokens[0]!.closed) return undefined
  let marker = false, needsValue = false, markerIndex = -1
  const operands: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!, last = i === tokens.length - 1
    if (needsValue) { if (!token.closed || !token.value || last) return undefined; needsValue = false; continue }
    if (!marker && token.value === '--') { marker = true; markerIndex = i; if (last) return undefined; continue }
    if (!marker && token.value.startsWith('-')) {
      if (token.value === '-') return undefined
      if (token.value.startsWith('--')) {
        const [name] = token.value.slice(2).split('=')
        const assigned = token.value.includes('=')
        if (spec.values.includes(name!)) needsValue = !assigned
        else if (!spec.optionalValues?.includes(name!) && (!spec.longFlags.includes(name!) || assigned)) return undefined
      } else {
        for (let c = 1; c < token.value.length; c++) {
          const flag = token.value[c]!
          if (spec.values.includes(flag)) { needsValue = c === token.value.length - 1; break }
          if (!spec.flags.includes(flag)) return undefined
        }
      }
      if (!token.closed || last) return undefined
      continue
    }
    if (!last) { if (!token.closed) return undefined; operands.push(token.value); continue }
    if (verb === 'cd' && operands.length) return undefined
    return { verb, fragment: token.value, home: token.home, closed: token.closed, kind: spec.kind,
      prefix: input.slice(0, token.start), fixed: tokens.slice(0, i).filter((_, index) => index !== markerIndex).map(item => item.value), operands, marker }
  }
  return undefined
}

/** All sources must preserve the user's command, options, and preceding operands. */
export function preservesPathIntent(input: string, candidate: string): boolean {
  if (!hasPathCommand(input)) return true
  const from = parsePathCommand(input), to = parsePathCommand(candidate)
  return !!from && !!to && to.closed && !!to.fragment && from.verb === to.verb
    && from.fixed.length === to.fixed.length && from.fixed.every((word, index) => word === to.fixed[index])
}

export function resolvePath(path: string, cwd: string, home?: string, expandHome = false): string | undefined {
  if (expandHome && path.startsWith('~')) {
    if (!home || path !== '~' && !path.startsWith('~/')) return undefined
    path = home + path.slice(1)
  }
  if (!cwd.startsWith('/')) return undefined
  const parts: string[] = []
  for (const part of (path.startsWith('/') ? path : cwd + '/' + path).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}

export const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

export function searchDirectory(input: PathCommand, cwd: string, home?: string): string | undefined {
  if (!input.fragment.includes('/') && !input.home) return undefined
  const path = resolvePath(input.fragment, cwd, home, input.home)
  if (!path) return undefined
  return input.fragment.endsWith('/') ? path : parentPath(path)
}

function closeSpelling(a: string, b: string): boolean {
  const limit = a.length >= 6 ? 2 : a.length >= 3 ? 1 : 0
  if (!limit || Math.abs(a.length - b.length) > limit) return false
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i), older = previous
  for (let i = 1; i <= a.length; i++) {
    const row = Array<number>(b.length + 1).fill(limit + 1); row[0] = i
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      row[j] = Math.min(previous[j]! + 1, row[j - 1]! + 1, previous[j - 1]! + Number(a[i - 1] !== b[j - 1]))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j]!, older[j - 2]! + 1)
    }
    older = previous; previous = row
  }
  return previous[b.length]! <= limit
}

export interface PathFacts { cwd: string; home?: string; directories: string[]; files: string[] }

export function completePaths(query: string, facts: PathFacts): string[] {
  const input = parsePathCommand(query)
  if (!input) return []
  const resolved = resolvePath(input.fragment, facts.cwd, facts.home, input.home)
  if (!resolved) return []
  const paths = [...new Set(input.kind === 'directory' ? facts.directories : input.kind === 'file' ? facts.files : [...facts.directories, ...facts.files])]
  const parent = searchDirectory(input, facts.cwd, facts.home)
  const fragment = input.fragment.endsWith('/') ? '' : input.fragment.split('/').slice(-1)[0]!
  const fold = (value: string) => value.replace(/[-_]/g, '')
  const rank = (path: string): number => {
    if (input.fragment && !input.fragment.endsWith('/') && path === resolved) return 100
    if (parent && parentPath(path) !== parent) return 0
    if (!fragment) return parentPath(path) === (parent ?? facts.cwd) ? 80 : 0
    const name = path.slice(path.lastIndexOf('/') + 1)
    if (name === fragment) return 90
    if (name.startsWith(fragment)) return 80
    if (fold(name) === fold(fragment)) return 70
    if (fold(name).startsWith(fold(fragment))) return 60
    if (closeSpelling(fragment, name)) return 40
    return 0
  }
  const matches = paths.filter(path => !/[\x00-\x1f\x7f]/.test(path)).map(path => ({ path, rank: rank(path) })).filter(item => item.rank > 0)
  const best = Math.max(0, ...matches.map(item => item.rank))
  return matches.filter(item => item.rank === best).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).slice(0, 8)
    .map(({ path }) => input.prefix + (input.marker ? '' : '-- ') + shellQuote(path))
}
