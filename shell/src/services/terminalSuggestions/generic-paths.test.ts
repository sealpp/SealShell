import { describe, expect, it } from 'vitest'
import { findCommandSuggestions } from './model'
import { preservesPathIntent } from './paths'

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
  it('rejects a changed goal and preserves known compatible alternatives', () => {
    expect(preservesPathIntent('git status', 'git reset --hard')).toBe(false)
    expect(preservesPathIntent('docker logs web', 'docker ps')).toBe(false)
    expect(preservesPathIntent('grep ERROR', 'cat /work/ERROR')).toBe(false)
    expect(preservesPathIntent('git stat', 'git status --short')).toBe(true)
    expect(preservesPathIntent('ls -la app', 'eza -la /work/unrelated')).toBe(false)
    expect(preservesPathIntent('ls -la app', 'eza -la /work/app.log')).toBe(true)
    expect(preservesPathIntent('custom-cli app', 'rm /work/app.log')).toBe(false)
  })
})
