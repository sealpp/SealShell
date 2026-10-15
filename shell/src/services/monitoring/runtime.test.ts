import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

const fake = vi.hoisted(() => ({ credential: vi.fn(), connect: vi.fn(), route: vi.fn(), workers: [] as any[] }))
vi.mock('../vault', () => ({ loadCredentialRecord: fake.credential }))
vi.mock('../proxy/profiles', () => ({ resolveHostConnection: fake.route, hostProxySource: () => undefined }))
vi.mock('./connection', () => ({ connectMonitor: fake.connect }))

import { store } from '../../stores/app'
import { disposeMonitor, openMonitor, retryMonitor, startMonitoringService, stopMonitoringService } from './runtime'
import { closeProtection } from '../close-protection'

const encoder = new TextEncoder()
const sample = '__SEAL_CPU__\ncpu 30 0 20 50\n__SEAL_MEM__\nMem: 100 40 5 0 5 60\n__SEAL_DISK__\nFilesystem Blocks Used Available Capacity Mounted\n/dev/root 100 20 80 20% /\n__SEAL_PROCS__\nPID\n1\n2\n'
function result(text: string) { return { stdout: encoder.encode(text), stderr: new Uint8Array(), exitCode: 0 } }
async function settle() { for (let i = 0; i < 25; i++) await Promise.resolve() }

beforeEach(() => {
  vi.useFakeTimers()
  fake.workers.length = 0
  store.tabs = []
  store.hosts = [{ id: 'a', name: 'A', address: 'old-host', port: 22, username: 'old-user', folderId: null }]
  store.nodeConnected = true
  fake.credential.mockReset().mockResolvedValue({ password: 'old-password' })
  fake.route.mockReset().mockImplementation(async host => ({ host: host.address, port: host.port, username: host.username, password: '', proxy: { host: 'old-proxy' } }))
  fake.connect.mockReset().mockImplementation(async (options, signal: AbortSignal) => {
    const worker = { options, signal, exec: vi.fn(async (command: string) => result(command === 'uname -s' ? 'Linux\n' : sample)), close: vi.fn(async () => undefined) }
    fake.workers.push(worker)
    return worker
  })
  startMonitoringService()
})
afterEach(() => {
  stopMonitoringService()
  store.tabs = []
  vi.useRealTimers()
})

it('deduplicates opens even during credential lookup, while distinct profiles remain separate', async () => {
  let resolve!: (record: { password: string }) => void
  fake.credential.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const first = openMonitor('a')!
  expect(openMonitor('a')).toBe(first)
  expect(store.tabs).toHaveLength(1)
  store.hosts.push({ ...store.hosts[0], id: 'b' })
  openMonitor('b')
  resolve({ password: 'old-password' })
  await settle()
  expect(store.tabs).toHaveLength(2)
  expect(fake.connect).toHaveBeenCalledTimes(2)
  expect(fake.workers.every(worker => worker.exec.mock.calls.length === 2)).toBe(true)
})

it('continues sampling all instances with the panel hidden and no terminal', async () => {
  const tab = openMonitor('a')!
  await settle()
  expect(tab.monitor.telemetry?.metrics['process.count'].value).toBe(2)
  store.bottomPanelOpen = false
  store.bottomPanelCategory = 'files'
  store.activeTerminalTabId = 'unrelated'
  await vi.advanceTimersByTimeAsync(6000)
  expect(fake.workers[0].exec).toHaveBeenCalledTimes(5)
  expect(tab.state).toBe('online')
})

it('retains the original route and credentials through edits, deletion and retries', async () => {
  const tab = openMonitor('a')!
  await settle()
  store.hosts[0].address = 'new-host'
  store.hosts[0].name = 'renamed'
  fake.credential.mockResolvedValue({ password: 'new-password' })
  expect(openMonitor('a')).toBe(tab)
  await retryMonitor(tab.id)
  expect(fake.workers[1].options).toMatchObject({ host: 'old-host', password: 'old-password', proxy: { host: 'old-proxy' } })
  expect(tab.label).toBe('A')
  store.hosts = []
  await vi.advanceTimersByTimeAsync(2000)
  expect(tab.state).toBe('online')
  expect(openMonitor('a')).toBe(tab)
  disposeMonitor(tab.id)
  store.tabs = []
  store.hosts = [{ id: 'a', name: 'new', address: 'new-host', port: 22, username: 'new-user', folderId: null }]
  const next = openMonitor('a')!
  await settle()
  expect(next.id).not.toBe(tab.id)
  expect(fake.workers[2].options).toMatchObject({ host: 'new-host', password: 'new-password' })
})

it('does not connect or revive an instance closed while credentials are pending', async () => {
  let resolve!: (record: { password: string }) => void
  fake.credential.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const tab = openMonitor('a')!
  expect(closeProtection.blocked.value).toBe(true)
  disposeMonitor(tab.id)
  store.tabs = []
  resolve({ password: 'unused' })
  await settle()
  expect(fake.connect).not.toHaveBeenCalled()
  expect(closeProtection.blocked.value).toBe(false)
})

it('cancels an in-flight sample on close and does not schedule another', async () => {
  const tab = openMonitor('a')!
  await settle()
  let resolve!: (data: ReturnType<typeof result>) => void
  fake.workers[0].exec.mockReturnValueOnce(new Promise(done => { resolve = done }))
  await vi.advanceTimersByTimeAsync(2000)
  const before = tab.monitor.telemetry
  disposeMonitor(tab.id)
  expect(fake.workers[0].signal.aborted).toBe(true)
  resolve(result(sample))
  await settle()
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.workers[0].exec).toHaveBeenCalledTimes(3)
  expect(tab.monitor.telemetry).toBe(before)
})

it('requests its own password and reports authentication failures without opening a terminal', async () => {
  fake.credential.mockResolvedValue(undefined)
  const tab = openMonitor('a')!
  await settle()
  expect(tab.monitor.needsPassword).toBe(true)
  fake.connect.mockRejectedValueOnce(new Error('AUTHENTICATION_FAILED'))
  await retryMonitor(tab.id, 'wrong')
  expect(tab.state).toBe('error')
  expect(tab.monitor.needsPassword).toBe(true)
  await retryMonitor(tab.id, 'correct')
  expect(tab.state).toBe('online')
  expect(store.tabs.map(tab => tab.kind)).toEqual(['monitor'])
})

it('stops on a Node disconnection and retries with the same snapshot', async () => {
  const tab = openMonitor('a')!
  await settle()
  store.nodeConnected = false
  await nextTick()
  expect(tab.state).toBe('error')
  expect(tab.monitor.telemetry).toBeNull()
  expect(fake.workers[0].signal.aborted).toBe(true)
  store.nodeConnected = true
  await nextTick()
  await retryMonitor(tab.id)
  expect(tab.state).toBe('online')
})

it('keeps proxy authentication failures separate from SSH password entry', async () => {
  fake.connect.mockRejectedValueOnce(new Error('PROXY_ERROR: proxy authentication failed'))
  const tab = openMonitor('a')!
  await settle()
  expect(tab.state).toBe('error')
  expect(tab.monitor.needsPassword).toBe(false)
  expect(tab.error).toContain('PROXY_ERROR')
})

it('releases an unsupported target and never samples it', async () => {
  const exec = vi.fn(async () => result('Darwin\n'))
  const close = vi.fn(async () => undefined)
  fake.connect.mockResolvedValueOnce({ exec, close })
  const tab = openMonitor('a')!
  await settle()
  expect(tab.monitor.unsupported).toBe(true)
  await vi.advanceTimersByTimeAsync(10000)
  expect(exec).toHaveBeenCalledOnce()
  expect(close).toHaveBeenCalledOnce()
})
