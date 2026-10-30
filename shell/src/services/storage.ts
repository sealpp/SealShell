import { nativeCall } from '../native/bridge'
import type { FolderProfile, HostProfile, TerminalPreferences } from '../stores/app'
import type { ProxyProfile } from './proxy/types'
import type { PortRule, PortBindHost } from './ports/types'
import { rememberCommand, type CommandHistoryEntry, type CommandUse } from './terminalSuggestions/model'

export type { HostProfile, FolderProfile } from '../stores/app'
export type StoredTerminalPreferences = TerminalPreferences
export interface EncryptedCredential { id: string; ciphertext: string }
export interface KnownHostRecord { id: string; host: string; port: number; publicKey: string; fingerprint: string }
interface Change { collection: string; key: string; value?: unknown }

async function get<T>(collection: string, key: string): Promise<T | undefined> { return (await nativeCall<T | null>('store_get', { collection, key })) ?? undefined }
function list<T>(collection: string): Promise<T[]> { return nativeCall('store_list', { collection }) }
function write(changes: Change[], requireHost?: string): Promise<boolean> { return nativeCall('store_write', { changes, requireHost }) }
async function put(collection: string, key: string, value: unknown): Promise<void> { await write([{ collection, key, value }]) }
const remove = (collection: string, key: string): Change => ({ collection, key })
const hostRemoval = (id: string): Change[] => [remove('hosts', id), remove('credentials', id), remove('meta', `ports:${id}`), remove('meta', `commandHistory:${id}`)]

export function readMeta<T extends { key: string }>(key: string): Promise<T | undefined> { return get('meta', key) }
export function saveMeta<T extends { key: string }>(value: T): Promise<void> { return put('meta', value.key, value) }
export function listHosts(): Promise<HostProfile[]> { return list('hosts') }
export function listFolders(): Promise<FolderProfile[]> { return list('folders') }
export function saveHost(host: HostProfile): Promise<void> { return put('hosts', host.id, host) }
export function saveFolder(folder: FolderProfile): Promise<void> { return put('folders', folder.id, folder) }

export async function deleteFolderTree(rootFolderIds: string[]): Promise<{ folderIds: string[]; hostIds: string[] }> {
  const [folders, hosts] = await Promise.all([listFolders(), listHosts()])
  const roots = new Set(rootFolderIds), selected = new Set<string>()
  let changed = true
  while (changed) {
    changed = false
    for (const folder of folders) if (!selected.has(folder.id) && (roots.has(folder.id) || (folder.parentId !== null && selected.has(folder.parentId)))) {
      selected.add(folder.id); changed = true
    }
  }
  const hostIds = hosts.filter(host => host.folderId !== null && selected.has(host.folderId)).map(host => host.id)
  await write([...selected].map(id => remove('folders', id)).concat(hostIds.flatMap(hostRemoval)))
  return { folderIds: [...selected], hostIds }
}
export async function moveTreeNodes(folderIds: string[], hostIds: string[], parentId: string | null): Promise<void> {
  const [folders, hosts] = await Promise.all([listFolders(), listHosts()])
  await write([
    ...folders.filter(folder => folderIds.includes(folder.id)).map(folder => ({ collection: 'folders', key: folder.id, value: { ...folder, parentId } })),
    ...hosts.filter(host => hostIds.includes(host.id)).map(host => ({ collection: 'hosts', key: host.id, value: { ...host, folderId: parentId } })),
  ])
}
export async function deleteHost(id: string): Promise<void> { await deleteHosts([id]) }
export async function deleteHosts(ids: string[]): Promise<void> { await write(ids.flatMap(hostRemoval)) }
export function readCredential(id: string): Promise<EncryptedCredential | undefined> { return get('credentials', id) }
export function saveCredential(record: EncryptedCredential): Promise<void> { return put('credentials', record.id, record) }
export async function clearCredential(id: string): Promise<void> { await write([remove('credentials', id)]) }
export async function saveProxyCatalog(items: ProxyProfile[], credentialId: string, credential?: EncryptedCredential | null): Promise<void> {
  const changes: Change[] = [{ collection: 'meta', key: 'proxyServers', value: { key: 'proxyServers', items } }]
  if (credential !== undefined) changes.push({ collection: 'credentials', key: credentialId, value: credential ?? undefined })
  await write(changes)
}
export function readKnownHost(host: string, port: number): Promise<KnownHostRecord | undefined> { return get('knownHosts', `${host}\0${port}`) }
export function saveKnownHost(record: Omit<KnownHostRecord, 'id'>): Promise<void> { const id = `${record.host}\0${record.port}`; return put('knownHosts', id, { ...record, id }) }
export async function readPortRules(hostId: string): Promise<PortRule[]> { return (await get<{ items: PortRule[] }>('meta', `ports:${hostId}`))?.items ?? [] }
export async function savePortRules(hostId: string, items: PortRule[]): Promise<void> { await write([{ collection: 'meta', key: `ports:${hostId}`, value: { key: `ports:${hostId}`, items } }], hostId) }
export async function readPortBindHost(): Promise<PortBindHost> { return (await get<{ host: PortBindHost }>('meta', 'portBindHost'))?.host ?? '127.0.0.1' }
export function savePortBindHost(host: PortBindHost): Promise<void> { return saveMeta({ key: 'portBindHost', host }) }
export async function readCommandHistory(hostId: string): Promise<CommandHistoryEntry[]> { return (await readMeta<{ key: string; items: CommandHistoryEntry[] }>(`commandHistory:${hostId}`))?.items ?? [] }

let historyWrites: Promise<unknown> = Promise.resolve()
export function recordCommandHistory(hostId: string, command: string, use: CommandUse = {}): Promise<CommandHistoryEntry[]> {
  const pending = historyWrites.catch(() => {}).then(async () => {
    const key = `commandHistory:${hostId}`
    const items = rememberCommand(await readCommandHistory(hostId), command, Date.now(), use)
    return await write([{ collection: 'meta', key, value: { key, items } }], hostId) ? items : []
  })
  historyWrites = pending
  return pending
}
export async function clearCommandHistory(): Promise<void> {
  await historyWrites.catch(() => {})
  const records = await list<{ key: string }>('meta')
  await write(records.filter(item => item.key.startsWith('commandHistory:')).map(item => remove('meta', item.key)))
}
