import { FileOperationError } from '../files/types'
import { posixPaths } from '../files/path'
import { describe, expect, it } from 'vitest'
import { canPasteSftpClipboard, clearSftpClipboardAfterPaste, createSftpClipboardPayload } from './clipboard'
import { normalizeRemotePath, parentRemotePath } from './path'
import { isVisibleFileEntry, sortFileEntries } from './sort'
import { runSftpFeasibilitySpike } from './spike'
import { responseError, transferablesForRequest } from './worker-protocol'
import { transferFile, TransferOrphanError } from './transfer'
import type { FileEntry } from '../../stores/app'
import type { SftpBackend } from './types'

function entry(path: string, kind: FileEntry['kind'], size = 0): FileEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind, size, modifiedAt: 0 }
}

class MemoryBackend implements SftpBackend {
  readonly paths = posixPaths
  readonly files = new Map<string, Uint8Array>()
  readonly stats = new Map<string, FileEntry>()
  get atomicReplace() { return this.overwrite }
  overwrite = false
  failCleanup = false

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async list(path: string): Promise<{ path: string; entries: FileEntry[] }> { return { path, entries: Array.from(this.stats.values()).filter((item) => item.path.startsWith(`${path}/`)) } }
  async stat(path: string): Promise<FileEntry> {
    const known = this.stats.get(path)
    if (known) return known
    const data = this.files.get(path)
    if (data) return entry(path, 'file', data.byteLength)
    throw new FileOperationError('not_found', 'not found')
  }
  async read(path: string, offset = 0, length = 256 * 1024): Promise<ArrayBuffer> { return (this.files.get(path) ?? new Uint8Array()).slice(offset, offset + length).buffer }
  async write(path: string, data: ArrayBuffer, offset = 0): Promise<void> {
    const current = this.files.get(path) ?? new Uint8Array()
    const next = new Uint8Array(Math.max(current.byteLength, offset + data.byteLength))
    next.set(current)
    next.set(new Uint8Array(data), offset)
    this.files.set(path, next)
    this.stats.set(path, entry(path, 'file', next.byteLength))
  }
  async mkdir(path: string): Promise<void> { this.stats.set(path, entry(path, 'directory')) }
  async remove(path: string): Promise<void> {
    if (this.failCleanup && path.includes('.sealshell-')) throw new Error('cleanup failed')
    this.files.delete(path)
    this.stats.delete(path)
  }
  async rename(source: string, target: string, overwrite = false): Promise<{ atomic: boolean }> {
    if (!overwrite && this.files.has(target)) throw new Error('exists')
    if (this.files.has(source)) { this.files.set(target, this.files.get(source) as Uint8Array); this.files.delete(source) }
    this.stats.delete(source)
    this.stats.set(target, entry(target, 'file', this.files.get(target)?.byteLength ?? 0))
    return { atomic: this.overwrite }
  }
  supports(extension: string): boolean { return extension === 'posix-rename@openssh.com' && this.overwrite }
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

  it('validates bytes and commits through an atomic rename extension', async () => {
    const source = new MemoryBackend()
    const target = new MemoryBackend()
    target.overwrite = true
    await source.write('/src.txt', new TextEncoder().encode('hello').buffer)
    source.stats.set('/src.txt', entry('/src.txt', 'file', 5))
    const result = await transferFile(source, target, '/src.txt', '/dst.txt')
    expect(result.atomic).toBe(true)
    expect(new TextDecoder().decode(target.files.get('/dst.txt'))).toBe('hello')
    expect(Array.from(target.files.keys()).some((path) => path.includes('.sealshell-'))).toBe(false)
  })

  it('retains an orphan when temporary cleanup fails', async () => {
    const source = new MemoryBackend()
    const target = new MemoryBackend()
    target.failCleanup = true
    await source.write('/src.txt', new TextEncoder().encode('hello').buffer)
    source.stats.set('/src.txt', entry('/src.txt', 'file', 99))
    await expect(transferFile(source, target, '/src.txt', '/dst.txt')).rejects.toBeInstanceOf(TransferOrphanError)
  })
})

describe('SFTP worker contract', () => {
  it('marks malformed response errors and transfers write buffers', () => {
    expect(responseError('1', 'BAD_VERSION', 'unsupported').ok).toBe(false)
    const payload = new ArrayBuffer(2)
    expect(transferablesForRequest({ version: 1, id: '1', type: 'write', path: '/x', payload })).toEqual([payload])
  })

  it('runs the feasibility loop against an explicit backend', async () => {
    const backend = new MemoryBackend()
    const result = await runSftpFeasibilitySpike(backend, { sessionId: 'spike', host: 'example', port: 22, username: 'user', password: '' })
    expect(result.backend).toBe('sftp-backend')
    expect(result.checks.independentSessions).toBe(true)
  })
})
