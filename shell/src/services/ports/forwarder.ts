import { NativeNetwork, type NativeStream, type NativeTcpListener } from '../../native/network'
import { NativeError } from '../../native/errors'
import { NodeConnection } from '../node-connection'
import type { RemoteConnection } from '../proxy/types'
import { connectSsh } from '../ssh/connection'
import type { SshWorkerClient } from '../ssh/ssh-worker-client'

export interface ForwardTarget { host: string; port: number; localPort: number }

/** All forwarding policy and SSH live in the PWA. Node owns only raw sockets. */
export class PortForwarder {
  private readonly connection = new NodeConnection()
  private readonly network = new NativeNetwork(this.connection)
  private readonly controller = new AbortController()
  private ssh?: Awaited<ReturnType<typeof connectSsh>>
  private listener?: NativeTcpListener
  private closing?: Promise<void>
  private stopped = false
  private readonly streams = new Set<NativeStream>()

  constructor(private readonly onState: (error: Error | null, fatal: boolean) => void) {
    this.network.onClosed = error => { if (!this.stopped) this.onState(error, true) }
  }

  async start(connection: RemoteConnection, target: ForwardTarget, bindHost: string): Promise<number> {
    try {
      this.ssh = await connectSsh(connection, this.controller.signal)
      this.ssh.worker.onState = (state, reason) => {
        if (!this.stopped && (state === 'error' || state === 'idle')) this.onState(new Error(reason || 'SSH 连接已断开'), true)
      }
      await this.connection.connect()
      this.controller.signal.throwIfAborted()
      const accept = (stream: NativeStream) => { void this.bridge(stream, this.ssh!.worker, target) }
      try { this.listener = await this.network.listen(bindHost, target.localPort || target.port, accept) }
      catch (error) {
        if (!(error instanceof NativeError && error.code === 'listen_failed')) throw error
        this.listener = await this.network.listen(bindHost, 0, accept)
      }
      this.controller.signal.throwIfAborted()
      return this.listener.port
    } catch (error) { await this.close(); throw error }
  }

  private async bridge(stream: NativeStream, ssh: SshWorkerClient, target: ForwardTarget): Promise<void> {
    this.streams.add(stream)
    let channel: number | undefined
    try {
      channel = await ssh.openDirect(target.host, target.port)
      if (!this.stopped) this.onState(null, false)
      const id = channel
      await Promise.all([
        (async () => {
          for (;;) {
            const data = await stream.read()
            if (!data) { await ssh.endDirect(id); return }
            await ssh.writeDirect(id, data)
          }
        })(),
        (async () => {
          for (;;) {
            const data = await ssh.readDirect(id)
            if (!data) { await stream.end(); return }
            await stream.write(data)
          }
        })(),
      ])
    } catch (error) {
      if (!this.stopped) this.onState(error instanceof Error ? error : new Error(String(error)), false)
    } finally {
      stream.close('forward_connection_closed')
      this.streams.delete(stream)
      if (channel !== undefined && !this.stopped) await ssh.closeDirect(channel).catch(() => undefined)
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    this.controller.abort()
    this.closing = (async () => {
      // Stop accepting before releasing streams. Abort the dedicated SSH Worker
      // so pending channel RPCs cannot access freed WASM state.
      if (this.listener) await this.listener.close().catch(() => undefined)
      for (const stream of this.streams) stream.close('forward_disabled')
      await this.connection.close()
      await this.ssh?.close()
    })()
    return this.closing
  }
}
