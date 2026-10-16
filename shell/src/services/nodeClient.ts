import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import {
  AuthBeginSchema,
  AuthProofSchema,
  PairBeginSchema,
  PairProofSchema,
  SealMessageSchema,
  type SealMessage,
} from '../native/proto/seal_pb'
import { randomId } from '../utils/id'
import {
  clearIdentity,
  readIdentity,
  saveIdentity,
  type StoredIdentity,
} from './storage'
import { store } from '../stores/app'
import { requireWebCrypto } from './webCrypto'

const PROTOCOL_VERSION = 1

export interface NodeCallbacks {
  onError?: (message: string) => void
  onDisconnected?: () => void
}

interface PendingRequest {
  resolve: (message: SealMessage) => void
  reject: (error: Error) => void
}

interface PairChallengeData {
  pairingId: string
  clientNonce: Uint8Array
  devicePublicKey: Uint8Array
  deviceName: string
}

interface AuthChallengeData {
  connectionId: string
  deviceId: string
  clientNonce: Uint8Array
  nodeNonce: Uint8Array
  nodePublicKey: Uint8Array
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let result = 0
  for (let index = 0; index < left.length; index += 1) {
    result |= left[index] ^ right[index]
  }
  return result === 0
}

function randomBytes(length: number): Uint8Array {
  const result = new Uint8Array(length)
  requireWebCrypto().getRandomValues(result)
  return result
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function encodeTranscript(label: string, ...fields: Array<string | Uint8Array>): Uint8Array {
  const encoded = [text(label), ...fields.map((field) => typeof field === 'string' ? text(field) : field)]
  const total = encoded.reduce((sum, value) => sum + 4 + value.length, 0)
  const output = new Uint8Array(total)
  const view = new DataView(output.buffer)
  let offset = 0
  for (const value of encoded) {
    view.setUint32(offset, value.length, false)
    offset += 4
    output.set(value, offset)
    offset += value.length
  }
  return output
}

async function signTranscript(identity: StoredIdentity, transcript: Uint8Array): Promise<Uint8Array> {
  const signature = await requireWebCrypto().subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.devicePrivateKey,
    arrayBuffer(transcript),
  )
  return new Uint8Array(signature)
}

async function verifyNodeSignature(
  nodePublicKey: Uint8Array,
  signature: Uint8Array,
  transcript: Uint8Array,
): Promise<boolean> {
  const key = await requireWebCrypto().subtle.importKey(
    'spki',
    arrayBuffer(nodePublicKey),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  return requireWebCrypto().subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    arrayBuffer(signature),
    arrayBuffer(transcript),
  )
}

export class NodeClient {
  private socket: WebSocket | null = null
  private identity: StoredIdentity | undefined
  private requestCounter = 0
  private readonly pending = new Map<string, PendingRequest>()
  private callbacks: NodeCallbacks = {}
  private disconnectedHandler: (() => void) | undefined
  private socketReady: Promise<void> | undefined
  private socketReadyResolve: (() => void) | undefined
  private socketReadyReject: ((error: Error) => void) | undefined

  setDisconnectedHandler(handler: (() => void) | undefined): void {
    this.disconnectedHandler = handler
  }

  async initializeIdentity(): Promise<void> {
    this.identity = await readIdentity()
    store.identityLoaded = true
    store.deviceId = this.identity?.deviceId ?? ''
    store.deviceName = this.identity?.deviceName ?? 'SealShell PWA'
    store.paired = Boolean(this.identity?.nodeId && this.identity?.nodePublicKey)
  }

  async pair(pairingCode: string, callbacks: NodeCallbacks = {}): Promise<void> {
    this.callbacks = callbacks
    requireWebCrypto()
    const identity = await this.ensureIdentity()
    await this.openSocket()

    const clientNonce = randomBytes(32)
    const pairRequestId = this.nextRequestId()
    const begin = create(SealMessageSchema, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: pairRequestId,
      body: {
        case: 'pairBegin',
        value: create(PairBeginSchema, {
          pairingCode,
          deviceId: identity.deviceId,
          deviceName: identity.deviceName,
          devicePublicKey: new Uint8Array(identity.devicePublicKey),
          clientNonce,
        }),
      },
    })
    const challenge = await this.request(begin)
    if (challenge.body.case !== 'pairChallenge') {
      throw new Error('unexpected Node pairing response')
    }

    const challengeData: PairChallengeData = {
      pairingId: challenge.body.value.pairingId,
      clientNonce,
      devicePublicKey: new Uint8Array(identity.devicePublicKey),
      deviceName: identity.deviceName,
    }
    const transcript = encodeTranscript(
      'SEAL-PAIR-1',
      String(PROTOCOL_VERSION),
      challengeData.pairingId,
      identity.deviceId,
      challengeData.deviceName,
      challengeData.devicePublicKey,
      challenge.body.value.nodeId,
      challenge.body.value.nodePublicKey,
      challengeData.clientNonce,
      challenge.body.value.nodeNonce,
    )
    const proof = create(SealMessageSchema, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      body: {
        case: 'pairProof',
        value: create(PairProofSchema, {
          pairingId: challengeData.pairingId,
          deviceSignature: await signTranscript(identity, transcript),
        }),
      },
    })
    const result = await this.request(proof)
    if (result.body.case !== 'pairSucceeded') {
      throw new Error('unexpected Node pairing result')
    }

    await this.savePairedIdentity(
      identity,
      result.body.value.nodeId,
      new Uint8Array(result.body.value.nodePublicKey),
    )
    store.paired = true
    store.nodeConnected = true
  }

  async connect(callbacks: NodeCallbacks = {}): Promise<void> {
    this.callbacks = callbacks
    requireWebCrypto()
    const identity = this.identity ?? await readIdentity()
    this.identity = identity
    if (!identity?.nodeId || !identity.nodePublicKey) {
      throw new Error('PWA device is not paired with SealNode')
    }

    await this.openSocket()
    const connectionId = randomId()
    const clientNonce = randomBytes(32)
    const begin = create(SealMessageSchema, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      body: {
        case: 'authBegin',
        value: create(AuthBeginSchema, {
          deviceId: identity.deviceId,
          connectionId,
          clientNonce,
        }),
      },
    })
    const challenge = await this.request(begin)
    if (challenge.body.case !== 'authChallenge') {
      throw new Error('unexpected Node authentication response')
    }
    if (challenge.body.value.connectionId !== connectionId || challenge.body.value.nodeId !== identity.nodeId) {
      throw new Error('Node authentication transcript does not match')
    }

    const nodePublicKey = new Uint8Array(challenge.body.value.nodePublicKey)
    if (!bytesEqual(nodePublicKey, new Uint8Array(identity.nodePublicKey))) {
      throw new Error('Node identity key changed')
    }
    const authData: AuthChallengeData = {
      connectionId,
      deviceId: identity.deviceId,
      clientNonce,
      nodeNonce: new Uint8Array(challenge.body.value.nodeNonce),
      nodePublicKey,
    }
    const transcript = encodeTranscript(
      'SEAL-AUTH-1',
      String(PROTOCOL_VERSION),
      authData.connectionId,
      authData.deviceId,
      identity.nodeId,
      authData.clientNonce,
      authData.nodeNonce,
    )
    if (!await verifyNodeSignature(authData.nodePublicKey, new Uint8Array(challenge.body.value.nodeSignature), transcript)) {
      throw new Error('Node authentication signature is invalid')
    }

    const proof = create(SealMessageSchema, {
      protocolVersion: PROTOCOL_VERSION,
      requestId: this.nextRequestId(),
      body: {
        case: 'authProof',
        value: create(AuthProofSchema, {
          connectionId,
          deviceSignature: await signTranscript(identity, transcript),
        }),
      },
    })
    const result = await this.request(proof)
    if (result.body.case !== 'authSucceeded') {
      throw new Error('unexpected Node authentication result')
    }
    store.nodeConnected = true
  }

  wsUrl(): string {
    return `ws://${window.location.hostname}:17373`
  }

  sendMessage(message: SealMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Node WebSocket is not connected')
    }
    this.socket.send(toBinary(SealMessageSchema, message))
  }

  clearPairing(): void {
    this.closeSocket()
    this.identity = undefined
    store.paired = false
    store.deviceId = ''
    store.nodeConnected = false
    void clearIdentity()
  }

  disconnect(): void {
    this.closeSocket()
    store.nodeConnected = false
  }

  private async ensureIdentity(): Promise<StoredIdentity> {
    if (this.identity?.devicePrivateKey && this.identity.devicePublicKey) return this.identity
    const keyPair = await requireWebCrypto().subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    ) as CryptoKeyPair
    const publicKey = await requireWebCrypto().subtle.exportKey('spki', keyPair.publicKey)
    const identity: StoredIdentity = {
      key: 'identity',
      deviceId: requireWebCrypto().randomUUID?.() ?? randomId(),
      deviceName: store.deviceName,
      devicePrivateKey: keyPair.privateKey,
      devicePublicKey: publicKey,
    }
    await saveIdentity(identity)
    this.identity = identity
    store.deviceId = identity.deviceId
    store.identityLoaded = true
    return identity
  }

  private async savePairedIdentity(identity: StoredIdentity, nodeId: string, nodePublicKey: Uint8Array): Promise<void> {
    const paired: StoredIdentity = {
      ...identity,
      nodeId,
      nodePublicKey: nodePublicKey.slice().buffer,
    }
    await saveIdentity(paired)
    this.identity = paired
  }

  private async openSocket(): Promise<void> {
    this.closeSocket()
    this.socket = new WebSocket(wsUrl())
    this.socket.binaryType = 'arraybuffer'
    store.nodeConnected = false
    this.socketReady = new Promise<void>((resolve, reject) => {
      this.socketReadyResolve = resolve
      this.socketReadyReject = reject
    })
    this.socket.onopen = () => this.socketReadyResolve?.()
    this.socket.onmessage = (event) => this.handleMessage(event)
    this.socket.onerror = () => {
      const error = new Error('Node WebSocket error')
      this.socketReadyReject?.(error)
      this.rejectPending(error)
      this.callbacks.onError?.(error.message)
    }
    this.socket.onclose = () => {
      const error = new Error('Node WebSocket closed')
      this.socketReadyReject?.(error)
      store.nodeConnected = false
      this.rejectPending(error)
      this.callbacks.onError?.(error.message)
      this.callbacks.onDisconnected?.()
      this.disconnectedHandler?.()
    }
    await this.socketReady
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const data = new Uint8Array(event.data as ArrayBuffer)
      const message = fromBinary(SealMessageSchema, data)
      const body = message.body.case
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      if (body === 'transportErrorEvent') pending.reject(new Error(`${message.body.value.code}: ${message.body.value.message}`))
      else pending.resolve(message)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.callbacks.onError?.(`Node message error: ${message}`)
    }
  }

  private request(message: SealMessage): Promise<SealMessage> {
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, { resolve, reject })
      try {
        this.sendMessage(message)
      } catch (error) {
        this.pending.delete(message.requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private closeSocket(): void {
    this.socketReadyReject?.(new Error('Node connection closed'))
    this.socketReady = undefined
    this.socketReadyResolve = undefined
    this.socketReadyReject = undefined
    this.rejectPending(new Error('Node connection closed'))
    if (this.socket) {
      this.socket.onclose = null
      this.socket.onerror = null
      this.socket.close()
      this.socket = null
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `request-${this.requestCounter}`
  }

}

export const nodeClient = new NodeClient()

export function wsUrl(): string {
  return nodeClient.wsUrl()
}
