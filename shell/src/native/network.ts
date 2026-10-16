import { create } from '@bufbuild/protobuf'
import {
  TcpListenRequestSchema, TcpListenerCloseRequestSchema, TransportOpenRequestSchema,
  TransportDataSchema, TransportCreditSchema, TransportHalfCloseRequestSchema, TransportCloseRequestSchema,
  type SealMessage,
} from './proto/seal_pb'
import type { NativeConnection } from './connection'
import { NativeError } from './errors'

const MAX_CHUNK = 60 * 1024

/** A connection-owned TCP byte stream or UDP datagram socket. Reads grant credit
 * only when consumed; writes resolve when the native socket has drained. */
export class NativeStream {
  private inputSequence = 0n
  private outputSequence = 0n
  private received: Uint8Array[] = []
  private sent = 0
  private acknowledged = 0
  private eof = false
  private ended = false
  private closed = false
  private error?: Error
  private waiters = new Set<() => void>()
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly connection: NativeConnection,
    readonly id: number,
    readonly transport: 'tcp' | 'udp',
    private inputCredit: number,
    readonly peer?: { host: string; port: number },
  ) {}

  receive(message: SealMessage): void {
    const body = message.body
    if (body.case === 'transportData') {
      if (body.value.sequence !== this.outputSequence++) throw new Error('Native stream sequence mismatch')
      this.received.push(body.value.payload)
    } else if (body.case === 'transportCredit') {
      if (body.value.direction !== 'input') throw new Error('Unexpected native credit direction')
      const count = Number(body.value.addBytes)
      this.inputCredit += count
      this.acknowledged += count
    } else if (body.case === 'transportEofEvent') this.eof = true
    else if (body.case === 'transportClosedEvent') this.finish(this.eof ? undefined : new Error(body.value.reason || 'Native stream closed'))
    else if (body.case === 'transportErrorEvent') this.finish(new NativeError(body.value.code, body.value.message))
    this.wake()
  }

  async read(): Promise<Uint8Array | null> {
    while (!this.received.length && !this.eof && !this.closed) await this.wait()
    if (this.error) throw this.error
    const payload = this.received.shift()
    if (!payload) return null
    if (!this.closed) this.connection.send({ case: 'transportCredit', value: create(TransportCreditSchema, { streamId: this.id, direction: 'output', addBytes: BigInt(payload.length) }) })
    return payload
  }

  write(payload: Uint8Array): Promise<void> {
    if (this.ended) return Promise.reject(new Error('Native stream input has ended'))
    if (this.transport === 'udp' && payload.length > MAX_CHUNK) return Promise.reject(new Error('Datagram exceeds the native message limit'))
    const operation = this.writes.then(async () => {
      for (let offset = 0; offset < payload.length; offset += MAX_CHUNK) {
        const chunk = payload.subarray(offset, offset + MAX_CHUNK)
        while (this.inputCredit < chunk.length && !this.closed) await this.wait()
        if (this.closed) throw this.error ?? new Error('Native stream closed')
        this.inputCredit -= chunk.length
        this.sent += chunk.length
        this.connection.send({ case: 'transportData', value: create(TransportDataSchema, { streamId: this.id, sequence: this.inputSequence++, payload: chunk }) })
      }
      while (this.acknowledged < this.sent && !this.closed) await this.wait()
      if (this.closed) throw this.error ?? new Error('Native stream closed')
    })
    this.writes = operation.catch(() => undefined)
    return operation
  }

  async end(): Promise<void> {
    if (this.transport !== 'tcp') throw new Error('UDP does not support half-close')
    if (this.ended) return
    this.ended = true
    await this.writes
    if (!this.closed) this.connection.send({ case: 'transportHalfCloseRequest', value: create(TransportHalfCloseRequestSchema, { streamId: this.id }) })
  }

  close(reason = 'closed'): void {
    if (this.closed) return
    try { this.connection.send({ case: 'transportCloseRequest', value: create(TransportCloseRequestSchema, { streamId: this.id, reason }) }) }
    finally { this.finish(new Error(reason)) }
  }

  finish(error?: Error): void { this.closed = true; this.error = error; this.wake() }
  private wait(): Promise<void> { return new Promise(resolve => this.waiters.add(resolve)) }
  private wake(): void { for (const done of this.waiters) done(); this.waiters.clear() }
}

export class NativeTcpListener {
  host = ''
  port = 0
  constructor(private readonly connection: NativeConnection, readonly id: number, readonly onAccept: (stream: NativeStream) => void, private readonly remove: () => void) {}
  /** Stops accepting. Accepted streams retain their independent lifetime. */
  async close(): Promise<void> {
    await this.connection.request({ case: 'tcpListenerCloseRequest', value: create(TcpListenerCloseRequestSchema, { listenerId: this.id }) })
    this.remove()
  }
}

export class NativeNetwork {
  private nextId = 1
  private readonly streams = new Map<number, NativeStream>()
  private readonly listeners = new Map<number, NativeTcpListener>()
  onClosed?: (error: Error) => void

  constructor(private readonly connection: NativeConnection) {
    connection.onEvent = message => this.receive(message)
    connection.onClosed = error => {
      for (const stream of this.streams.values()) stream.finish(error)
      this.streams.clear()
      this.listeners.clear()
      this.onClosed?.(error)
    }
  }

  async open(transport: 'tcp' | 'udp', host: string, port: number): Promise<NativeStream> {
    const streamId = this.nextId++
    const response = await this.connection.request({ case: 'transportOpenRequest', value: create(TransportOpenRequestSchema, { streamId, transport, host, port }) })
    if (response.body.case !== 'transportOpenedEvent') throw new Error('Unexpected native open response')
    const stream = new NativeStream(this.connection, streamId, transport, Number(response.body.value.inputCreditBytes))
    this.streams.set(streamId, stream)
    return stream
  }

  async listen(host: string, port: number, onAccept: (stream: NativeStream) => void): Promise<NativeTcpListener> {
    const id = this.nextId++
    const listener = new NativeTcpListener(this.connection, id, onAccept, () => this.listeners.delete(id))
    const response = await this.connection.request({ case: 'tcpListenRequest', value: create(TcpListenRequestSchema, { listenerId: id, host, port }) })
    if (response.body.case !== 'tcpListeningEvent') throw new Error('Unexpected native listen response')
    listener.host = response.body.value.host
    listener.port = response.body.value.port
    this.listeners.set(id, listener)
    return listener
  }

  private receive(message: SealMessage): void {
    const body = message.body
    if (body.case === 'tcpAcceptedEvent') {
      const value = body.value
      const stream = new NativeStream(this.connection, value.streamId, 'tcp', Number(value.inputCreditBytes), { host: value.peerHost, port: value.peerPort })
      this.streams.set(stream.id, stream)
      const listener = this.listeners.get(value.listenerId)
      if (listener) listener.onAccept(stream)
      else stream.close('listener_closed')
    } else if (body.value && 'streamId' in body.value) {
      this.streams.get(body.value.streamId)?.receive(message)
      if (body.case === 'transportClosedEvent') this.streams.delete(body.value.streamId)
    }
  }
}
