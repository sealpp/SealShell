import { beforeEach, describe, expect, it, vi } from 'vitest'
import { store, type EditorTab } from '../../stores/app'
import { posixPaths } from '../files/path'
import type { FileBackend } from '../files/types'
import { getFileBackend } from './file-tabs'
import { transferFile } from './transfer'
import { saveEditorTab } from './editor-tabs'

vi.mock('./file-tabs', () => ({ getFileBackend: vi.fn() }))
vi.mock('./transfer', () => ({ transferFile: vi.fn() }))

let tab: EditorTab
beforeEach(() => {
  vi.resetAllMocks()
  store.tabs = [{ id: 'file', kind: 'editor', endpoint: { kind: 'local', nodeId: 'fixture' }, label: 'note', state: 'online', error: '', sessionId: 'file', terminalId: '', encoding: 'utf-8',
    editor: { path: '/note', content: 'first', language: 'plaintext', encoding: 'utf-8', bom: false, lineEnding: '\n', size: 5, contentVersion: 0, dirty: true, largeFileConfirmed: false } }]
  tab = store.tabs[0] as EditorTab
  vi.mocked(getFileBackend).mockReturnValue({ paths: posixPaths } as FileBackend)
})

describe('editor save snapshots', () => {
  it.each([
    { content: 'new content' }, { encoding: 'utf-16le' }, { bom: true }, { lineEnding: '\r\n' }, { contentVersion: 1 },
  ])('keeps later edits dirty: %j', async update => {
    let finish!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    vi.mocked(transferFile).mockImplementation(async () => { await blocked; return { sourcePath: '/note', targetPath: '/note', bytes: 5, atomic: true, metadataApplied: true } })
    const saving = saveEditorTab(tab.id)
    await vi.waitFor(() => expect(transferFile).toHaveBeenCalledOnce())
    Object.assign(tab.editor, update)
    finish()
    await saving
    expect(tab.editor.dirty).toBe(true)
  })

  it('serializes concurrent requests and captures the latest content when each write starts', async () => {
    let finish!: () => void
    const blocked = new Promise<void>(resolve => { finish = resolve })
    const written: string[] = []
    vi.mocked(transferFile).mockImplementation(async source => {
      written.push(new TextDecoder().decode(await source.read('/note')))
      if (written.length === 1) await blocked
      return { sourcePath: '/note', targetPath: '/note', bytes: 5, atomic: true, metadataApplied: true }
    })
    const first = saveEditorTab(tab.id)
    await vi.waitFor(() => expect(written).toEqual(['first']))
    tab.editor.content = 'latest'
    const second = saveEditorTab(tab.id)
    expect(transferFile).toHaveBeenCalledOnce()
    finish()
    await Promise.all([first, second])
    expect(written).toEqual(['first', 'latest'])
    expect(tab.editor.dirty).toBe(false)
  })
})
