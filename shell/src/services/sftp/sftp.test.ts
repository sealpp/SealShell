import { describe, expect, it } from 'vitest'
import { canPasteSftpClipboard, clearSftpClipboardAfterPaste, createSftpClipboardPayload } from './clipboard'
import { normalizeRemotePath, parentRemotePath } from './path'
import { isVisibleFileEntry, sortFileEntries } from './sort'
import type { FileEntry } from '../../stores/app'

function entry(path: string, kind: FileEntry['kind'], size = 0): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind, size, modifiedAt: 0 }
}

describe('SFTP path and listing primitives', () => {
  it('normalizes absolute paths without escaping root', () => {
    expect(normalizeRemotePath('../etc', '/srv/app')).toBe('/srv/etc')
    expect(normalizeRemotePath('/../../')).toBe('/')
    expect(parentRemotePath('/srv/app')).toBe('/srv')
  })

  it('sorts naturally, keeps directories first, and excludes temporary files', () => {
    const items = [entry('/a10', 'file'), entry('/a2', 'file'), entry('/dir', 'directory'), { ...entry('/.tmp', 'file'), temporary: true }]
    expect(sortFileEntries(items.filter((item) => isVisibleFileEntry(item, false)), 'name', 'asc').map((item) => item.name)).toEqual(['dir', 'a2', 'a10'])
    expect(isVisibleFileEntry({ ...entry('/.x', 'file'), hidden: true }, false)).toBe(false)
    expect(isVisibleFileEntry({ ...entry('/.x', 'file'), hidden: true }, true)).toBe(true)
    expect(isVisibleFileEntry({ ...entry('/.tmp', 'file'), temporary: true }, true)).toBe(false)
  })
})

describe('SFTP clipboard and transfer pipeline', () => {
  it('allows cross-session cut as copy and consumes it after paste', () => {
    const payload = createSftpClipboardPayload('cut', 'a', 'session-a', [entry('/src.txt', 'file', 2)])
    expect(canPasteSftpClipboard(payload, 'session-b')).toBe(true)
    expect(clearSftpClipboardAfterPaste(payload, 'session-b')).toBeNull()
  })

})
