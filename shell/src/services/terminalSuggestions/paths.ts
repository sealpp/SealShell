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
const nonPathOperands = new Set(['ssh', 'git', 'docker', 'kubectl', 'systemctl', 'kill', 'man', 'echo', 'printf', 'curl', 'ping'])
const leadingValue = new Set(['grep', 'rg', 'sed', 'awk', 'chmod', 'chown', 'chgrp'])
const pathOperands = new Set(['cp', 'mv', 'rm', 'mkdir', 'touch', 'ln', 'file', 'wc', 'readlink', 'realpath', 'find'])
const valueOptions = new Set(['port', 'host', 'hostname', 'user', 'username', 'pattern', 'regex', 'regexp', 'name', 'filter', 'exclude', 'format', 'count', 'timeout', 'color', 'sort', 'level', 'mode', 'command', 'eval', 'module'])
const pathOptions: Record<string, Record<string, 'directory' | 'file' | 'value'>> = {
  git: { C: 'directory' }, tar: { C: 'directory', f: 'file' }, cp: { t: 'directory' }, mv: { t: 'directory' }, ln: { t: 'directory' },
  grep: { e: 'value', f: 'file' }, rg: { e: 'value', f: 'file' }, sed: { e: 'value', f: 'file' }, awk: { f: 'file', v: 'value' },
  find: { name: 'value', iname: 'value', path: 'value', regex: 'value', type: 'value', maxdepth: 'value', mindepth: 'value', size: 'value', mtime: 'value', newer: 'file' },
  python: { c: 'value', m: 'value' }, python3: { c: 'value', m: 'value' }, node: { e: 'value', p: 'value' },
  gcc: { I: 'directory', L: 'directory', o: 'file' }, clang: { I: 'directory', L: 'directory', o: 'file' },
  ssh: { i: 'file', F: 'file', p: 'value', o: 'value' }, curl: { o: 'file', d: 'value', H: 'value' },
}

function optionRole(program: string, name: string): 'directory' | 'file' | 'any' | 'value' | undefined {
  const declared = pathOptions[program]?.[name]
  if (declared) return declared
  if (valueOptions.has(name)) return 'value'
  if (/(?:^|[-_])(?:dir|directory|root|cwd)$/.test(name) || name === 'work-tree') return 'directory'
  if (/(?:^|[-_])(?:file|files|path|config|configuration|input|output|certificate|cert|key)$/.test(name)) return 'any'
  return undefined
}

export function commandName(input: string): string | undefined {
  const name = /^[A-Za-z0-9_./][A-Za-z0-9_./+-]*(?= |$)/.exec(input)?.[0]
    ?? /^(?:\/|\.\.?\/)[^\s'"\\;&|<>($`*?\[\]{}!#)]+(?= |$)/.exec(input)?.[0]
  return name
}

export function hasPathCommand(input: string): boolean {
  const name = commandName(input)?.split('/').slice(-1)[0]
  if (name && specs[name] && input.includes(' ')) return true
  const argument = parsePathCommand(input)
  return !!argument && argument.evidence !== 'context'
}

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
    else if (';&|<>($`*?[]{}!#)'.includes(char)) return undefined
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
  evidence: 'declared' | 'syntax' | 'context'
  slot: string
  separator: boolean
}

export function parsePathCommand(input: string): PathCommand | undefined {
  const tokens = words(input)
  if (!tokens || tokens.length < 2) return undefined
  const verb = tokens[0]!.value, program = verb.split('/').slice(-1)[0]!, spec = specs[program]
  if (!commandName(input) || !tokens[0]!.closed) return undefined
  let marker = false, pending: ReturnType<typeof optionRole>, markerIndex = -1, patternProvided = false
  const operands: string[] = []
  function result(token: Word, index: number, kind: PathCommand['kind'], evidence: PathCommand['evidence'], slot = '', optionValue = false): PathCommand {
    return { verb, fragment: token.value, home: token.home, closed: token.closed, kind, evidence, slot,
      prefix: input.slice(0, token.start) + slot, fixed: tokens!.slice(0, index).filter((_, i) => i !== markerIndex).map(item => item.value),
      operands, marker, separator: !!spec && !marker && !optionValue }
  }
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!, last = i === tokens.length - 1
    if (pending) {
      if (last) return pending === 'value' ? undefined : result(token, i, pending, 'declared', '', true)
      if (!token.closed || !token.value) return undefined
      pending = undefined; continue
    }
    if (!marker && token.value === '--') { marker = true; markerIndex = i; if (last) return undefined; continue }
    if (!marker && token.value.startsWith('-')) {
      if (token.value === '-') return undefined
      if (token.value.startsWith('--')) {
        const [name] = token.value.slice(2).split('=')
        const assigned = token.value.includes('=')
        if (spec?.longFlags.includes(name!)) { if (assigned) return undefined }
        else if (!spec?.optionalValues?.includes(name!)) {
          const role = spec?.values.includes(name!) ? 'value' : optionRole(program, name!)
          if (['grep', 'rg'].includes(program) && ['regexp', 'file'].includes(name!)) patternProvided = true
          if (assigned && role && role !== 'value' && last) {
            const slot = `--${name}=`
            return result({ ...token, value: token.value.slice(slot.length), home: input.slice(token.start + slot.length).startsWith('~') }, i, role, 'declared', slot, true)
          }
          if (role) pending = assigned ? undefined : role
          else if (spec) return undefined
          else if (assigned && last) {
            const slot = `--${name}=`, fragment = token.value.slice(slot.length)
            if (/^(?:\/|\.\.?\/|~\/)/.test(fragment)) return result({ ...token, value: fragment }, i, 'any', 'syntax', slot, true)
          }
        }
      } else {
        const namedRole = token.value.length > 2 ? pathOptions[program]?.[token.value.slice(1)] : undefined
        if (namedRole) { pending = namedRole; if (last) return undefined; continue }
        for (let c = 1; c < token.value.length; c++) {
          const flag = token.value[c]!
          const role = spec?.values.includes(flag) ? 'value' : pathOptions[program]?.[flag]
          if (role) {
            if (['grep', 'rg', 'sed', 'awk'].includes(program) && ['e', 'f'].includes(flag)) patternProvided = true
            if (c < token.value.length - 1) {
              if (last && role !== 'value') return result({ ...token, value: token.value.slice(c + 1), home: false }, i, role, 'declared', token.value.slice(0, c + 1), true)
            } else pending = role
            break
          }
          if (spec && !spec.flags.includes(flag)) return undefined
        }
      }
      if (!token.closed || last) return undefined
      continue
    }
    if (!last) { if (!token.closed) return undefined; operands.push(token.value); continue }
    if (verb === 'cd' && operands.length) return undefined
    if (nonPathOperands.has(program) && !marker) return undefined
    if (leadingValue.has(program) && !operands.length && !patternProvided) return undefined
    if (!spec && !pathOperands.has(program) && !marker && (/^[^/]+:|^\d+$/.test(token.value))) return undefined
    const syntax = /^(?:\/|\.\.?\/|~\/)/.test(token.value)
    return result(token, i, spec?.kind ?? 'any', spec || marker || leadingValue.has(program) || pathOperands.has(program) || listingCommands.has(program)
      ? 'declared' : syntax ? 'syntax' : 'context')
  }
  return undefined
}

const listingCommands = new Set(['ls', 'eza', 'exa'])
const searchCommands = new Set(['grep', 'rg'])
function equivalentPathCommands(from: PathCommand, to: PathCommand): boolean {
  if (from.slot || to.slot) return false
  const fragment = from.fragment.split('/').slice(-1)[0]!, target = to.fragment.split('/').slice(-1)[0]!
  const fold = (value: string) => value.replace(/[-_]/g, '')
  if (fragment && !fold(target).startsWith(fold(fragment)) && !closeSpelling(fragment, target)) return false
  if (from.fragment.includes('/')) {
    const parent = from.fragment.endsWith('/') ? from.fragment.replace(/\/+$/, '') : parentPath(from.fragment)
    if (parent.startsWith('/') ? parentPath(to.fragment) !== parent : parent && parent !== '.' && !parentPath(to.fragment).endsWith('/' + parent.replace(/^\.\//, ''))) return false
  }
  if (listingCommands.has(from.verb) && listingCommands.has(to.verb)) return from.fixed.slice(1).every(value => /^-[alh]+$/.test(value))
  if (searchCommands.has(from.verb) && searchCommands.has(to.verb)) {
    const flags = from.fixed.slice(1, -from.operands.length || undefined)
    return from.operands.length === 1 && flags.every(value => /^-[Finlw]+$/.test(value))
      && (flags.some(value => value.includes('F')) || /^[\w -]+$/.test(from.operands[0]!))
  }
  return false
}

function explicitGoalCompatible(input: string, candidate: string): boolean {
  if (!commandName(input)) return true
  const from = words(input), to = words(candidate)
  if (!from?.length || !to?.length) return true
  const a = from[0]!.value, b = to[0]!.value
  const purpose = (name: string) => listingCommands.has(name) ? 'listing' : searchCommands.has(name) ? 'search'
    : specs[name] || ['rm', 'cp', 'mv', 'chmod', 'chown'].includes(name) ? name : undefined
  if (purpose(a) && purpose(b) && purpose(a) !== purpose(b)) return false
  if (a !== b && ['rm', 'mv', 'cp', 'chmod', 'chown', 'mkdir', 'touch', 'sudo'].includes(b)) return false
  if (a === b && ['git', 'docker', 'kubectl', 'systemctl', 'npm'].includes(a) && from[1]?.value && !from[1].value.startsWith('-')) {
    return !!to[1] && to[1].value.startsWith(from[1].value)
  }
  return true
}

/** Same-command paths lead; compatible alternatives may follow without changing the goal. */
export function preservesPathIntent(input: string, candidate: string): boolean {
  if (!explicitGoalCompatible(input, candidate)) return false
  const from = parsePathCommand(input), to = parsePathCommand(candidate)
  if (!hasPathCommand(input)) return !specs[input] || words(candidate)?.[0]?.value === input
  if (!from) {
    // Before a path operand, retain ordinary prefix completion of short flags.
    const before = words(input), after = words(candidate), spec = before && specs[before[0]!.value]
    return !!spec && before![0]!.value !== 'cd' && before!.length === 2 && after?.length === 2
      && candidate.startsWith(input) && before![1]!.closed && after.every(word => word.closed) && before![1]!.value.startsWith('-') && after[1]!.value.startsWith('-')
      && [...before![1]!.value.slice(1), ...after[1]!.value.slice(1)].every(flag => spec.flags.includes(flag))
  }
  return !!from && !!to && to.closed && !!to.fragment && from.slot === to.slot
    && (from.verb === to.verb || equivalentPathCommands(from, to))
    && from.fixed.length === to.fixed.length && from.fixed.slice(1).every((word, index) => word === to.fixed[index + 1])
}

export function commandPreference(input: string, candidate: string): number {
  const requested = commandName(input), offered = commandName(candidate)
  if (!requested) return 0
  if (requested === offered) return 2
  const from = parsePathCommand(input), to = parsePathCommand(candidate)
  return from && to && equivalentPathCommands(from, to) ? 1 : 0
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

export interface PathFacts { cwd: string; home?: string; directories: string[]; files: string[]; tools?: string[] }

export function completePaths(query: string, facts: PathFacts): string[] {
  const input = parsePathCommand(query)
  if (!input) return []
  if (input.evidence === 'context' && (!input.fragment || !facts.tools?.includes(input.verb))) return []
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
    .map(({ path }) => input.prefix + (input.separator ? '-- ' : '') + shellQuote(path))
}

export function alternativePaths(query: string, commands: readonly string[], tools: readonly string[]): string[] {
  const input = parsePathCommand(query)
  const group = input && (listingCommands.has(input.verb) ? listingCommands : searchCommands.has(input.verb) ? searchCommands : undefined)
  if (!input || !group) return []
  return tools.filter(tool => tool !== input.verb && group.has(tool)).flatMap(tool => commands.map(command => {
    const substituted = command.replace(/^\S+/, tool)
    const candidate = input.separator ? substituted.replace(' -- ', ' ') : substituted
    return preservesPathIntent(query, candidate) ? candidate : ''
  })).filter(Boolean)
}
