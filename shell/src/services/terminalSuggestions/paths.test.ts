import { describe, expect, it } from 'vitest'
import { pathSuggestions } from './context'
import { findCommandSuggestions, historyProvider, rememberCommand } from './model'
import { preservesPathIntent } from './paths'

const facts = { cwd: '/work', home: '/home/dev', directories: ['/work/demo_web', '/work/demo-web', '/work/codes', '/work/codes/client', '/work/Documents', '/home/dev/projects'],
  files: ['/work/app.log', '/work/README.md', '/work/team\'s notes.txt', '/work/codes/client.json'], scripts: [], tools: [] }
const commands = (query: string, context = facts) => pathSuggestions(query, context).map(item => item.command)

describe('path argument completion', () => {
  it('corrects names from actual entries without changing the command', () => {
    expect(commands('cd demoweb')).toEqual(["cd -- '/work/demo-web'", "cd -- '/work/demo_web'"])
    expect(commands('ls demoweb')).toEqual(["ls -- '/work/demo-web'", "ls -- '/work/demo_web'"])
    expect(commands('cd Documetns')).toEqual(["cd -- '/work/Documents'"])
    expect(commands('cat app.lgo')).toEqual(["cat -- '/work/app.log'"])
  })
  it('keeps exact case-sensitive paths ahead of approximate names', () => {
    expect(commands('cd demo', { ...facts, directories: ['/work/Demo', '/work/demo', '/work/demo_web'] })).toEqual(["cd -- '/work/demo'"])
    expect(commands('cd /work/demo_web')).toEqual(["cd -- '/work/demo_web'"])
  })
  it.each(['ls -lah', 'ls --color=auto', 'tail -n 20 -f', 'head --lines=10', 'stat -c %s', 'du -sh', 'less -N', 'cat -n'])('preserves options for %s', prefix => {
    expect(commands(prefix + ' app.lgo')).toEqual([`${prefix} -- '/work/app.log'`])
  })
  it('changes only the final path operand', () => {
    expect(commands('ls -l README.md app.lgo')).toEqual(["ls -l README.md -- '/work/app.log'"])
    expect(commands('cat README.md app.lgo')).toEqual(["cat README.md -- '/work/app.log'"])
    expect(commands('ls -- app.lgo')).toEqual(["ls -- '/work/app.log'"])
  })
  it('resolves explicit parents and home, keeping directory boundaries', () => {
    expect(commands('ls codes/cli')).toEqual(["ls -- '/work/codes/client'", "ls -- '/work/codes/client.json'"])
    expect(commands('ls codes/')).toEqual(["ls -- '/work/codes/client'", "ls -- '/work/codes/client.json'"])
    expect(commands('cd ~/proj')).toEqual(["cd -- '/home/dev/projects'"])
    expect(commands('cd ../work/demo_web')).toEqual(["cd -- '/work/demo_web'"])
    expect(commands('cd missing/demo_web')).toEqual([])
  })
  it('handles incomplete quotes and shell escapes using literal path names', () => {
    expect(commands("cat 'team")).toEqual(["cat -- '/work/team'\\''s notes.txt'"])
    expect(commands('cat team\\\'s\\ notes')).toEqual(["cat -- '/work/team'\\''s notes.txt'"])
    expect(commands('cat "~"', { ...facts, files: ['/work/~'] })).toEqual(["cat -- '/work/~'"])
  })
  it('filters by operand type, limits typo distance, and does not guess a missing target', () => {
    expect(commands('cd app.log')).toEqual([])
    expect(commands('cat demo_web')).toEqual([])
    expect(commands('cd unrelated')).toEqual([])
  })
  it.each(['ls --ignore pattern', 'head -n ', 'head -n 20', 'ls --unknown foo', 'cd -', 'ls *.log', 'ls $HOME', 'ls $(pwd)', 'ls foo | cat', 'ls foo > output', 'cd a b'])('does not reinterpret unsupported input: %s', input => {
    expect(commands(input)).toEqual([])
  })
  it('allows literal shell characters only when they were quoted', () => {
    expect(commands("ls 'semi'", { ...facts, files: ['/work/semi;colon'] })).toEqual(["ls -- '/work/semi;colon'"])
  })
  it('offers children for an empty operand and preserves an operand named --', () => {
    expect(commands('cd ', { ...facts, directories: ['/work', '/work/codes'] })).toEqual(["cd -- '/work/codes'"])
    expect(preservesPathIntent('ls -- -- app', "ls -- '/work/app.log'")).toBe(false)
    expect(preservesPathIntent('ls -- -- app', "ls -- -- '/work/app.log'")).toBe(true)
    expect(preservesPathIntent('ls', 'ls -la')).toBe(true)
    expect(preservesPathIntent('ls', 'cd /work')).toBe(false)
    expect(preservesPathIntent('ls -l', 'ls -la')).toBe(true)
    expect(preservesPathIntent('ls -l', "ls -la'")).toBe(false)
    expect(preservesPathIntent('ls -', 'ls -la')).toBe(true)
    expect(preservesPathIntent('ls -l app', 'ls -la /work/app.log')).toBe(false)
  })
})

it('history cannot change the executable, options, or add a command chain to a path input', () => {
  const history = ['ls /work/demo', 'cd /work/demo && ls', 'cd /work/demo', 'echo cd demo']
    .reduce((items, command) => rememberCommand(items, command, 1), [] as ReturnType<typeof rememberCommand>)
  expect(findCommandSuggestions('cd demo', [historyProvider(history)]).map(item => item.command)).toEqual(['cd /work/demo'])
  const arbitrary = { suggestions: () => ["ls '/work/app.log'", "ls -l '/work/app.log'", "ls -l '/work/app.log' && cat /etc/passwd"]
    .map(command => ({ command, source: 'ai', priority: 2, uses: 0, lastUsed: 0 })) }
  expect(findCommandSuggestions('ls -l app', [arbitrary]).map(item => item.command)).toEqual(["ls -l '/work/app.log'"])
})
