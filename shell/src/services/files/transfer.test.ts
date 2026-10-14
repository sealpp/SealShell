import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { FileOperationError, type FileBackend } from './types'
import { createFilePaths } from './path'
import { copyEntry } from '../sftp/operations'
import { transferFile, TransferCancelledError } from '../sftp/transfer'

const fixtures: string[] = []
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'seal-transfer-'))
  fixtures.push(root)
  return root
}
afterEach(async () => { for (const root of fixtures.splice(0)) await fs.rm(root, { recursive: true, force: true }) })

class DiskBackend implements FileBackend {
  paths = createFilePaths(process.platform === 'win32')
  namespace = 'test-disk'
  failCommit = ''
  failRead = false
  async disconnect() {}
  async stat(file: string) {
    try {
      const stat = await fs.lstat(file)
      return { name: path.basename(file), path: file, kind: stat.isDirectory() ? 'directory' as const : 'file' as const, size: stat.size, modifiedAt: stat.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new FileOperationError('not_found', file)
      throw error
    }
  }
  async list(directory: string) { return { path: directory, entries: await Promise.all((await fs.readdir(directory)).map(name => this.stat(path.join(directory, name)))) } }
  async read(file: string, offset = 0, length = 256 * 1024): Promise<ArrayBuffer> {
    if (this.failRead) throw new Error('read failed')
    const buffer = await fs.readFile(file)
    return Uint8Array.from(buffer.subarray(offset, offset + length)).buffer
  }
  async write(file: string, data: ArrayBuffer, offset = 0) {
    const handle = await fs.open(file, offset ? 'r+' : 'w')
    try { await handle.write(new Uint8Array(data), 0, data.byteLength, offset) } finally { await handle.close() }
  }
  async mkdir(file: string) { await fs.mkdir(file) }
  async remove(file: string, recursive = false) { await fs.rm(file, { recursive }) }
  async rename(source: string, target: string, overwrite = false) {
    if (target === this.failCommit && source.endsWith('.tmp')) throw new Error('commit failed')
    if (!overwrite) {
      try { await fs.lstat(target); throw new Error('exists') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    await fs.rename(source, target)
    return { atomic: true }
  }
}

describe('file and directory transfer preservation', () => {
  it('replaces the entire target tree and preserves the source including empty files', async () => {
    const root = await fixture()
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    await fs.mkdir(path.join(source, 'nested'), { recursive: true })
    await fs.mkdir(target)
    await fs.writeFile(path.join(source, 'nested/empty'), '')
    await fs.writeFile(path.join(source, 'hello.txt'), 'new contents')
    await fs.writeFile(path.join(target, 'obsolete.txt'), 'old')
    const backend = new DiskBackend()
    await copyEntry(backend, backend, source, target)
    expect(await fs.readdir(target)).toEqual(['hello.txt', 'nested'])
    expect(await fs.readFile(path.join(source, 'hello.txt'), 'utf8')).toBe('new contents')
    expect((await fs.stat(path.join(target, 'nested/empty'))).size).toBe(0)
    expect((await fs.readdir(root)).some(name => name.startsWith('.sealshell-'))).toBe(false)
  })
  it('keeps the original target tree when a source read fails', async () => {
    const root = await fixture()
    await fs.mkdir(path.join(root, 'src'))
    await fs.mkdir(path.join(root, 'dst'))
    await fs.writeFile(path.join(root, 'src/new'), 'new')
    await fs.writeFile(path.join(root, 'dst/old'), 'old')
    const backend = new DiskBackend()
    backend.failRead = true
    await expect(copyEntry(backend, backend, path.join(root, 'src'), path.join(root, 'dst'))).rejects.toThrow('read failed')
    expect(await fs.readdir(path.join(root, 'dst'))).toEqual(['old'])
    expect((await fs.readdir(root)).some(name => name.startsWith('.sealshell-'))).toBe(false)
  })
  it('restores the original target after the final rename fails', async () => {
    const root = await fixture()
    const backend = new DiskBackend()
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    await fs.writeFile(source, 'new')
    await fs.writeFile(target, 'old')
    backend.failCommit = target
    await expect(transferFile(backend, backend, source, target)).rejects.toThrow('commit failed')
    expect(await fs.readFile(target, 'utf8')).toBe('old')
    expect(await fs.readdir(root)).toEqual(['source', 'target'])
  })
  it('cancels before replacing the destination and rejects recursive self-copy', async () => {
    const root = await fixture()
    const backend = new DiskBackend()
    const source = path.join(root, 'source')
    const target = path.join(root, 'target')
    await fs.writeFile(source, Buffer.alloc(400000, 1))
    await fs.writeFile(target, 'old')
    const controller = new AbortController()
    await expect(transferFile(backend, backend, source, target, { signal: controller.signal, onProgress: () => controller.abort() })).rejects.toBeInstanceOf(TransferCancelledError)
    expect(await fs.readFile(target, 'utf8')).toBe('old')
    await expect(copyEntry(backend, backend, root, path.join(root, 'child'))).rejects.toThrow('子目录')
  })
})
