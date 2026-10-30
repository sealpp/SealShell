import { describe, expect, it } from 'vitest'
import { COMMAND_HISTORY_LIMIT, COMMAND_SUGGESTION_LIMIT, findCommandSuggestions, historyProvider, rememberCommand } from './model'

describe('local command suggestions', () => {
  it('returns matching history unchanged, including relative paths and compound commands', () => {
    let entries = rememberCommand([], 'cd projects/demo && ls', 1, { cwd: '/old' })
    entries = rememberCommand(entries, 'cd projects/archive', 2, { cwd: '/other' })
    expect(findCommandSuggestions('cd projects', [historyProvider(entries)]).map(item => item.command))
      .toEqual(['cd projects/archive', 'cd projects/demo && ls'])
    expect(findCommandSuggestions('cd projectz', [historyProvider(entries)])).toEqual([])
  })
  it('does not invent commands when history is empty', () => {
    for (const input of ['g', 'git ', 'cd demo', 'docker p', '']) expect(findCommandSuggestions(input, [historyProvider([])])).toEqual([])
  })

  it('remembers single-character commands and matches a single Unicode character', () => {
    const history = rememberCommand(rememberCommand([], 'q', 1), '查询日志', 2)
    expect(history).toEqual(expect.arrayContaining([{ command: 'q', uses: 1, lastUsed: 1 }]))
    expect(findCommandSuggestions('查', [historyProvider(history)])[0]?.command).toBe('查询日志')
  })

  it('orders history by frequency and recency', () => {
    let history = rememberCommand([], 'git log --all', 1)
    history = rememberCommand(history, 'git log --all', 2)
    history = rememberCommand(history, 'git diff --stat', 3)
    const suggest = () => findCommandSuggestions('git ', [historyProvider(history)])[0]
    expect(suggest()).toMatchObject({ command: 'git log --all', source: 'history', uses: 2 })
    history = rememberCommand(history, 'git diff --stat', 4)
    expect(suggest()?.command).toBe('git diff --stat')
    expect(findCommandSuggestions('git diff --stat', [historyProvider(history)])).toEqual([])
  })

  it('returns distinct ranked candidates and bounds the visible list', () => {
    const history = historyProvider(rememberCommand([], 'git status', 1))
    const candidates = findCommandSuggestions('git ', [history, history])
    expect(candidates[0]).toMatchObject({ command: 'git status', source: 'history' })
    expect(candidates.filter(candidate => candidate.command === 'git status')).toHaveLength(1)
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
