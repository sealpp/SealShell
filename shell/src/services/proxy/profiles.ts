import { store, type HostProfile } from '../../stores/app'
import { readMeta, saveProxyCatalog } from '../storage'
import { encryptCredentialRecord, loadCredentialRecord } from '../vault'
import { normalizeTarget, ProxyError, validateProxy, type ProxyConnection } from '../transport/types'
import type { ProxyProfile, ProxySource, RemoteConnection } from './types'

const credentialId = (id: string) => `proxy:${id}`

export async function loadProxyProfiles(): Promise<void> {
  store.proxies = (await readMeta<{ key: string; items: ProxyProfile[] }>('proxyServers'))?.items ?? []
}

export function proxyReferences(id: string): HostProfile[] {
  return store.hosts.filter(host => host.proxy?.savedId === id)
}

export async function proxyPassword(source: ProxySource): Promise<string | undefined> {
  const record = await loadCredentialRecord(source.kind === 'saved' ? credentialId(source.id) : source.id)
  return source.kind === 'saved' ? record?.password : record?.inlineProxyPassword
}

let writing: Promise<unknown> = Promise.resolve()
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = writing.then(operation)
  writing = next.catch(() => undefined)
  return next
}

export function saveProxyProfile(profile: ProxyProfile, password?: string | null): Promise<void> {
  const value = { ...profile, name: profile.name.trim(), ...normalizeTarget(profile) }
  return serialize(async () => {
    if (!value.name) throw new Error('请输入代理名称')
    if (store.proxies.some(item => item.id !== value.id && item.name === value.name)) throw new Error('已存在同名代理')
    validateProxy(value, password ?? undefined)
    const id = credentialId(value.id)
    const credential = password === null ? null : password === undefined ? undefined : await encryptCredentialRecord(id, { password })
    const items = store.proxies.filter(item => item.id !== value.id).map(item => ({ ...item }))
    items.push(value)
    items.sort((a, b) => a.name.localeCompare(b.name))
    await saveProxyCatalog(items, id, credential)
    store.proxies = items
  })
}

export function deleteProxyProfile(id: string): Promise<void> {
  return serialize(async () => {
    const references = proxyReferences(id)
    if (references.length) throw new Error(`请先解除以下主机的引用：${references.map(host => host.name).join('、')}`)
    const items = store.proxies.filter(item => item.id !== id).map(item => ({ ...item }))
    await saveProxyCatalog(items, credentialId(id), null)
    store.proxies = items
  })
}

export function hostProxySource(host: HostProfile): ProxySource | undefined {
  if (!host.proxy?.enabled) return undefined
  return host.proxy.mode === 'saved'
    ? { kind: 'saved', id: host.proxy.savedId ?? '' }
    : { kind: 'host', id: host.id }
}

export async function resolveHostConnection(host: HostProfile, password: string): Promise<RemoteConnection> {
  const connection: RemoteConnection = { host: host.address, port: host.port, username: host.username, password }
  const source = hostProxySource(host)
  if (!source) return connection
  connection.proxySource = source
  const definition = source.kind === 'saved' ? store.proxies.find(proxy => proxy.id === source.id) : host.proxy!.inline
  if (!definition) throw new ProxyError('connect', '请选择有效的公共代理')
  // Copy before awaiting credentials: edits must not mutate an in-flight route.
  const proxy: ProxyConnection = { type: definition.type, ...normalizeTarget(definition), authentication: definition.authentication, username: definition.username }
  proxy.password = proxy.authentication === 'password' ? await proxyPassword(source) : undefined
  validateProxy(proxy, proxy.password)
  connection.proxy = proxy
  return connection
}

export function editProxySource(source: ProxySource): void {
  if (source.kind === 'saved') {
    store.settingsSection = 'proxies'
    store.editingProxyId = source.id
    store.settingsModalOpen = true
  } else {
    store.editingHostId = source.id
    store.connectionModalOpen = true
  }
}
