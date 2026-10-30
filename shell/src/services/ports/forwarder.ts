import { nativeCall, nativeEvents } from '../../native/bridge'
import { initializeNativeEvents } from '../native-events'
import type { RemoteConnection } from '../proxy/types'

export interface ForwardTarget { host: string; port: number; localPort: number }
export class PortForwarder {
  private readonly id = crypto.randomUUID()
  private stopped = false
  private unsubscribe?: () => void
  private closing?: Promise<void>
  constructor(private readonly onState: (error: Error | null, fatal: boolean) => void) {}
  async start(connection: RemoteConnection, target: ForwardTarget, bindHost: string): Promise<number> {
    await initializeNativeEvents()
    this.unsubscribe = await nativeEvents(event => {
      if (!this.stopped && event.id === this.id && event.type === 'forward') this.onState(event.error ? new Error(event.error) : null, event.fatal)
    })
    if (this.stopped) { this.unsubscribe(); throw new Error('转发已停止') }
    try {
      const port = await nativeCall<number>('forward_start', { id: this.id, connection, target, bindHost })
      if (this.stopped) { await nativeCall('forward_close', { id: this.id }); throw new Error('转发已停止') }
      return port
    } catch (error) { await this.close(); throw error }
  }
  close(): Promise<void> {
    this.stopped = true
    this.unsubscribe?.()
    return this.closing ??= nativeCall('forward_close', { id: this.id })
  }
}
