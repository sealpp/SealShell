import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { FsRequestSchema, type FsResponse, type FsInfo, type FsEntry } from '../../proto/seal_pb'
import type { FileEntry } from '../../stores/app'
import { NodeConnection } from '../node-connection'
import { createFilePaths, posixPaths } from './path'
import { FileOperationError, type FileBackend, type FileReader, type FileWriter, type FileDirectoryPage } from './types'

type Result = FsResponse['result']
type ResultValues = { [K in Exclude<Result['case'], undefined>]: Extract<Result, { case: K }>['value'] }
function resultValue<C extends Exclude<Result['case'], undefined>>(result: Result, kind: C): ResultValues[C] {
  if (result.case !== kind) throw new Error(`Unexpected filesystem response: ${result.case}`)
  return result.value as ResultValues[C]
}
function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('File offset exceeds the supported range')
  return Number(value)
}
function fileEntry(value: FsEntry): FileEntry {
  return { name: value.name, path: value.path, kind: value.kind as FileEntry['kind'], size: safeNumber(value.size), modifiedAt: safeNumber(value.modifiedAtMs), mode: value.mode, hidden: value.hidden }
}

export class NodeFileBackend implements FileBackend {
  private readonly connection = new NodeConnection()
  paths = posixPaths
  namespace = ''
  nodeId = ''
  info!: FsInfo
  readonly atomicReplace = true

  async connect(): Promise<void> {
    this.nodeId = await this.connection.connect()
    try {
      this.info = resultValue(await this.rpc({ case: 'info', value: {} }), 'info')
      this.paths = createFilePaths(this.info.platform === 'win32')
      this.namespace = `local:${this.nodeId}`
    } catch (error) { this.connection.close(); throw error }
  }
  async disconnect(): Promise<void> { this.connection.close() }

  private async rpc(operation: MessageInitShape<typeof FsRequestSchema>['operation']): Promise<Result> {
    const message = await this.connection.request({ case: 'fsRequest', value: create(FsRequestSchema, { operation }) })
    if (message.body.case !== 'fsResponse') throw new Error('Unexpected Node filesystem response')
    const result = message.body.value.result
    if (result.case === 'error') throw new FileOperationError(result.value.code, result.value.message)
    return result
  }

  async list(path: string, cursor?: string): Promise<FileDirectoryPage> {
    const handle = cursor ? BigInt(cursor) : resultValue(await this.rpc({ case: 'openDirectory', value: { path } }), 'opened').handle
    try {
      const page = resultValue(await this.rpc({ case: 'readDirectory', value: { handle } }), 'directory')
      return { path, entries: page.entries.map(fileEntry), nextCursor: page.eof ? undefined : String(handle) }
    } catch (error) { await this.closeHandle(handle).catch(() => undefined); throw error }
  }
  async stat(path: string, followLinks = false): Promise<FileEntry> {
    return fileEntry(resultValue(await this.rpc({ case: 'stat', value: { path, followLinks } }), 'stat'))
  }
  private async closeHandle(handle: bigint): Promise<void> { await this.rpc({ case: 'close', value: { handle } }) }

  async openReader(path: string): Promise<FileReader> {
    const handle = resultValue(await this.rpc({ case: 'open', value: { path } }), 'opened').handle
    return {
      read: async (offset, length) => {
        const data = resultValue(await this.rpc({ case: 'read', value: { handle, offset: BigInt(offset), length: Math.min(length, this.info.maxChunkBytes) } }), 'read')
        return data.payload.slice().buffer as ArrayBuffer
      },
      close: () => this.closeHandle(handle),
    }
  }

  async openWriter(path: string): Promise<FileWriter> {
    const handle = resultValue(await this.rpc({ case: 'open', value: { path, write: true, create: true, exclusive: true } }), 'opened').handle
    return this.writer(handle)
  }
  private writer(handle: bigint): FileWriter {
    return {
      write: async (offset, data) => {
        const bytes = new Uint8Array(data)
        for (let index = 0; index < bytes.length; index += this.info.maxChunkBytes) {
          const payload = bytes.subarray(index, index + this.info.maxChunkBytes)
          const value = resultValue(await this.rpc({ case: 'write', value: { handle, offset: BigInt(offset + index), payload } }), 'written')
          if (value.bytesWritten !== payload.length) throw new Error('Incomplete local file write')
        }
      },
      close: () => this.closeHandle(handle),
    }
  }

  async read(path: string, offset = 0, length?: number): Promise<ArrayBuffer> {
    const size = length ?? Math.max(0, (await this.stat(path, true)).size - offset)
    const bytes = new Uint8Array(size)
    const reader = await this.openReader(path)
    let count = 0
    try {
      while (count < size) {
        const chunk = new Uint8Array(await reader.read(offset + count, size - count))
        if (!chunk.length) break
        bytes.set(chunk, count)
        count += chunk.length
      }
      return bytes.slice(0, count).buffer
    } finally { await reader.close() }
  }

  async write(path: string, data: ArrayBuffer, offset = 0): Promise<void> {
    const handle = resultValue(await this.rpc({ case: 'open', value: { path, write: true, create: true, truncate: offset === 0 } }), 'opened').handle
    const writer = this.writer(handle)
    try { await writer.write(offset, data) } finally { await writer.close() }
  }
  async mkdir(path: string): Promise<void> { await this.rpc({ case: 'mkdir', value: { path } }) }
  async remove(path: string, recursive = false): Promise<void> {
    if (recursive && (await this.stat(path)).kind === 'directory') {
      const entries: FileEntry[] = []
      let cursor: string | undefined
      do {
        const page = await this.list(path, cursor)
        entries.push(...page.entries)
        cursor = page.nextCursor
      } while (cursor)
      for (const child of entries) await this.remove(child.path, true)
    }
    await this.rpc({ case: 'remove', value: { path } })
  }
  async rename(source: string, target: string, overwrite = false): Promise<{ atomic: boolean }> {
    await this.rpc({ case: 'rename', value: { source, target, replace: overwrite } })
    return { atomic: true }
  }
  async utimes(path: string, modifiedAt: number): Promise<void> { await this.rpc({ case: 'setTime', value: { path, modifiedAtMs: BigInt(Math.trunc(modifiedAt)) } }) }
  async readlink(path: string): Promise<string> { return resultValue(await this.rpc({ case: 'readLink', value: { path } }), 'link').target }
  async symlink(target: string, path: string): Promise<void> { await this.rpc({ case: 'symlink', value: { target, path } }) }
}
