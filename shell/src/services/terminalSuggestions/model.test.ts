import { describe, expect, it } from 'vitest'
import { commonCommandProvider } from './catalog'
import { COMMAND_HISTORY_LIMIT, COMMAND_SUGGESTION_LIMIT, findCommandSuggestions, historyProvider, rememberCommand } from './model'

describe('local command suggestions', () => {
  it('offers bundled commands without any history or network request', () => {
    expect(findCommandSuggestions('gi', [commonCommandProvider])[0]?.command).toBe('git status')
    expect(findCommandSuggestions('docker p', [commonCommandProvider])[0]?.command).toBe('docker ps')
    for (const prefix of ['', 'g', 'Git', ' git', 'git\n', 'unknown-command']) {
      expect(findCommandSuggestions(prefix, [commonCommandProvider])).toEqual([])
    }
  })

  it('prioritizes local frequency, then recency, over bundled defaults', () => {
    let history = rememberCommand([], 'git log --all', 1)
    history = rememberCommand(history, 'git log --all', 2)
    history = rememberCommand(history, 'git diff --stat', 3)
    const suggest = () => findCommandSuggestions('git ', [commonCommandProvider, historyProvider(history)])[0]
    expect(suggest()).toMatchObject({ command: 'git log --all', source: 'history', uses: 2 })
    history = rememberCommand(history, 'git diff --stat', 4)
    expect(suggest()?.command).toBe('git diff --stat')
    expect(findCommandSuggestions('git diff --stat', [historyProvider(history)])).toEqual([])
  })

  it('deduplicates sources and leaves room for another local provider', () => {
    const history = historyProvider(rememberCommand([], 'git status', 1))
    expect(findCommandSuggestions('git s', [commonCommandProvider, history])[0]?.source).toBe('history')
    expect(findCommandSuggestions('my', [{ suggestions: () => [{ command: 'my-tool check', source: 'custom', priority: 2, uses: 0, lastUsed: 0 }] }])[0]?.command).toBe('my-tool check')
  })

  it('returns distinct ranked candidates and bounds the visible list', () => {
    const history = historyProvider(rememberCommand([], 'git status', 1))
    const candidates = findCommandSuggestions('git ', [commonCommandProvider, history])
    expect(candidates[0]).toMatchObject({ command: 'git status', source: 'history' })
    expect(candidates.filter(candidate => candidate.command === 'git status')).toHaveLength(1)
    expect(candidates.map(candidate => candidate.command)).toEqual(expect.arrayContaining(['git diff', 'git log --oneline']))
    const many = historyProvider(Array.from({ length: 20 }, (_, index) => ({ command: `echo ${index}`, uses: index + 1, lastUsed: index })))
    expect(findCommandSuggestions('echo ', [many])).toHaveLength(COMMAND_SUGGESTION_LIMIT)
    expect(findCommandSuggestions('echo ', [many])[0].command).toBe('echo 19')
  })

  it('does not store leading-space opt-outs, multiline input or control sequences', () => {
    for (const command of [' secret', '\tsecret', 'echo a\necho b', 'echo a\n', 'echo\x1b[A', 'x'.repeat(2049)]) {
      expect(rememberCommand([], command, 1)).toEqual([])
    }
    expect(rememberCommand([], 'echo 你好  ', 1)).toEqual([{ command: 'echo 你好', uses: 1, lastUsed: 1 }])
  })

  it('bounds storage by recent unique commands while retaining their frequency', () => {
    let history = rememberCommand([], 'echo oldest', 0)
    for (let i = 1; i <= COMMAND_HISTORY_LIMIT; i++) history = rememberCommand(history, `echo ${i}`, i)
    expect(history).toHaveLength(COMMAND_HISTORY_LIMIT)
    expect(history.some(entry => entry.command === 'echo oldest')).toBe(false)
    history = rememberCommand(history, 'echo 1', 1000)
    expect(history[0]).toEqual({ command: 'echo 1', uses: 2, lastUsed: 1000 })
    expect(history).toHaveLength(COMMAND_HISTORY_LIMIT)
  })
})
