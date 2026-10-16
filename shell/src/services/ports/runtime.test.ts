import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const fake = vi.hoisted(() => ({ credential: vi.fn(), connect: vi.fn(), route: vi.fn(), read: vi.fn(), save: vi.fn(), start: vi.fn(), forwards: [] as any[], discoveries: [] as any[] }))
vi.mock('../vault', () => ({ loadCredentialRecord: fake.credential }))
vi.mock('../proxy/profiles', () => ({ resolveHostConnection: fake.route, hostProxySource: () => undefined }))
vi.mock('../storage', () => ({ readPortRules: fake.read, savePortRules: fake.save, readPortBindHost: async () => '127.0.0.1', savePortBindHost: vi.fn() }))
vi.mock('../ssh/connection', () => ({ connectSsh: fake.connect }))
vi.mock('./forwarder', () => ({ PortForwarder: class {
  close = vi.fn(async () => undefined)
  start = (...args: unknown[]) => fake.start(...args)
  constructor(readonly onState: (error: Error | null, fatal: boolean) => void) { fake.forwards.push(this) }
} }))

import { store } from '../../stores/app'
import { addPort, configurePort, disposePorts, openPorts, retryPorts, startPortsService, stopPortsService } from './runtime'

const result = (value: string) => ({ stdout: new TextEncoder().encode(value), stderr: new Uint8Array(), exitCode: 0 })
async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve() }
beforeEach(() => {
  vi.useFakeTimers()
  fake.forwards.length = 0; fake.discoveries.length = 0
  store.tabs = []; store.hosts = [{ id: 'a', name: 'A', address: 'old-host', port: 22, username: 'old-user', folderId: null }]; store.nodeConnected = true
  fake.credential.mockReset().mockResolvedValue({ password: 'secret' })
  fake.route.mockReset().mockImplementation(async host => ({ host: host.address, port: host.port, username: host.username, password: '' }))
  fake.read.mockReset().mockResolvedValue([])
  fake.save.mockReset().mockResolvedValue(undefined)
  fake.start.mockReset().mockResolvedValue(33000)
  fake.connect.mockReset().mockImplementation(async (options, signal) => {
    const ssh = { worker: { exec: vi.fn(async command => result(command === 'uname -s' ? 'Linux\n' : '0: 00000000:0BB8 00000000:0000 0A')) }, close: vi.fn(async () => undefined), options, signal }
    fake.discoveries.push(ssh)
    return ssh
  })
  startPortsService()
})
afterEach(async () => { stopPortsService(); await settle(); store.tabs = []; vi.useRealTimers() })

it('deduplicates pending opens, discovers unchecked ports, and keeps snapshots after edits or deletion', async () => {
  const tab = openPorts('a')!
  expect(openPorts('a')).toBe(tab)
  await settle()
  expect(tab.ports.rows).toHaveLength(1)
  expect(tab.ports.rows[0]).toMatchObject({ enabled: false, status: 'disabled', listening: true })
  expect(fake.start).not.toHaveBeenCalled()
  store.hosts[0].address = 'new-host'
  store.hosts = []
  expect(openPorts('a')).toBe(tab)
  await retryPorts(tab.id)
  expect(fake.discoveries[1].options.host).toBe('old-host')
  expect(tab.state).toBe('online')
})

it('restores checked rules, persists actual local ports and retains failures as checked', async () => {
  fake.read.mockResolvedValue([{ id: 'localhost:3000', host: 'localhost', port: 3000, localPort: 3000, enabled: true }])
  fake.start.mockRejectedValueOnce(new Error('permission denied'))
  const tab = openPorts('a')!
  await settle()
  expect(tab.ports.rows[0]).toMatchObject({ enabled: true, status: 'failed', error: 'permission denied' })
  await configurePort(tab.id, 'localhost:3000', { enabled: true })
  expect(tab.ports.rows[0]).toMatchObject({ enabled: true, status: 'active', localPort: 33000 })
  expect(fake.save).toHaveBeenLastCalledWith('a', [expect.objectContaining({ enabled: true, localPort: 33000 })])
})

it('preserves user forwarding when discovery loses a service and while hidden', async () => {
  const tab = openPorts('a')!
  await settle()
  await configurePort(tab.id, 'localhost:3000', { enabled: true })
  fake.discoveries[0].worker.exec.mockResolvedValue(result(''))
  store.bottomPanelOpen = false
  await vi.advanceTimersByTimeAsync(3000)
  expect(tab.ports.rows[0]).toMatchObject({ status: 'active', enabled: true, listening: false })
  expect(fake.forwards[0].close).not.toHaveBeenCalled()
})

it('waits for old forwarding to close before rebinding and ignores late failure callbacks', async () => {
  const tab = openPorts('a')!
  await settle()
  await addPort(tab.id, '10.0.0.8:5432')
  let release!: () => void
  fake.forwards[0].close.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  const change = configurePort(tab.id, '10.0.0.8:5432', { localPort: 5433 })
  await settle()
  expect(fake.start).toHaveBeenCalledTimes(1)
  fake.forwards[0].onState(new Error('old failure'), true)
  release(); await change
  expect(fake.start).toHaveBeenCalledTimes(2)
  expect(tab.ports.rows.find(row => row.port === 5432)).toMatchObject({ status: 'active', error: '' })
})

it('does not revive a closed pending instance and stops forwarding when Node disconnects', async () => {
  let resolve!: (value: { password: string }) => void
  fake.credential.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const first = openPorts('a')!
  await disposePorts(first.id)
  store.tabs = []
  resolve({ password: 'secret' }); await settle()
  expect(fake.connect).not.toHaveBeenCalled()
  const tab = openPorts('a')!
  await settle()
  await addPort(tab.id, '3000')
  store.nodeConnected = false; await nextTick(); await settle()
  expect(fake.forwards[0].close).toHaveBeenCalled()
  expect(tab.ports.rows[0]).toMatchObject({ enabled: true, status: 'failed' })
})
