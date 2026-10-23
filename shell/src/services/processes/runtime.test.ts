import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
const fake = vi.hoisted(() => ({ connect: vi.fn(), credential: vi.fn(), route: vi.fn(), connections: [] as any[] }))
vi.mock('../monitoring/connection', () => ({ connectMonitor: fake.connect }))
vi.mock('../vault', () => ({ loadCredentialRecord: fake.credential }))
vi.mock('../proxy/profiles', () => ({ resolveHostConnection: fake.route, hostProxySource: () => undefined }))
import { store } from '../../stores/app'
import { cancelProcessAction, disposeProcesses, executeProcessAction, openProcesses, prepareProcessAction, setProcessVisible, startProcessesService, stopProcessesService } from './runtime'
const encoder = new TextEncoder()
const snapshot = 'SEAL_PROCESS_V1\tboot\t100\t10\t1700000000\n10\t1\t1000\tuser\tS\t1024\t2\t100\t1\tparent\tparent\n11\t10\t1000\tuser\tS\t1024\t3\t100\t1\tchild\tchild\nSEAL_PROCESS_END\t2\n'
const result = (stdout: string, exitCode = 0) => ({ stdout: encoder.encode(stdout), stderr: new Uint8Array(), exitCode })
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); await nextTick() }
beforeEach(() => {
  vi.useFakeTimers()
  store.tabs = []
  store.hosts = [{ id: 'a', name: 'A', address: 'host', port: 22, username: 'user', folderId: null }]
  store.nodeConnected = true
  fake.connections.length = 0
  fake.credential.mockReset().mockResolvedValue({ password: 'secret' })
  fake.route.mockReset().mockImplementation(async h => ({ host: h.address, port: 22, username: h.username, password: '' }))
  fake.connect.mockReset().mockImplementation(async (options, signal) => {
    const connection = { options, signal, close: vi.fn(async () => undefined), exec: vi.fn(async (cmd: string) => result(cmd === 'uname -s' ? 'Linux' : cmd.includes('SEAL_PROCESS_SIGNAL_V1') ? '11\tdenied\n10\tsent\n' : snapshot)) }
    fake.connections.push(connection)
    return connection
  })
  startProcessesService()
})
afterEach(() => { stopProcessesService(); store.tabs = []; vi.useRealTimers() })

it('deduplicates connecting instances, samples only visible panes and resumes without reconnecting', async () => {
  const tab = openProcesses('a')!
  expect(openProcesses('a')).toBe(tab)
  await settle()
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(1)
  setProcessVisible(tab.id, true)
  await settle()
  expect(tab.processes.rows).toHaveLength(2)
  store.bottomPanelOpen = false
  await settle()
  const count = fake.connections[0].exec.mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(count)
  store.bottomPanelOpen = true
  await settle()
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(count + 1)
  expect(fake.connect).toHaveBeenCalledOnce()
  setProcessVisible(tab.id, false)
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(count + 1)
})

it('confirms a deduplicated tree snapshot and preserves the connection on permission failures', async () => {
  const tab = openProcesses('a')!
  setProcessVisible(tab.id, true)
  await settle()
  const plan = await prepareProcessAction(tab.id, tab.processes.rows.map(row => row.key), 'TERM', 'tree')
  expect(plan?.targets.map(row => row.pid)).toEqual([11, 10])
  const count = fake.connections[0].exec.mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(count)
  await executeProcessAction(tab.id, plan!)
  expect(tab.processes.outcomes.map(row => row.status)).toEqual(['denied', 'sent'])
  expect(tab.state).toBe('online')
  expect(tab.processes.needsPassword).toBe(false)
})

it('cancelling confirmation sends no signal and closing a pane aborts its owned connection', async () => {
  const tab = openProcesses('a')!
  setProcessVisible(tab.id, true)
  await settle()
  await prepareProcessAction(tab.id, [tab.processes.rows[0].key], 'KILL', 'selected')
  cancelProcessAction(tab.id)
  expect(fake.connections[0].exec.mock.calls.every(([cmd]: string[]) => !cmd.includes('SEAL_PROCESS_SIGNAL_V1'))).toBe(true)
  disposeProcesses(tab.id)
  expect(fake.connections[0].signal.aborted).toBe(true)
  const count = fake.connections[0].exec.mock.calls.length
  await vi.advanceTimersByTimeAsync(10000)
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(count)
})

it('serializes action preparation behind an in-flight refresh and discards late results after close', async () => {
  const tab = openProcesses('a')!
  await settle()
  let resolve!: (value: ReturnType<typeof result>) => void
  fake.connections[0].exec.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  setProcessVisible(tab.id, true)
  await settle()
  const preparation = prepareProcessAction(tab.id, ['boot:10:2'], 'TERM', 'selected')
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(2)
  disposeProcesses(tab.id)
  resolve(result(snapshot))
  await preparation
  expect(tab.processes.rows).toEqual([])
  expect(fake.connections[0].exec).toHaveBeenCalledTimes(2)
})

it('keeps configuration snapshots and independent hosts after profiles change or disappear', async () => {
  const a = openProcesses('a')!
  store.hosts.push({ ...store.hosts[0], id: 'b' })
  const b = openProcesses('b')!
  setProcessVisible(a.id, true); setProcessVisible(b.id, true)
  await settle()
  store.hosts[0].address = 'new-host'
  expect(openProcesses('a')).toBe(a)
  store.hosts = []
  await vi.advanceTimersByTimeAsync(2100)
  expect(fake.connections).toHaveLength(2)
  expect(fake.connections.every(connection => connection.options.host === 'host')).toBe(true)
  expect(a.state).toBe('online')
  expect(b.state).toBe('online')
})
