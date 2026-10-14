import { FileOperationError } from '../files/types'
import { posixPaths } from '../files/path'
import { randomId } from '../../utils/id'
import { transferablesForRequest } from './worker-protocol'
import { requestHostKeyApproval } from '../hostKey'
import { readKnownHost, saveKnownHost } from '../storage'
import type { SftpBackend, SftpConnectionOptions, SftpDirectoryPage, SftpRequest, SftpRequestInput, SftpResponse, SftpStat } from './types'

export class SftpWorkerClient implements SftpBackend {
  readonly paths = posixPaths
  namespace = ''
  private readonly worker: Worker
  private readonly pending = new Map<string, { resolve: (response: SftpResponse) => void; reject: (error: Error) => void }>()
  private host = ''
  private port = 0

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
      for (const { reject } of this.pending.values()) reject(new Error(event.message || 'SFTP worker failed'))
      this.pending.clear()
    }
  }

  private async request<T = SftpResponse>(request: SftpRequestInput): Promise<T> {
    const message = { ...request, version: 1 as const, id: randomId() } as SftpRequest
    const response = await new Promise<SftpResponse>((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject })
      this.worker.postMessage(message, transferablesForRequest(message))
    })
    if (!response.ok) throw new FileOperationError(response.error.code, response.error.message)
    return response as unknown as T
  }

  async connect(options: SftpConnectionOptions): Promise<void> {
    this.namespace = `sftp:${options.host}:${options.port}:${options.username}`
    this.host = options.host
    this.port = options.port
    const known = await readKnownHost(options.host, options.port)
    const knownHostKey = known ? base64ToBytes(known.publicKey).slice().buffer as ArrayBuffer : undefined
    await this.request({ type: 'connect', options: { ...options, knownHostKey } })
  }
  async disconnect(): Promise<void> { await this.request({ type: 'disconnect' }); await new Promise((resolve) => setTimeout(resolve, 0)); this.worker.terminate() }
  async list(path: string, cursor?: string): Promise<SftpDirectoryPage> { return (await this.request<{ result: SftpDirectoryPage }>({ type: 'list', path, cursor })).result }
  async stat(path: string): Promise<SftpStat> { return (await this.request<{ result: SftpStat }>({ type: 'stat', path })).result }
  async read(path: string, offset?: number, length?: number): Promise<ArrayBuffer> { return (await this.request<{ result: ArrayBuffer }>({ type: 'read', path, offset, length })).result }
  async write(path: string, payload: ArrayBuffer, offset?: number): Promise<void> { await this.request({ type: 'write', path, payload, offset }) }
  async mkdir(path: string): Promise<void> { await this.request({ type: 'mkdir', path }) }
  async remove(path: string, recursive?: boolean): Promise<void> { await this.request({ type: 'remove', path, recursive }) }
  async rename(source: string, target: string, overwrite?: boolean): Promise<{ atomic: boolean }> { return (await this.request<{ result: { atomic: boolean } }>({ type: 'rename', source, target, overwrite })).result }
  async chmod(path: string, mode: number): Promise<void> { await this.request({ type: 'chmod', path, mode }) }
  async utimes(path: string, modifiedAt: number): Promise<void> { await this.request({ type: 'utimes', path, modifiedAt }) }
  async readlink(path: string): Promise<string> { return (await this.request<{ result: string }>({ type: 'readlink', path })).result }
  async symlink(target: string, path: string): Promise<void> { await this.request({ type: 'symlink', target, path }) }

  async cancel(requestId: string): Promise<void> { await this.request({ type: 'cancel', requestId }) }

  private async handleHostKey(event: { publicKey: ArrayBuffer; fingerprint: string }): Promise<void> {
    let accepted = await requestHostKeyApproval({ host: this.host, port: this.port, fingerprint: event.fingerprint })
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
