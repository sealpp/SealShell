import { NodeConnection } from '../node-connection'
import { NativeNetwork, type NativeStream } from '../../native/network'

/** Application byte-transport adapter over the reusable native SDK. */
export class NodeTcpTransport {
  private readonly connection = new NodeConnection()
  private readonly network = new NativeNetwork(this.connection)
  private stream?: NativeStream
  private closed = false
  private closeError = new Error('Node transport is closed')
  private dataHandler?: (payload: Uint8Array) => void
  private waiters: Array<() => void> = []

  constructor() {
    this.network.onClosed = error => { this.closeError = error; this.closed = true; this.wake() }
  }

  onData(handler: (payload: Uint8Array) => void): void { this.dataHandler = handler }

  async connect(host: string, port: number): Promise<void> {
    await this.connection.connect()
    this.stream = await this.network.open('tcp', host, port)
    void this.read()
  }

  private async read(): Promise<void> {
    try {
      while (!this.closed) {
        const payload = await this.stream!.read()
        if (!payload) throw new Error('Node transport closed: eof')
        this.dataHandler?.(payload)
        this.wake()
      }
    } catch (error) { await this.connection.close(error instanceof Error ? error : new Error(String(error))) }
  }

  async send(payload: Uint8Array): Promise<void> {
    if (!this.stream || this.closed) throw this.closeError
    await this.stream.write(payload)
  }

  async waitForData(timeoutMs = 0): Promise<void> {
    if (this.closed) throw this.closeError
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (timer) clearTimeout(timer)
        const index = this.waiters.indexOf(done)
        if (index >= 0) this.waiters.splice(index, 1)
        resolve()
      }
      this.waiters.push(done)
      if (timeoutMs) timer = setTimeout(done, timeoutMs)
    })
  }

  async close(_reason = 'session_closed'): Promise<void> { await this.connection.close() }
  private wake(): void { this.waiters.splice(0).forEach((done) => done()) }
}
