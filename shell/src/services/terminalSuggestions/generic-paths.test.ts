import { describe, expect, it } from 'vitest'
import { pathSuggestions } from './context'
import type { DirectoryFacts } from './context'
import { findCommandSuggestions } from './model'
import { preservesPathIntent } from './paths'

const facts = { cwd: '/work', directories: ['/work/project', '/work/include', '/work/destination'],
  files: ['/work/app.log', '/work/settings.json', '/work/archive.tar', '/work/ERROR', '/work/8080'],
  scripts: [], tools: ['custom-cli', 'cp', 'mv', 'rm', 'wc', 'grep', 'rg', 'tar', 'gcc', 'eza'] }
const commands = (input: string, context: DirectoryFacts = facts) => pathSuggestions(input, context).map(item => item.command)

describe('path roles beyond a command allowlist', () => {
  it.each(['custom-cli', 'cp', 'mv', 'rm', 'wc'])('infers a verified filename for %s', command => {
    expect(commands(`${command} app.lgo`)).toContain(`${command} '/work/app.log'`)
  })
  it('uses explicit path syntax even without predeclared command metadata', () => {
    expect(commands('another-cli ./app.lgo')).toContain("another-cli '/work/app.log'")
    expect(commands('/opt/bin/another-cli ./app.lgo')).toContain("/opt/bin/another-cli '/work/app.log'")
    expect(commands('/opt/工具 ./app.lgo')).toContain("/opt/工具 '/work/app.log'")
    expect(commands('show app', { ...facts, tools: [] })).toEqual([])
  })
  it('preserves previous operands and an unknown command option prefix', () => {
    expect(commands('cp -r project dest')).toContain("cp -r project '/work/destination'")
    expect(commands('custom-cli --verbose app')).toContain("custom-cli --verbose '/work/app.log'")
  })
  it('completes path-valued options in separated and assigned forms without inserting --', () => {
    expect(commands('custom-cli --config sett')).toContain("custom-cli --config '/work/settings.json'")
    expect(commands('custom-cli --config=sett')).toContain("custom-cli --config='/work/settings.json'")
    expect(commands('custom-cli --asset-file=./app')).toContain("custom-cli --asset-file='/work/app.log'")
    expect(commands('git -C proj')).toContain("git -C '/work/project'")
    expect(commands('tar -xzf arch')).toContain("tar -xzf '/work/archive.tar'")
    expect(commands('gcc -Iinc')).toContain("gcc -I'/work/include'")
  })
  it('does not confuse grep patterns, chmod modes, numbers, hostnames, URLs or subcommands with paths', () => {
    for (const input of ['grep ERROR', 'grep -e ERROR', 'find . -name app', 'chmod 755', 'ssh project', 'git project',
      'custom-cli --port 8080', 'custom-cli --pattern=app', 'curl https://example.org/app', 'custom-cli 8080']) {
      expect(commands(input), input).toEqual([])
    }
    expect(commands('grep ERROR app.lgo')).toContain("grep ERROR '/work/app.log'")
    expect(commands('grep -f sett')).toContain("grep -f '/work/settings.json'")
    expect(commands('chmod 755 app.lgo')).toContain("chmod 755 '/work/app.log'")
  })
  it('keeps existing exact input paths ahead of spelling alternatives', () => {
    expect(commands('custom-cli app.log')).toEqual(["custom-cli '/work/app.log'"])
    expect(commands('ls 808')).toContain("ls -- '/work/8080'")
    expect(commands('rm 808')).toContain("rm '/work/8080'")
  })
})

describe('explicit command preference', () => {
  const candidate = (command: string, uses = 0) => ({ command, source: 'ai', priority: 2, uses, lastUsed: uses })
  it('ranks the requested executable above even a frequently used alternative', () => {
    const result = findCommandSuggestions('ls -la app', [{ suggestions: () => [
      candidate("eza -la '/work/app.log'", 100), candidate("ls -la '/work/app.log'"), candidate('cd /work/app.log'),
    ] }])
    expect(result.map(item => item.command)).toEqual(["ls -la '/work/app.log'", "eza -la '/work/app.log'"])
  })
  it('keeps the user executable preferred for commands outside the path profiles', () => {
    const result = findCommandSuggestions('custom-cli status', [{ suggestions: () => [
      candidate('different-cli status', 100), candidate('custom-cli status --verbose'),
    ] }])
    expect(result[0]?.command).toBe('custom-cli status --verbose')
  })
  it('offers only available listing alternatives with compatible options and the same target', () => {
    expect(commands('ls -la app')).toEqual(["ls -la -- '/work/app.log'", "eza -la '/work/app.log'"])
    expect(commands('ls -la app', { ...facts, tools: [] })).toEqual(["ls -la -- '/work/app.log'"])
    expect(commands('cd proj')).toEqual(["cd -- '/work/project'"])
    expect(commands('grep -n ERROR app')).toEqual(["grep -n ERROR '/work/app.log'", "rg -n ERROR '/work/app.log'"])
    expect(preservesPathIntent('git status', 'git reset --hard')).toBe(false)
    expect(preservesPathIntent('docker logs web', 'docker ps')).toBe(false)
    expect(preservesPathIntent('grep ERROR', 'cat /work/ERROR')).toBe(false)
    expect(preservesPathIntent('git stat', 'git status --short')).toBe(true)
    expect(preservesPathIntent('ls -la app', 'eza -la /work/unrelated')).toBe(false)
    expect(preservesPathIntent('custom-cli app', 'rm /work/app.log')).toBe(false)
    // The probe is a separate shell; absence there cannot disprove an active alias or environment.
    expect(commands('eza -la app', { ...facts, tools: ['ls'] })).toEqual(["eza -la '/work/app.log'", "ls -la '/work/app.log'"])
  })
})
