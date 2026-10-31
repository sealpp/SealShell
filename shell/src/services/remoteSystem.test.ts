import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../native/bridge', () => ({ nativeCall: vi.fn() }))
import { nativeCall } from '../native/bridge'
import { store, type HostProfile } from '../stores/app'
import { detectHostSystem, hostSystem, loadHostSystems, systemIcon, type HostSystem } from './remoteSystem'

const host: HostProfile = { id: 'host', name: 'Host', address: 'server', port: 22, username: 'root', folderId: null }
const record: HostSystem = { id: host.id, target: { address: host.address, port: host.port, username: host.username }, info: { family: 'linux', id: 'ubuntu', name: 'Ubuntu 24.04 LTS' } }

beforeEach(() => {
  vi.mocked(nativeCall).mockReset()
  store.hosts = [{ ...host }]
  store.hostSystems = {}
})

describe('remote system icons', () => {
  it('uses exact distribution IDs and falls back for unknown Linux distributions', () => {
    for (const [id, asset] of [['ubuntu', 'ubuntu'], ['debian', 'debian'], ['arch', 'archlinux'], ['openeuler', 'openeuler'], ['amzn', 'aws'], ['opensuse-tumbleweed', 'opensuse'], ['custom-aarch64', 'linux']]) {
      expect(systemIcon({ family: 'linux', id, name: id })).toContain(`/${asset}.svg`)
    }
    expect(systemIcon({ family: 'linux', id: 'custom', name: 'Ubuntu search Linux' })).toContain('/linux.svg')
    expect(systemIcon({ family: 'macos', id: 'macos', name: 'macOS' })).toContain('/apple.svg')
    expect(systemIcon({ family: 'windows', id: 'windows', name: 'Windows' })).toContain('/windows.svg')
    expect(systemIcon({ family: 'freebsd', id: 'freebsd', name: 'FreeBSD' })).toBeUndefined()
  })

  it('loads persisted results and hides them immediately when the target changes', async () => {
    vi.mocked(nativeCall).mockResolvedValue([record])
    await loadHostSystems()
    expect(hostSystem(host)).toEqual(record)
    expect(hostSystem({ ...host, name: 'Renamed', folderId: 'moved', encoding: 'gbk' })).toEqual(record)
    for (const change of [{ address: 'different' }, { port: 2222 }, { username: 'admin' }]) expect(hostSystem({ ...host, ...change })).toBeUndefined()
  })

  it('updates the saved host without reviving a deleted host or clearing the last successful result', async () => {
    vi.mocked(nativeCall).mockResolvedValue(record)
    await detectHostSystem(host.id, 'session')
    expect(nativeCall).toHaveBeenCalledWith('ssh_detect_system', { id: 'session', hostId: host.id })
    expect(hostSystem(host)).toEqual(record)
    vi.mocked(nativeCall).mockResolvedValue(null)
    await detectHostSystem(host.id, 'session')
    expect(hostSystem(host)).toEqual(record)
    store.hosts = []
    store.hostSystems = {}
    vi.mocked(nativeCall).mockResolvedValue(record)
    await detectHostSystem(host.id, 'old-session')
    expect(store.hostSystems).toEqual({})
  })
})
