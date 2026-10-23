import { randomId } from '../../utils/id'
import { requestHostKeyApproval } from '../hostKey'
import { saveKnownHost } from '../storage'
import type { ProxyConnection } from '../transport/types'

export interface WorkerSshOptions {
  sessionId: string
  host: string
  port: number
  username: string
  password: string
  proxy?: ProxyConnection
  knownHostKey?: Uint8Array
  columns?: number
  rows?: number
  integrateShell?: boolean
  shell?: boolean
}

type WorkerState = 'connecting' | 'online' | 'error' | 'idle'

export class SshWorkerClient {
  private readonly worker: Worker
  private readonly execPending = new Map<string, { resolve: (value: { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }) => void; reject: (error: Error) => void }>()
  private readonly directPending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private closed = false
  private closing?: Promise<void>
  private closeDone?: () => void
  private host = ''
  private port = 0
  private readonly lifetime = new AbortController()
  onState: ((state: WorkerState, error?: string) => void) | undefined
  onOutput: ((payload: Uint8Array) => void) | undefined

  constructor(worker = new Worker(new URL('./ssh.worker.ts', import.meta.url), { type: 'module' })) {
    this.worker = worker
    this.worker.onmessage = (event) => this.handle(event.data)
    this.worker.onerror = (event) => this.fail(new Error(event.message || 'SSH worker failed'))
  }

  async connect(options: WorkerSshOptions): Promise<void> {
    this.host = options.host
    this.port = options.port
    this.post({
      type: 'connect',
      options: {
        host: options.host,
        port: options.port,
        username: options.username,
        password: options.password,
        proxy: options.proxy,
        columns: options.columns,
        rows: options.rows,
        integrateShell: options.integrateShell,
        shell: options.shell,
        knownHostKey: options.knownHostKey?.slice().buffer,
      },
    }, options.knownHostKey ? [options.knownHostKey.slice().buffer] : [])
    await new Promise<void>((resolve, reject) => {
      const previous = this.onState
      this.onState = (state, error) => {
        previous?.(state, error)
        if (state === 'online' && !this.closed) resolve()
        if (state === 'error' || state === 'idle' || this.closed) reject(new Error(error || 'SSH connection closed'))
      }
    })
  }

  send(payload: Uint8Array): void {
    const copy = payload.slice()
    this.post({ type: 'input', payload: copy.buffer }, [copy.buffer])
  }

  resize(columns: number, rows: number): void { this.post({ type: 'resize', columns, rows }) }

  openDirect(host: string, port: number): Promise<number> { return this.direct('open', { host, port }) }
  async readDirect(channel: number): Promise<Uint8Array | null> {
    const value = await this.direct('read', { channel })
    return value === null ? null : new Uint8Array(value)
  }
  writeDirect(channel: number, payload: Uint8Array): Promise<void> { return this.direct('write', { channel, payload: payload.slice().buffer }) }
  endDirect(channel: number): Promise<void> { return this.direct('end', { channel }) }
  closeDirect(channel: number): Promise<void> { return this.direct('close', { channel }) }

  private direct(operation: string, args: Record<string, unknown>): Promise<any> {
    if (this.closed) return Promise.reject(new Error('SSH worker closed'))
    const id = randomId()
    return new Promise((resolve, reject) => {
      this.directPending.set(id, { resolve, reject })
      this.post({ type: 'direct', id, operation, ...args }, args.payload instanceof ArrayBuffer ? [args.payload] : [])
    })
  }

  private rejectPending(error: Error): void {
    for (const pending of [...this.execPending.values(), ...this.directPending.values()]) pending.reject(error)
    this.execPending.clear()
    this.directPending.clear()
  }

  exec(command: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
    if (this.closed) return Promise.reject(new Error('SSH worker closed'))
    const id = randomId()
    return new Promise((resolve, reject) => {
      const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => this.fail(new Error('SSH 命令超时，请重新连接后重试')), options.timeoutMs)
      this.execPending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
      this.post({ type: 'exec', id, command, maxOutputBytes: options.maxOutputBytes })
    })
  }

  async close(): Promise<void> {
    if (this.closed) return this.closing
    this.closed = true
    this.lifetime.abort()
    this.closing = new Promise(resolve => { this.closeDone = resolve })
    this.worker.postMessage({ type: 'close' })
    await this.closing
    this.worker.terminate()
    this.rejectPending(new Error('SSH worker closed'))
  }

  abort(): void {
    this.fail(new Error('SSH connection cancelled'))
  }

  private handle(event: any): void {
    if (!event || typeof event.type !== 'string') return
    if (event.type === 'closed') {
      this.onState?.('idle')
      this.closeDone?.()
      return
    }
    if (event.type === 'state') {
      this.onState?.(event.state as WorkerState, event.error)
      return
    }
    if (event.type === 'output') {
      this.onOutput?.(new Uint8Array(event.payload))
      return
    }
    if (event.type === 'hostKey') {
      void this.approveHostKey(event).catch(error => this.fail(error instanceof Error ? error : new Error(String(error))))
      return
    }
    if (event.type === 'execResult') {
      const pending = this.execPending.get(event.id)
      if (!pending) return
      this.execPending.delete(event.id)
      pending.resolve({ stdout: new Uint8Array(event.stdout), stderr: new Uint8Array(event.stderr), exitCode: event.exitCode })
      return
    }
    if (event.type === 'directResult') {
      const pending = this.directPending.get(event.id)
      this.directPending.delete(event.id)
      if (event.error) pending?.reject(new Error(event.error))
      else pending?.resolve(event.value)
      return
    }
    if (event.type === 'error') {
      this.onState?.('error', `${event.code}: ${event.message}`)
      this.rejectPending(new Error(`${event.code}: ${event.message}`))
      this.closeDone?.()
    }
  }

  private async approveHostKey(event: { publicKey: ArrayBuffer; fingerprint: string }): Promise<void> {
    const accepted = await requestHostKeyApproval({ host: this.host, port: this.port, fingerprint: event.fingerprint }, this.lifetime.signal)
    if (this.closed) return
    if (accepted) {
      // The host and port are already displayed by the connection view; the worker
      // remains the authority that continues the paused libssh2 session.
      this.post({ type: 'hostKeyDecision', accepted: true })
    } else {
      this.post({ type: 'hostKeyDecision', accepted: false })
    }
    if (accepted) {
      try {
        await saveKnownHost({ host: this.host, port: this.port, publicKey: bytesToBase64(new Uint8Array(event.publicKey)), fingerprint: event.fingerprint })
      } catch {
        this.post({ type: 'hostKeyDecision', accepted: false })
        return
      }
    }
  }

  private post(message: unknown, transfer: Transferable[] = []): void {
    if (!this.closed) this.worker.postMessage(message, transfer)
  }

  private fail(error: Error): void {
    if (this.closed) { this.closeDone?.(); return }
    this.closed = true
    this.lifetime.abort()
    this.onState?.('error', error.message)
    this.rejectPending(error)
    this.worker.terminate()
    this.closeDone?.()
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(binary)
}
