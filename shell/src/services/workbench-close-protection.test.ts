import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { store, type Tab, type ShellState, type TabKind } from '../stores/app'
import { transferRuntime } from './sftp/transfer-runtime'
import { type TransferTaskState } from './sftp/transfer'
import { closeProtection } from './close-protection'
import { startWorkbenchCloseProtection } from './workbench-close-protection'

function tab(kind: TabKind, state: ShellState): Tab {
  return { id: 'tab', kind, state, label: 'test', error: '', sessionId: 'session', terminalId: '', telemetry: null, encoding: 'utf-8' }
}

let target: EventTarget
let stop: () => void
function blocked(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  target.dispatchEvent(event)
  return event.defaultPrevented
}

beforeEach(() => {
  store.tabs = []
  transferRuntime.tasks = []
  target = new EventTarget()
  stop = startWorkbenchCloseProtection(target)
})
afterEach(() => {
  stop()
  store.tabs = []
  transferRuntime.tasks = []
  expect(closeProtection.reasons.value).toEqual([])
})

describe('workbench exit policy', () => {
  it.each<TabKind>(['terminal', 'file', 'editor'])('protects %s sessions while connecting and online even with panels hidden', kind => {
    store.tabs = [tab(kind, 'idle')]
    store.bottomPanelOpen = false
    store.panelOpen = false
    expect(blocked()).toBe(false)
    store.tabs[0].state = 'connecting'
    expect(blocked()).toBe(true)
    store.tabs[0].state = 'online'
    expect(blocked()).toBe(true)
    store.tabs[0].state = 'error'
    expect(blocked()).toBe(false)
    store.tabs[0].state = 'online'
    store.tabs = []
    expect(blocked()).toBe(false)
  })

  it('protects unsaved edits after disconnect and releases them after save', () => {
    store.tabs = [{ ...tab('editor', 'error'), editor: {
      path: '/draft', language: 'text', dirty: true, encoding: 'utf-8', bom: false,
      lineEnding: '\n', content: 'draft', size: 5, largeFileConfirmed: false, contentVersion: 1,
    } }]
    expect(blocked()).toBe(true)
    store.tabs[0].editor!.dirty = false
    expect(blocked()).toBe(false)
  })

  it.each<[TransferTaskState, boolean]>([
    ['queued', true], ['running', true], ['completed', false], ['failed', false], ['cancelled', false],
  ])('protects only unfinished transfers: %s', (state, expected) => {
    transferRuntime.panelOpen = false
    transferRuntime.tasks = [{ id: 'transfer', label: 'test', state, progress: 0 }]
    expect(blocked()).toBe(expected)
  })

  it('keeps transfers protected after the last tab closes and ignores idle Node and inspector state', () => {
    store.nodeConnected = true
    store.panelOpen = true
    expect(blocked()).toBe(false)
    store.tabs = [tab('terminal', 'online')]
    transferRuntime.tasks = [{ id: 'transfer', label: 'test', state: 'running', progress: 0 }]
    store.tabs = []
    expect(blocked()).toBe(true)
    transferRuntime.tasks[0].state = 'completed'
    expect(blocked()).toBe(false)
  })

  it('disposes only its own registrations and reattaches without accumulating sources', () => {
    const release = closeProtection.acquire('external-operation')
    stop()
    expect(blocked()).toBe(false)
    expect(closeProtection.reasons.value).toEqual(['external-operation'])
    stop = startWorkbenchCloseProtection(target)
    expect(blocked()).toBe(true)
    release()
    expect(blocked()).toBe(false)
  })
})
