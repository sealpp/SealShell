import { nativeCall, nativeEvents, NativeCallError } from '../../native/bridge'
import { initializeNativeEvents } from '../native-events'
import type { ProxyConnection } from '../transport/types'
import { SHELL_VERSION_PROBE, shellStartupCommand } from './shell-integration'

export interface SshOptions {
  sessionId: string; host: string; port: number; username: string; password: string
  proxy?: ProxyConnection; columns?: number; rows?: number; integrateShell?: boolean; shell?: boolean
}
type State = 'connecting' | 'online' | 'error' | 'idle'

export class SshClient {
  private id = ''
  private closed = false
  private unsubscribe?: () => void
  private closing?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  onState?: (state: State, error?: string) => void
  onOutput?: (payload: Uint8Array) => void

  async connect(options: SshOptions): Promise<void> {
    if (this.closed) throw new Error('SSH connection cancelled')
    this.id = options.sessionId
    await initializeNativeEvents()
    this.unsubscribe = await nativeEvents(event => {
      if (event.id !== this.id || this.closed) return
      if (event.type === 'output') this.onOutput?.(new Uint8Array(event.data))
      if (event.type === 'state') this.onState?.(event.state, event.error)
    })
    if (this.closed) { this.unsubscribe(); throw new Error('SSH connection cancelled') }
    this.onState?.('connecting')
    try {
      await nativeCall('ssh_connect', { id: this.id, connection: options })
      if (this.closed) throw new Error('SSH connection cancelled')
      if (options.shell !== false) {
        let command: string | undefined
        if (options.integrateShell) {
          try {
            const output = await this.exec(SHELL_VERSION_PROBE)
            if (output.exitCode === 0) command = shellStartupCommand(new TextDecoder().decode(output.stdout))
          } catch (error) { if (!(error instanceof NativeCallError && error.code === 'EXEC_DENIED')) throw error }
        }
        await nativeCall('ssh_shell', { id: this.id, columns: options.columns ?? 80, rows: options.rows ?? 24, command })
      }
      if (this.closed) throw new Error('SSH connection cancelled')
      this.onState?.('online')
    } catch (error) {
      const failure = this.failure(error)
      if (!this.closed) this.onState?.('error', failure.message)
      await this.close()
      throw failure
    }
  }
  private failure(error: unknown): Error {
    return error instanceof NativeCallError ? new Error(`${error.code}: ${error.message}`) : error instanceof Error ? error : new Error(String(error))
  }
  send(data: Uint8Array): void {
    if (this.closed) return
    // Serialize writes to preserve paste/key ordering across asynchronous IPC.
    const bytes = Array.from(data)
    this.writes = this.writes.then(() => nativeCall('ssh_send', { id: this.id, data: bytes })).catch(error => {
      if (!this.closed) this.onState?.('error', this.failure(error).message)
    })
  }
  resize(columns: number, rows: number): void {
    if (!this.closed) void nativeCall('ssh_resize', { id: this.id, columns, rows }).catch(error => {
      if (!this.closed) this.onState?.('error', this.failure(error).message)
    })
  }
  async exec(command: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
    if (this.closed) throw new Error('SSH session closed')
    const result = await nativeCall<{ stdout: number[]; stderr: number[]; exitCode: number }>('ssh_exec', { id: this.id, command, ...options })
    return { ...result, stdout: new Uint8Array(result.stdout), stderr: new Uint8Array(result.stderr) }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.unsubscribe?.()
    return this.closing = this.id ? nativeCall('ssh_close', { id: this.id }) : Promise.resolve()
  }
  abort(): void { void this.close().catch(() => {}) }
}
