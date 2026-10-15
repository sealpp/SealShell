import { randomId } from '../../utils/id'
import { FileOperationError, statIfExists, type FileBackend, type FileReader, type FileWriter } from '../files/types'
import type { ProxySource } from '../proxy/types'

const CHUNK_SIZE = 256 * 1024

export interface TransferResult {
  sourcePath: string
  targetPath: string
  bytes: number
  atomic: boolean
  metadataApplied: boolean
  orphanPath?: string
}
export interface TransferOptions {
  signal?: AbortSignal
  onProgress?: (bytes: number, total: number) => void
}
export class TransferCancelledError extends Error {
  readonly code = 'TRANSFER_CANCELLED'
  constructor(readonly orphanPath?: string) { super('传输已取消') }
}
export class TransferOrphanError extends Error {
  readonly code = 'TRANSFER_ORPHAN'
  constructor(readonly orphanPath: string, cause: unknown) {
    super(`${cause instanceof Error ? cause.message : String(cause)}；保留项：${orphanPath}`)
  }
}
export function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new TransferCancelledError()
}
export function temporarySibling(backend: FileBackend, target: string, suffix = 'tmp'): string {
  return backend.paths.join(backend.paths.parent(target), `.sealshell-${randomId()}.${suffix}`)
}

// Direct replacement is used only for file providers which declare support.
// Directory replacement keeps the old tree until the new tree is complete.
export async function commitTemporary(backend: FileBackend, temporary: string, target: string): Promise<{ atomic: boolean; orphanPath?: string }> {
  const previous = await statIfExists(backend, target)
  if (!previous) return backend.rename(temporary, target, false)
  const incoming = await backend.stat(temporary)
  if (previous.kind !== incoming.kind) throw new Error('目标与源的文件类型不同，不能替换')
  if (incoming.kind === 'file' && backend.atomicReplace) return backend.rename(temporary, target, true)
  const backup = temporarySibling(backend, target, 'previous')
  await backend.rename(target, backup, false)
  try { await backend.rename(temporary, target, false) }
  catch (error) {
    try { await backend.rename(backup, target, false) }
    catch { throw new TransferOrphanError(backup, error) }
    throw error
  }
  try { await backend.remove(backup, true) }
  catch { return { atomic: false, orphanPath: backup } }
  return { atomic: false }
}

export async function transferFile(
  source: FileBackend, target: FileBackend,
  sourcePath: string, targetPath: string, options: TransferOptions = {},
): Promise<TransferResult> {
  const sourceStat = await source.stat(sourcePath)
  if (sourceStat.kind !== 'file') throw new Error('Only regular files can use the file transfer pipeline')
  const temporary = temporarySibling(target, targetPath)
  let bytes = 0
  let created = false
  let reader: FileReader | undefined
  let writer: FileWriter | undefined
  try {
    try {
      assertNotCancelled(options.signal)
      reader = await source.openReader?.(sourcePath)
      writer = await target.openWriter?.(temporary)
      if (!writer) await target.write(temporary, new ArrayBuffer(0), 0)
      created = true
      while (bytes < sourceStat.size) {
        assertNotCancelled(options.signal)
        const length = Math.min(CHUNK_SIZE, sourceStat.size - bytes)
        const chunk = reader ? await reader.read(bytes, length) : await source.read(sourcePath, bytes, length)
        if (!chunk.byteLength) throw new Error('源文件在传输完成前结束')
        const count = chunk.byteLength
        if (writer) await writer.write(bytes, chunk)
        else await target.write(temporary, chunk, bytes)
        bytes += count
        options.onProgress?.(bytes, sourceStat.size)
      }
    } finally {
      const closing = await Promise.allSettled([reader?.close(), writer?.close()])
      const failed = closing.find((item) => item.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }
    assertNotCancelled(options.signal)
    const temporaryStat = await target.stat(temporary)
    if (bytes !== sourceStat.size || temporaryStat.size !== sourceStat.size) throw new Error('传输文件大小校验失败')
    let metadataApplied = true
    try { if (sourceStat.mode !== undefined && target.chmod) await target.chmod(temporary, sourceStat.mode) } catch { metadataApplied = false }
    try { if (target.utimes) await target.utimes(temporary, sourceStat.modifiedAt) } catch { metadataApplied = false }
    const committed = await commitTemporary(target, temporary, targetPath)
    return { sourcePath, targetPath, bytes, ...committed, metadataApplied }
  } catch (error) {
    if (created) {
      try { await target.remove(temporary, true) }
      catch { throw new TransferOrphanError(temporary, error) }
    }
    throw error
  }
}

export type TransferTaskState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TransferTaskSnapshot {
  id: string
  label: string
  state: TransferTaskState
  progress: number
  error?: string
  proxySource?: ProxySource
  result?: TransferResult
  orphanPath?: string
}

export class TransferQueue {
  private concurrency = 2
  private running = 0
  private readonly queue: Array<{ snapshot: TransferTaskSnapshot; run: (signal: AbortSignal, progress: (bytes: number, total: number) => void) => Promise<TransferResult>; controller: AbortController; resolve: (result: TransferResult) => void; reject: (error: unknown) => void }> = []
  private readonly snapshots = new Map<string, TransferTaskSnapshot>()
  private readonly listeners = new Set<(snapshot: TransferTaskSnapshot) => void>()

  constructor(concurrency = 2) {
    this.setConcurrency(concurrency)
  }

  setConcurrency(value: number): number {
    this.concurrency = Math.max(1, Math.min(4, Math.floor(value) || 2))
    this.pump()
    return this.concurrency
  }

  getConcurrency(): number { return this.concurrency }
  list(): TransferTaskSnapshot[] { return Array.from(this.snapshots.values()) }
  subscribe(listener: (snapshot: TransferTaskSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }

  enqueue(label: string, run: (signal: AbortSignal, progress: (bytes: number, total: number) => void) => Promise<TransferResult>): { id: string; promise: Promise<TransferResult> } {
    const snapshot: TransferTaskSnapshot = { id: randomId(), label, state: 'queued', progress: 0 }
    this.snapshots.set(snapshot.id, snapshot)
    let resolve!: (result: TransferResult) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<TransferResult>((res, rej) => { resolve = res; reject = rej })
    this.queue.push({ snapshot, run, controller: new AbortController(), resolve, reject })
    this.emit(snapshot)
    this.pump()
    return { id: snapshot.id, promise }
  }

  cancel(id: string): boolean {
    const item = this.queue.find((candidate) => candidate.snapshot.id === id)
    if (!item || !['queued', 'running'].includes(item.snapshot.state)) return false
    item.controller.abort()
    if (item.snapshot.state === 'queued') {
      item.snapshot.state = 'cancelled'
      item.reject(new TransferCancelledError())
      this.emit(item.snapshot)
    }
    return true
  }

  retry(id: string): boolean {
    const item = this.queue.find((candidate) => candidate.snapshot.id === id)
    if (!item || !['failed', 'cancelled'].includes(item.snapshot.state)) return false
      item.snapshot.state = 'queued'
      item.snapshot.error = undefined
      item.snapshot.proxySource = undefined
      item.controller = new AbortController()
    item.snapshot.progress = 0
    this.emit(item.snapshot)
    this.pump()
    return true
  }

  private emit(snapshot: TransferTaskSnapshot): void {
    for (const listener of this.listeners) listener({ ...snapshot })
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const item = this.queue.find((candidate) => candidate.snapshot.state === 'queued')
      if (!item) return
      this.running += 1
      item.snapshot.state = 'running'
      this.emit(item.snapshot)
      void item.run(item.controller.signal, (bytes, total) => { item.snapshot.progress = total ? Math.min(1, bytes / total) : 0; this.emit(item.snapshot) }).then((result) => {
        item.snapshot.state = 'completed'
        item.snapshot.progress = 1
        item.snapshot.result = result
        item.snapshot.orphanPath = result.orphanPath
        item.resolve(result)
      }, (error: unknown) => {
        item.snapshot.state = error instanceof TransferCancelledError ? 'cancelled' : 'failed'
        item.snapshot.error = error instanceof Error ? error.message : String(error)
        if (error instanceof FileOperationError) item.snapshot.proxySource = error.proxySource
        if (error instanceof TransferOrphanError) item.snapshot.orphanPath = error.orphanPath
        item.reject(error)
      }).finally(() => {
        this.running -= 1
        this.emit(item.snapshot)
        this.pump()
      })
    }
  }
}
