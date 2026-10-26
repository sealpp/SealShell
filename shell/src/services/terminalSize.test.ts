import { beforeEach, expect, it, vi } from 'vitest'
import { store, type Tab } from '../stores/app'
import { publishTerminalSize, waitForTerminalSize } from './terminalSize'

function tab(id: string): Tab {
  return { id, kind: 'terminal', label: id, state: 'connecting', error: '', sessionId: id, terminalId: id, encoding: 'utf-8' }
}

beforeEach(() => { store.tabs = [tab('a'), tab('b'), tab('c')] })

it('waits for a measured viewport rather than returning the xterm default size', async () => {
  const resolved = vi.fn()
  const waiting = waitForTerminalSize('a', 'a').then(resolved)
  await Promise.resolve()
  expect(resolved).not.toHaveBeenCalled()
  publishTerminalSize(['a'], { columns: 123, rows: 41 })
  await waiting
  expect(resolved).toHaveBeenCalledWith({ columns: 123, rows: 41 })
})

it('shares valid geometry with detached peers in the same group and caches it for reconnects', async () => {
  const first = waitForTerminalSize('a', 'a')
  const background = waitForTerminalSize('b', 'b')
  publishTerminalSize(['a', 'b'], { columns: 60, rows: 30 })
  expect(await first).toEqual({ columns: 60, rows: 30 })
  expect(await background).toEqual({ columns: 60, rows: 30 })
  expect(store.tabs[2].viewportSize).toBeUndefined()
  store.tabs[1].sessionId = 'reconnected'
  expect(await waitForTerminalSize('b', 'reconnected')).toEqual({ columns: 60, rows: 30 })
})

it('cancels the wait if the tab is closed before measurement', async () => {
  const waiting = waitForTerminalSize('a', 'a')
  store.tabs = store.tabs.filter(tab => tab.id !== 'a')
  expect(await waiting).toBeUndefined()
  expect(await waitForTerminalSize('a', 'a')).toBeUndefined()
})

it('cancels a superseded session without consuming its replacement viewport', async () => {
  const waiting = waitForTerminalSize('a', 'a')
  store.tabs[0].sessionId = 'replacement'
  publishTerminalSize(['a'], { columns: 100, rows: 30 })
  expect(await waiting).toBeUndefined()
  expect(await waitForTerminalSize('a', 'replacement')).toEqual({ columns: 100, rows: 30 })
})
