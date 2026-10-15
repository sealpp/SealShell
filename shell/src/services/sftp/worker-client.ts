import { FileOperationError } from '../files/types'
import type { FileBackend, FileReader, FileWriter } from '../files/types'
import { posixPaths } from '../files/path'
import { randomId } from '../../utils/id'
import { transferablesForRequest } from './worker-protocol'
import { requestHostKeyApproval } from '../hostKey'
import { readKnownHost, saveKnownHost } from '../storage'
import type { SftpBackend, SftpConnectionOptions, SftpDirectoryPage, SftpRequest, SftpRequestInput, SftpResponse, SftpStat } from './types'

export class SftpWorkerClient implements SftpBackend {
  readonly paths = posixPaths
  namespace = ''
  fork?: (signal?: AbortSignal) => Promise<FileBackend>
  private readonly worker: Worker
  private readonly pending = new Map<string, { resolve: (response: SftpResponse) => void; reject: (error: Error) => void }>()
  private host = ''
  private port = 0
  private failure?: Error
  private closing?: Promise<void>
  private signal?: AbortSignal
  private readonly abort = () => this.terminate(new DOMException('传输已取消', 'AbortError'))

  constructor(worker = new Worker(new URL('./sftp.worker.ts', import.meta.url), { type: 'module' })) {
    this.worker = worker
    this.worker.onmessage = (event) => {
      if (event.data?.type === 'hostKey') {
        void this.handleHostKey(event.data)
        return
      }
      const response = event.data as SftpResponse
      const request = this.pending.get(response.id)
      if (!request) return
      this.pending.delete(response.id)
      request.resolve(response)
    }
    this.worker.onerror = (event) => {
      this.terminate(new Error(event.message || 'SFTP worker failed'))
    }
  }

  private async request<T = SftpResponse>(request: SftpRequestInput): Promise<T> {
    if (this.failure) throw this.failure
    const message = { ...request, version: 1 as const, id: randomId() } as SftpRequest
    const response = await new Promise<SftpResponse>((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject })
      try { this.worker.postMessage(message, transferablesForRequest(message)) }
      catch (error) { this.pending.delete(message.id); reject(error) }
    })
    if (!response.ok) throw new FileOperationError(response.error.code, response.error.message)
    return response as unknown as T
  }

  async connect(options: SftpConnectionOptions, signal?: AbortSignal): Promise<void> {
    this.signal = signal
    if (signal?.aborted) { this.abort(); throw this.failure }
    signal?.addEventListener('abort', this.abort, { once: true })
    this.namespace = `sftp:${options.host}:${options.port}:${options.username}`
    if (options.proxy) this.namespace += `:via:${options.proxy.type}:${options.proxy.host}:${options.proxy.port}:${options.proxy.username}`
    this.host = options.host
    this.port = options.port
    const known = await readKnownHost(options.host, options.port)
    const knownHostKey = known ? base64ToBytes(known.publicKey).slice().buffer as ArrayBuffer : undefined
    await this.request({ type: 'connect', options: { ...options, knownHostKey } })
  }
  disconnect(): Promise<void> {
    if (this.failure) return Promise.resolve()
    this.closing ??= this.request({ type: 'disconnect' }).then(() => undefined)
      .finally(() => this.terminate(new Error('SFTP worker closed')))
    return this.closing
  }

  private terminate(error: Error): void {
    if (this.failure) return
    this.failure = error
    this.signal?.removeEventListener('abort', this.abort)
    this.worker.terminate()
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
    this.worker.onmessage = null
    this.worker.onerror = null
  }
  async list(path: string, cursor?: string): Promise<SftpDirectoryPage> { return (await this.request<{ result: SftpDirectoryPage }>({ type: 'list', path, cursor })).result }
  async stat(path: string): Promise<SftpStat> { return (await this.request<{ result: SftpStat }>({ type: 'stat', path })).result }
  async read(path: string, offset?: number, length?: number): Promise<ArrayBuffer> { return (await this.request<{ result: ArrayBuffer }>({ type: 'read', path, offset, length })).result }
  async write(path: string, payload: ArrayBuffer, offset?: number): Promise<void> { await this.request({ type: 'write', path, payload, offset }) }
  async openReader(path: string): Promise<FileReader> {
    const { result: handle } = await this.request<{ result: string }>({ type: 'openReader', path })
    return {
      read: async (offset, length) => (await this.request<{ result: ArrayBuffer }>({ type: 'readHandle', handle, offset, length })).result,
      close: async () => { await this.request({ type: 'closeHandle', handle }) },
    }
  }
  async openWriter(path: string): Promise<FileWriter> {
    const { result: handle } = await this.request<{ result: string }>({ type: 'openWriter', path })
    return {
      write: async (offset, payload) => { await this.request({ type: 'writeHandle', handle, offset, payload }) },
      close: async () => { await this.request({ type: 'closeHandle', handle }) },
    }
  }
  async mkdir(path: string): Promise<void> { await this.request({ type: 'mkdir', path }) }
  async remove(path: string, recursive?: boolean): Promise<void> { await this.request({ type: 'remove', path, recursive }) }
  async rename(source: string, target: string, overwrite?: boolean): Promise<{ atomic: boolean }> { return (await this.request<{ result: { atomic: boolean } }>({ type: 'rename', source, target, overwrite })).result }
  async chmod(path: string, mode: number): Promise<void> { await this.request({ type: 'chmod', path, mode }) }
  async utimes(path: string, modifiedAt: number): Promise<void> { await this.request({ type: 'utimes', path, modifiedAt }) }
  async readlink(path: string): Promise<string> { return (await this.request<{ result: string }>({ type: 'readlink', path })).result }
  async symlink(target: string, path: string): Promise<void> { await this.request({ type: 'symlink', target, path }) }

  private async handleHostKey(event: { publicKey: ArrayBuffer; fingerprint: string }): Promise<void> {
    if (this.failure) return
    let accepted = await requestHostKeyApproval({ host: this.host, port: this.port, fingerprint: event.fingerprint })
    if (this.failure) return
    if (accepted) {
      try {
        await saveKnownHost({ host: this.host, port: this.port, publicKey: bytesToBase64(new Uint8Array(event.publicKey)), fingerprint: event.fingerprint })
      } catch { accepted = false }
    }
    this.worker.postMessage({ type: 'hostKeyDecision', accepted })
  }
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const result = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index)
  return result
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
