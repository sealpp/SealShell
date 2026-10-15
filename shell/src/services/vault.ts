import {
  readCredential,
  readMeta,
  saveCredential,
  saveMeta,
  type EncryptedCredential,
} from './storage'
import { requireWebCrypto } from './webCrypto'

const VAULT_META_KEY = 'vault'
const VAULT_VERSION = 1
const PROFILE_KEY_ALGORITHM = 'AES-KW'
const VAULT_KEY_ALGORITHM = 'AES-GCM'
const NONCE_BYTES = 12
const textEncoder = new TextEncoder()

interface VaultMeta {
  key: typeof VAULT_META_KEY
  version: typeof VAULT_VERSION
  profileKey: CryptoKey
  profileWrappedVaultKey: string
}

export interface CredentialPayload {
  password?: string
  inlineProxyPassword?: string
}

let activeVaultKey!: CryptoKey

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  requireWebCrypto().getRandomValues(bytes)
  return bytes
}

async function generateProfileKey(): Promise<CryptoKey> {
  return requireWebCrypto().subtle.generateKey(
    { name: PROFILE_KEY_ALGORITHM, length: 256 },
    false,
    ['wrapKey', 'unwrapKey'],
  ) as Promise<CryptoKey>
}

async function generateVaultKey(): Promise<CryptoKey> {
  return requireWebCrypto().subtle.generateKey(
    { name: VAULT_KEY_ALGORITHM, length: 256 },
    true,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>
}

async function wrapVaultKey(vaultKey: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const wrapped = await requireWebCrypto().subtle.wrapKey('raw', vaultKey, wrappingKey, PROFILE_KEY_ALGORITHM)
  return bytesToBase64(new Uint8Array(wrapped))
}

async function unwrapVaultKey(wrapped: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  return requireWebCrypto().subtle.unwrapKey(
    'raw',
    arrayBuffer(base64ToBytes(wrapped)),
    wrappingKey,
    PROFILE_KEY_ALGORITHM,
    { name: VAULT_KEY_ALGORITHM, length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

export async function initializeVault(): Promise<void> {
  requireWebCrypto()
  let meta = await readMeta<VaultMeta>(VAULT_META_KEY)
  if (!meta) {
    const profileKey = await generateProfileKey()
    const vaultKey = await generateVaultKey()
    meta = {
      key: VAULT_META_KEY,
      version: VAULT_VERSION,
      profileKey,
      profileWrappedVaultKey: await wrapVaultKey(vaultKey, profileKey),
    }
    await saveMeta(meta)
    activeVaultKey = vaultKey
    return
  }

  if (meta.version !== VAULT_VERSION) {
    throw new Error('unsupported PWA vault version')
  }

  if (!meta.profileKey) {
    throw new Error('PWA vault profile key is missing')
  }
  activeVaultKey = await unwrapVaultKey(meta.profileWrappedVaultKey, meta.profileKey)
}

export async function encryptCredentialRecord(id: string, value: CredentialPayload): Promise<EncryptedCredential> {
  const nonce = randomBytes(NONCE_BYTES)
  const plaintext = textEncoder.encode(JSON.stringify(value))
  const ciphertext = await requireWebCrypto().subtle.encrypt(
    {
      name: VAULT_KEY_ALGORITHM,
      iv: arrayBuffer(nonce),
      additionalData: arrayBuffer(textEncoder.encode(`credential:${id}:v${VAULT_VERSION}`)),
    },
    activeVaultKey,
    arrayBuffer(plaintext),
  )
  const record: EncryptedCredential = {
    id,
    version: VAULT_VERSION,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  }
  return record
}

export async function saveCredentialRecord(id: string, value: CredentialPayload): Promise<void> {
  await saveCredential(await encryptCredentialRecord(id, value))
}

export async function loadCredentialRecord(id: string): Promise<CredentialPayload | undefined> {
  const record = await readCredential(id)
  if (!record) return undefined
  if (record.version !== VAULT_VERSION) {
    throw new Error('unsupported PWA credential version')
  }
  const plaintext = await requireWebCrypto().subtle.decrypt(
    {
      name: VAULT_KEY_ALGORITHM,
      iv: arrayBuffer(base64ToBytes(record.nonce)),
      additionalData: arrayBuffer(textEncoder.encode(`credential:${id}:v${VAULT_VERSION}`)),
    },
    activeVaultKey,
    arrayBuffer(base64ToBytes(record.ciphertext)),
  )
  return JSON.parse(new TextDecoder().decode(plaintext)) as CredentialPayload
}
