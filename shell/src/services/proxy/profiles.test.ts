import { beforeEach, describe, expect, it, vi } from 'vitest'
const records = vi.hoisted(() => new Map<string, { password?: string; inlineProxyPassword?: string }>())
vi.mock('../storage', () => ({
  readMeta: vi.fn(async () => undefined),
  saveProxyCatalog: vi.fn(async (_items: unknown, id: string, credential?: { value: unknown } | null) => {
    if (credential === null) records.delete(id)
    else if (credential) records.set(id, credential.value as { password: string })
  }),
}))
vi.mock('../vault', () => ({
  loadCredentialRecord: vi.fn(async (id: string) => records.get(id)),
  encryptCredentialRecord: vi.fn(async (id: string, value: unknown) => ({ id, value })),
}))
import { store, type HostProfile } from '../../stores/app'
import { deleteProxyProfile, proxyPassword, proxyReferences, resolveHostConnection, saveProxyProfile } from './profiles'
import { defaultHostProxy, type ProxyProfile } from './types'

const profile: ProxyProfile = { id: 'shared', name: 'Office', type: 'socks5', host: 'proxy.example', port: 1080, authentication: 'password', username: 'alice' }
const host = (): HostProfile => ({ id: 'host', name: 'Server', address: 'internal', port: 22, username: 'root', folderId: null, proxy: { ...defaultHostProxy(), enabled: true, mode: 'saved', savedId: 'shared' } })

describe('proxy profiles and connection snapshots', () => {
  beforeEach(() => { store.proxies = []; store.hosts = []; records.clear() })

  it('resolves an independent snapshot and keeps saved passwords on blank edits', async () => {
    await saveProxyProfile(profile, 'original')
    const connection = await resolveHostConnection(host(), 'ssh-password')
    await saveProxyProfile({ ...profile, host: 'new-proxy.example' })
    expect(await proxyPassword({ kind: 'saved', id: 'shared' })).toBe('original')
    expect(connection.proxy).toMatchObject({ host: 'proxy.example', password: 'original' })
    await saveProxyProfile({ ...profile, host: 'new-proxy.example' }, 'changed')
    expect((await resolveHostConnection(host(), 'ssh-password')).proxy).toMatchObject({ host: 'new-proxy.example', password: 'changed' })
    expect(connection.proxy).toMatchObject({ host: 'proxy.example', password: 'original' })
    expect(JSON.stringify(store.proxies)).not.toContain('changed')
  })

  it('counts retained references even while disabled or using inline settings', async () => {
    await saveProxyProfile(profile, 'password')
    const server = host()
    server.proxy!.enabled = false
    server.proxy!.mode = 'inline'
    store.hosts = [server]
    expect(proxyReferences('shared').map(item => item.id)).toEqual(['host'])
    await expect(deleteProxyProfile('shared')).rejects.toThrow('Server')
    expect(store.proxies).toHaveLength(1)
    store.hosts[0].proxy!.savedId = null
    await deleteProxyProfile('shared')
    expect(store.proxies).toHaveLength(0)
    expect(records.has('proxy:shared')).toBe(false)
  })

  it('never turns an enabled missing proxy into a direct connection', async () => {
    await expect(resolveHostConnection(host(), 'ssh-password')).rejects.toMatchObject({ code: 'PROXY_ERROR' })
    const server = host()
    server.proxy!.enabled = false
    expect((await resolveHostConnection(server, 'ssh-password')).proxy).toBeUndefined()
    expect(server.proxy!.savedId).toBe('shared')
  })

  it('keeps SSH and inline proxy credentials distinct', async () => {
    const server = host()
    server.proxy!.mode = 'inline'
    server.proxy!.inline = { ...profile }
    records.set('host', { password: 'ssh-password', inlineProxyPassword: 'proxy-password' })
    const connection = await resolveHostConnection(server, 'ssh-password')
    server.proxy!.inline.host = 'edited.example'
    expect(connection.password).toBe('ssh-password')
    expect(connection.proxy).toMatchObject({ host: 'proxy.example', password: 'proxy-password' })
  })

  it('serializes catalog edits and explicitly clears a saved password', async () => {
    await Promise.all([saveProxyProfile(profile, 'first'), saveProxyProfile({ ...profile, id: 'second', name: 'Second' }, 'second')])
    expect(store.proxies).toHaveLength(2)
    await saveProxyProfile(profile, null)
    expect(await proxyPassword({ kind: 'saved', id: 'shared' })).toBeUndefined()
    expect(await proxyPassword({ kind: 'saved', id: 'second' })).toBe('second')
  })
})
