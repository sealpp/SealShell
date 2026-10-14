import { create } from '@bufbuild/protobuf'
import { TransportCloseRequestSchema, TransportCreditSchema, TransportDataSchema, TransportOpenRequestSchema } from '../../proto/seal_pb'
import { NodeConnection } from '../node-connection'

const MAX_CHUNK = 60 * 1024

export class NodeSessionTransport {
  private readonly connection = new NodeConnection()
  private inputCredit = 0
  private inputSequence = 0n
  private outputSequence = 0n
  private closed = false
  private dataHandler?: (payload: Uint8Array) => void
  private waiters: Array<() => void> = []

  constructor() {
    this.connection.onClosed = () => { this.closed = true; this.wake() }
    this.connection.onEvent = (message) => {
      if (message.body.case === 'transportData') {
        const data = message.body.value
        if (data.streamId !== 1 || data.sequence !== this.outputSequence) return
        this.outputSequence += 1n
        this.dataHandler?.(data.payload)
        this.connection.send({ case: 'transportCredit', value: create(TransportCreditSchema, { streamId: 1, direction: 'output', addBytes: BigInt(data.payload.length) }) })
        this.wake()
      } else if (message.body.case === 'transportCredit' && message.body.value.direction === 'input') {
        this.inputCredit += Number(message.body.value.addBytes)
        this.wake()
      } else if (message.body.case === 'transportClosedEvent' || message.body.case === 'transportErrorEvent') {
        this.connection.close()
      }
    }
  }

  onData(handler: (payload: Uint8Array) => void): void { this.dataHandler = handler }

  async connect(host: string, port: number): Promise<void> {
    await this.connection.connect()
    const response = await this.connection.request({ case: 'transportOpenRequest', value: create(TransportOpenRequestSchema, { streamId: 1, transport: 'tcp', host, port }) })
    if (response.body.case !== 'transportOpenedEvent') throw new Error('Node transport open failed')
    this.inputCredit = Number(response.body.value.inputCreditBytes)
  }

  async send(payload: Uint8Array): Promise<void> {
    for (let offset = 0; offset < payload.length; offset += MAX_CHUNK) {
      const chunk = payload.slice(offset, offset + MAX_CHUNK)
      while (this.inputCredit < chunk.length && !this.closed) await this.waitForData()
      if (this.closed) throw new Error('Node transport is closed')
      this.inputCredit -= chunk.length
      this.connection.send({ case: 'transportData', value: create(TransportDataSchema, { streamId: 1, sequence: this.inputSequence++, payload: chunk }) })
    }
  }

  async waitForData(timeoutMs = 0): Promise<void> {
    if (this.closed) throw new Error('Node transport is closed')
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

  async close(reason = 'session_closed'): Promise<void> {
    if (this.closed) return
    try { this.connection.send({ case: 'transportCloseRequest', value: create(TransportCloseRequestSchema, { streamId: 1, reason }) }) }
    finally { this.connection.close() }
  }

  private wake(): void { this.waiters.splice(0).forEach((done) => done()) }
}
