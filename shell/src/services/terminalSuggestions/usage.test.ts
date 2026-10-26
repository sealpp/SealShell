import { describe, expect, it } from 'vitest'
import { rememberCommand } from './model'

describe('contextual usage memory', () => {
  it('keeps acceptance separate from submitted directory evidence', () => {
    let entries = rememberCommand([], 'python3 main.py', 1, { kind: 'accepted', cwd: '/work' })
    expect(entries[0]).toMatchObject({ uses: 0, accepted: 1 })
    expect(entries[0].contexts).toBeUndefined()
    entries = rememberCommand(entries, 'python3 main.py', 2, { cwd: '/work' })
    entries = rememberCommand(entries, 'python3 other.py', 3, { cwd: '/other' })
    expect(entries.find(item => item.command === 'python3 main.py')).toMatchObject({ uses: 1, accepted: 1, contexts: [{ cwd: '/work', uses: 1, lastUsed: 2 }] })
  })
})
