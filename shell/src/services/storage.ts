import type { FolderProfile, HostProfile, TerminalPreferences } from '../stores/app'
import type { ProxyProfile } from './proxy/types'

const DB_NAME = 'seal-shell'
const DB_VERSION = 3

export type { HostProfile } from '../stores/app'
export type { FolderProfile } from '../stores/app'

export interface StoredIdentity {
  key: 'identity'
  deviceId: string
  deviceName: string
  devicePrivateKey: CryptoKey
  devicePublicKey: ArrayBuffer
  nodeId?: string
  nodePublicKey?: ArrayBuffer
}

export interface EncryptedCredential {
  id: string
  version: 1
  nonce: string
  ciphertext: string
}

export interface KnownHostRecord {
  id: string
  host: string
  port: number
  publicKey: string
  fingerprint: string
}

export type StoredTerminalPreferences = TerminalPreferences

let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (database) return database
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => reject(request.error ?? new Error('failed to open PWA database'))
    request.onsuccess = () => resolve(request.result)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('hosts')) {
        db.createObjectStore('hosts', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('credentials')) {
        db.createObjectStore('credentials', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('knownHosts')) {
        db.createObjectStore('knownHosts', { keyPath: 'id' })
      }
    }
  })
  return database
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('PWA database request failed'))
    request.onsuccess = () => resolve(request.result)
  })
}

async function getFromStore<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDatabase()
  return requestResult(db.transaction(storeName, 'readonly').objectStore(storeName).get(key)) as Promise<T | undefined>
}

async function putInStore<T>(storeName: string, value: T): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction(storeName, 'readwrite')
  transaction.objectStore(storeName).put(value)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('PWA database write aborted'))
    transaction.onerror = () => reject(transaction.error ?? new Error('PWA database write failed'))
  })
}

async function deleteFromStore(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDatabase()
  await requestResult(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(key))
}

export async function readIdentity(): Promise<StoredIdentity | undefined> {
  return getFromStore<StoredIdentity>('meta', 'identity')
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  await putInStore('meta', identity)
}

export async function clearIdentity(): Promise<void> {
  await deleteFromStore('meta', 'identity')
}

export async function readMeta<T extends { key: string }>(key: string): Promise<T | undefined> {
  return getFromStore<T>('meta', key)
}

export async function saveMeta<T extends { key: string }>(value: T): Promise<void> {
  await putInStore('meta', value)
}

export async function listHosts(): Promise<HostProfile[]> {
  const db = await openDatabase()
  const hosts = await requestResult<HostProfile[]>(db.transaction('hosts', 'readonly').objectStore('hosts').getAll())
  return hosts.map((host) => ({ ...host, folderId: host.folderId ?? null }))
}

export async function listFolders(): Promise<FolderProfile[]> {
  const db = await openDatabase()
  return requestResult<FolderProfile[]>(db.transaction('folders', 'readonly').objectStore('folders').getAll())
}

export async function saveHost(host: HostProfile): Promise<void> {
  await putInStore('hosts', host)
}

export async function saveFolder(folder: FolderProfile): Promise<void> {
  await putInStore('folders', folder)
}

export async function deleteFolderTree(rootFolderIds: string[]): Promise<{ folderIds: string[]; hostIds: string[] }> {
  if (!rootFolderIds.length) return { folderIds: [], hostIds: [] }
  const db = await openDatabase()
  const readTransaction = db.transaction(['folders', 'hosts'], 'readonly')
  const foldersRequest = readTransaction.objectStore('folders').getAll()
  const hostsRequest = readTransaction.objectStore('hosts').getAll()
  const [allFolders, allHosts] = await Promise.all([
    requestResult<FolderProfile[]>(foldersRequest),
    requestResult<HostProfile[]>(hostsRequest),
  ])
  const roots = new Set(rootFolderIds)
  const folderIds = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const folder of allFolders) {
      if (roots.has(folder.id) || (folder.parentId !== null && folderIds.has(folder.parentId))) {
        if (!folderIds.has(folder.id)) {
          folderIds.add(folder.id)
          changed = true
        }
      }
    }
  }
  const hostIds = allHosts
    .filter((host) => host.folderId !== null && folderIds.has(host.folderId))
    .map((host) => host.id)
  const transaction = db.transaction(['folders', 'hosts', 'credentials'], 'readwrite')
  const folders = transaction.objectStore('folders')
  const hosts = transaction.objectStore('hosts')
  const credentials = transaction.objectStore('credentials')
  folderIds.forEach((id) => folders.delete(id))
  hostIds.forEach((id) => {
    hosts.delete(id)
    credentials.delete(id)
  })
  await new Promise<void>((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error ?? new Error('failed to delete folder tree'))
    transaction.oncomplete = () => resolve()
  })
  return { folderIds: Array.from(folderIds), hostIds }
}

export async function moveTreeNodes(
  folderIds: string[],
  hostIds: string[],
  parentId: string | null,
): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction(['folders', 'hosts'], 'readwrite')
  const folders = transaction.objectStore('folders')
  const hosts = transaction.objectStore('hosts')
  folderIds.forEach((id) => {
    const request = folders.get(id)
    request.onsuccess = () => {
      if (request.result) folders.put({ ...request.result, parentId })
    }
  })
  hostIds.forEach((id) => {
    const request = hosts.get(id)
    request.onsuccess = () => {
      if (request.result) hosts.put({ ...request.result, folderId: parentId })
    }
  })
  await new Promise<void>((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error ?? new Error('failed to move tree nodes'))
    transaction.oncomplete = () => resolve()
  })
}

export async function deleteHost(id: string): Promise<void> {
  await deleteFromStore('hosts', id)
  await deleteFromStore('credentials', id)
}

export async function deleteHosts(ids: string[]): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction(['hosts', 'credentials'], 'readwrite')
  const hosts = transaction.objectStore('hosts')
  const credentials = transaction.objectStore('credentials')
  for (const id of ids) {
    hosts.delete(id)
    credentials.delete(id)
  }
  await new Promise<void>((resolve, reject) => {
    transaction.onerror = () => reject(transaction.error ?? new Error('failed to delete hosts'))
    transaction.oncomplete = () => resolve()
  })
}

export async function readCredential(id: string): Promise<EncryptedCredential | undefined> {
  return getFromStore<EncryptedCredential>('credentials', id)
}

export async function saveCredential(credential: EncryptedCredential): Promise<void> {
  await putInStore('credentials', credential)
}

export async function clearCredential(id: string): Promise<void> {
  await deleteFromStore('credentials', id)
}

export async function saveProxyCatalog(items: ProxyProfile[], credentialId: string, credential?: EncryptedCredential | null): Promise<void> {
  const db = await openDatabase()
  const transaction = db.transaction(['meta', 'credentials'], 'readwrite')
  transaction.objectStore('meta').put({ key: 'proxyServers', items })
  if (credential === null) transaction.objectStore('credentials').delete(credentialId)
  else if (credential) transaction.objectStore('credentials').put(credential)
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('代理配置保存失败'))
    transaction.onerror = () => reject(transaction.error ?? new Error('代理配置保存失败'))
  })
}

function knownHostId(host: string, port: number): string {
  return `${host}\u0000${port}`
}

export async function readKnownHost(host: string, port: number): Promise<KnownHostRecord | undefined> {
  return getFromStore<KnownHostRecord>('knownHosts', knownHostId(host, port))
}

export async function saveKnownHost(record: Omit<KnownHostRecord, 'id'>): Promise<void> {
  await putInStore('knownHosts', { ...record, id: knownHostId(record.host, record.port) })
}
