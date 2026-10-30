import { nativeCall, NativeCallError } from '../../native/bridge'
import type { RemoteConnection } from '../proxy/types'
import { initializeNativeEvents } from '../native-events'
import { createFilePaths } from './path'
import { FileOperationError, type FileBackend, type FileDirectoryPage, type FileReader, type FileWriter } from './types'
import type { FileEntry } from '../../stores/app'

export class NativeFileBackend implements FileBackend {
  readonly nativeId = crypto.randomUUID()
  readonly paths
  namespace = ''
  atomicReplace = false
  info!: { home: string; roots: string[]; platform: string; maxChunkBytes: number }
  fork?: (signal?: AbortSignal) => Promise<FileBackend>
  private closed = false
  private signal?: AbortSignal
  private readonly abort = () => { void this.disconnect() }

  constructor(readonly connection?: RemoteConnection) { this.paths = createFilePaths(!connection) }
  async connect(signal?: AbortSignal): Promise<void> {
    this.signal = signal
    signal?.throwIfAborted()
    await initializeNativeEvents()
    signal?.throwIfAborted()
    signal?.addEventListener('abort', this.abort, { once: true })
    const result = await nativeCall<{ namespace: string; atomicReplace: boolean; info: NativeFileBackend['info'] }>('file_connect', {
      id: this.nativeId, endpoint: this.connection ? { kind: 'sftp', connection: this.connection } : { kind: 'local' },
    })
    if (this.closed || signal?.aborted) { await nativeCall('file_close', { id: this.nativeId }); throw new DOMException('操作已取消', 'AbortError') }
    Object.assign(this, result)
  }
  async disconnect(): Promise<void> {
    this.closed = true
    this.signal?.removeEventListener('abort', this.abort)
    await nativeCall('file_close', { id: this.nativeId })
  }
  async request<T = void>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) throw new FileOperationError('disconnected', '文件会话已关闭')
    try { return await nativeCall<T>('file_call', { id: this.nativeId, method, ...args }) }
    catch (error) {
      if (error instanceof NativeCallError) throw new FileOperationError(error.code, error.message, this.connection?.proxySource)
      throw error
    }
  }
  list(path: string): Promise<FileDirectoryPage> { return this.request('list', { path }) }
  stat(path: string, followLinks = false): Promise<FileEntry> { return this.request('stat', { path, followLinks }) }
  async read(path: string, offset = 0, length?: number): Promise<ArrayBuffer> { return new Uint8Array(await this.request<number[]>('read', { path, offset, length })).buffer }
  write(path: string, data: ArrayBuffer, offset = 0): Promise<void> { return this.request('write', { path, data: Array.from(new Uint8Array(data)), offset }) }
  writeAtomic(path: string, data: ArrayBuffer): Promise<void> { return this.request('writeAtomic', { path, data: Array.from(new Uint8Array(data)) }) }
  async openReader(path: string): Promise<FileReader> {
    const handle = await this.request<string>('openReader', { path })
    return { read: async (offset, length) => new Uint8Array(await this.request<number[]>('readHandle', { handle, offset, length })).buffer, close: () => this.request('closeHandle', { handle }) }
  }
  async openWriter(path: string): Promise<FileWriter> {
    const handle = await this.request<string>('openWriter', { path })
    return { write: (offset, data) => this.request('writeHandle', { handle, offset, data: Array.from(new Uint8Array(data)) }), close: () => this.request('closeHandle', { handle }) }
  }
  mkdir(path: string): Promise<void> { return this.request('mkdir', { path }) }
  remove(path: string, recursive = false): Promise<void> { return this.request('remove', { path, recursive }) }
  rename(source: string, target: string, overwrite = false): Promise<{ atomic: boolean }> { return this.request('rename', { source, target, overwrite }) }
  chmod(path: string, mode: number): Promise<void> { return this.request('chmod', { path, mode }) }
  utimes(path: string, modifiedAt: number): Promise<void> { return this.request('utimes', { path, modifiedAt }) }
  readlink(path: string): Promise<string> { return this.request('readlink', { path }) }
  symlink(target: string, path: string): Promise<void> { return this.request('symlink', { target, path }) }
}
