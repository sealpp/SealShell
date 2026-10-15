import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { AuthBeginSchema, AuthProofSchema, SealMessageSchema, type SealMessage } from '../proto/seal_pb'
import { randomId } from '../utils/id'
import { readIdentity } from './storage'
import { requireWebCrypto } from './webCrypto'

const PROTOCOL_VERSION = 1
function bytes(length: number): Uint8Array {
  const result = new Uint8Array(length)
  requireWebCrypto().getRandomValues(result)
  return result
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function transcript(label: string, ...fields: Array<string | Uint8Array>): Uint8Array {
  const encoded = [text(label), ...fields.map((field) => typeof field === 'string' ? text(field) : field)]
  const result = new Uint8Array(encoded.reduce((sum, value) => sum + 4 + value.length, 0))
  const view = new DataView(result.buffer)
  let offset = 0
  for (const value of encoded) {
    view.setUint32(offset, value.length, false)
    offset += 4
    result.set(value, offset)
    offset += value.length
  }
  return result
}

async function sign(identity: NonNullable<Awaited<ReturnType<typeof readIdentity>>>, value: Uint8Array): Promise<Uint8Array> {
  const signature = await requireWebCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.devicePrivateKey,
    value.slice().buffer as ArrayBuffer,
  )
  return new Uint8Array(signature)
}

async function verify(publicKey: Uint8Array, signature: Uint8Array, value: Uint8Array): Promise<boolean> {
  const key = await requireWebCrypto().subtle.importKey(
    'spki',
    publicKey.slice().buffer as ArrayBuffer,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  return requireWebCrypto().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature.slice().buffer as ArrayBuffer,
    value.slice().buffer as ArrayBuffer,
  )
}

function nodeUrl(): string {
  const host = typeof location !== 'undefined' && location.hostname ? location.hostname : '127.0.0.1'
  return `ws://${host}:17373`
}

/** An authenticated message connection, independent of TCP or file services. */
export class NodeConnection {
  private socket?: WebSocket
  private readonly pending = new Map<string, { resolve: (value: SealMessage) => void; reject: (error: Error) => void }>()
  private closed = false
  private closing?: Promise<void>
  private openedReject?: (error: Error) => void
  onEvent?: (message: SealMessage) => void
  onClosed?: (error: Error) => void

  async connect(): Promise<string> {
    const identity = await readIdentity()
    if (this.closed) throw new Error('Node connection is closed')
    if (!identity?.nodeId || !identity.nodePublicKey) throw new Error('PWA device is not paired with SealNode')
    this.socket = new WebSocket(nodeUrl())
    this.socket.binaryType = 'arraybuffer'
    this.socket.onmessage = (event) => {
      try {
        const message = fromBinary(SealMessageSchema, new Uint8Array(event.data as ArrayBuffer))
        const request = this.pending.get(message.requestId)
        if (request) {
          this.pending.delete(message.requestId)
          if (message.body.case === 'transportErrorEvent') request.reject(new Error(`${message.body.value.code}: ${message.body.value.message}`))
          else request.resolve(message)
        } else this.onEvent?.(message)
      } catch (error) { this.close(error instanceof Error ? error : new Error(String(error))) }
    }
    this.socket.onerror = () => this.close(new Error('Node WebSocket error'))
    this.socket.onclose = () => this.close(new Error('Node WebSocket closed'))
    try {
      await new Promise<void>((resolve, reject) => {
        this.openedReject = reject
        this.socket!.onopen = () => { this.openedReject = undefined; resolve() }
      })
      const connectionId = randomId()
      const clientNonce = bytes(32)
      const challenge = await this.request({ case: 'authBegin', value: create(AuthBeginSchema, { deviceId: identity.deviceId, connectionId, clientNonce }) })
      if (challenge.body.case !== 'authChallenge' || challenge.body.value.connectionId !== connectionId || challenge.body.value.nodeId !== identity.nodeId) throw new Error('Invalid Node authentication challenge')
      const key = challenge.body.value.nodePublicKey
      const saved = new Uint8Array(identity.nodePublicKey)
      if (key.length !== saved.length || key.some((byte, index) => byte !== saved[index])) throw new Error('Node identity key changed')
      const auth = transcript('SEAL-AUTH-1', String(PROTOCOL_VERSION), connectionId, identity.deviceId, identity.nodeId, clientNonce, challenge.body.value.nodeNonce)
      if (!await verify(key, challenge.body.value.nodeSignature, auth)) throw new Error('Invalid Node signature')
      const authenticated = await this.request({ case: 'authProof', value: create(AuthProofSchema, { connectionId, deviceSignature: await sign(identity, auth) }) })
      if (authenticated.body.case !== 'authSucceeded') throw new Error('Node authentication failed')
      return identity.nodeId
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  request(body: SealMessage['body']): Promise<SealMessage> {
    const requestId = randomId()
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
      try { this.send(body, requestId) } catch (error) {
        this.pending.delete(requestId)
        reject(error)
      }
    })
  }

  send(body: SealMessage['body'], requestId = ''): void {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Node connection is closed')
    const payload = toBinary(SealMessageSchema, create(SealMessageSchema, { protocolVersion: PROTOCOL_VERSION, requestId, body }))
    if (payload.byteLength > 64 * 1024) throw new Error('Node message exceeds 64 KiB')
    this.socket.send(payload)
  }

  close(error = new Error('Node connection closed')): Promise<void> {
    if (this.closed) return this.closing ?? Promise.resolve()
    this.closed = true
    const socket = this.socket
    this.closing = !socket || socket.readyState === WebSocket.CLOSED ? Promise.resolve()
      : new Promise(resolve => socket.addEventListener('close', () => resolve(), { once: true }))
    this.openedReject?.(error)
    this.openedReject = undefined
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    socket?.close(1000)
    this.onClosed?.(error)
    return this.closing
  }
}
