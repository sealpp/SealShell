import { reactive, watch } from 'vue'
import { setBottomPanelActiveTab, store, type PortsTab } from '../../stores/app'
import { loadCredentialRecord } from '../vault'
import { hostProxySource, resolveHostConnection } from '../proxy/profiles'
import { copyHostProxy, type RemoteConnection } from '../proxy/types'
import { readPortBindHost, readPortRules, savePortBindHost, savePortRules } from '../storage'
import { connectSsh } from '../ssh/connection'
import { closeProtection } from '../close-protection'
import { DISCOVER_PORTS, endpointId, parseListeningPorts, parsePortTarget } from './discovery'
import { PortForwarder } from './forwarder'
import type { PortBindHost, PortRow } from './types'

const runtimes = new Map<string, PortsRuntime>()
let stopWatch: (() => void) | undefined
export const portPreferences = reactive<{ host: PortBindHost; error: string }>({ host: '127.0.0.1', error: '' })
const preferencesReady = readPortBindHost().then(host => { portPreferences.host = host }).catch(error => { portPreferences.error = String(error) })

class PortsRuntime {
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private discovery?: Awaited<ReturnType<typeof connectSsh>>
  private connection?: RemoteConnection
  private password?: string
  private disposed = false
  private readonly forwards = new Map<string, PortForwarder>()
  private readonly operations = new Map<string, Promise<void>>()
  private readonly versions = new Map<string, number>()
  private readonly ready: Promise<void>
  private saving: Promise<void> = Promise.resolve()

  constructor(readonly tab: PortsTab, private readonly snapshot: Promise<RemoteConnection>, private readonly savedPassword: Promise<string | undefined>) {
    void snapshot.catch(() => undefined)
    void savedPassword.catch(() => undefined)
    this.ready = Promise.all([readPortRules(tab.hostId), preferencesReady]).then(([rules]) => {
      tab.ports.rows = rules.map(rule => ({ ...rule, configured: true, listening: null, status: 'disabled', error: '' }))
    })
  }

  async start(password?: string): Promise<void> {
    const closing = this.stop()
    const controller = new AbortController()
    this.controller = controller
    const current = () => !this.disposed && this.controller === controller && !controller.signal.aborted
    this.tab.state = 'connecting'
    this.tab.error = ''
    this.tab.ports.needsPassword = false
    this.tab.ports.discovery = 'connecting'
    this.tab.ports.discoveryError = ''
    const release = closeProtection.acquire('ports-connection')
    try {
      await closing
      await this.ready
      const snapshot = await this.snapshot
      if (password !== undefined) this.password = password
      if (this.password === undefined) this.password = await this.savedPassword
      if (!current()) return
      if (this.password === undefined) {
        this.tab.ports.needsPassword = true
        this.tab.state = 'idle'
        return
      }
      if (!store.nodeConnected) throw new Error('Node 未连接，请连接后重试。')
      this.connection = { ...snapshot, password: this.password }
      this.discovery = await connectSsh(this.connection, controller.signal)
      if (!current()) return
      this.tab.state = 'online'
      for (const row of this.tab.ports.rows) if (row.enabled) void this.restart(row)
      try {
        const result = await this.discovery.worker.exec('uname -s')
        if (!current()) return
        if (result.exitCode || new TextDecoder().decode(result.stdout).trim() !== 'Linux') {
          this.tab.ports.discovery = 'unsupported'
          return
        }
        const sample = async () => {
          if (!current()) return
          try {
            const result = await this.discovery!.worker.exec(DISCOVER_PORTS)
            if (!current()) return
            if (result.exitCode && !result.stdout.length) throw new Error('无法读取服务器监听端口，可手工添加转发。')
            this.reconcile(parseListeningPorts(new TextDecoder().decode(result.stdout)))
            this.tab.ports.discovery = 'ready'
            this.tab.ports.discoveryError = ''
            this.timer = setTimeout(() => void sample(), 3000)
          } catch (error) { if (current()) this.discoveryFailed(error) }
        }
        await sample()
      } catch (error) { if (current()) this.discoveryFailed(error) }
    } catch (error) { if (current()) this.fail(error) }
    finally { release() }
  }

  private discoveryFailed(error: unknown): void {
    this.tab.ports.discovery = 'failed'
    this.tab.ports.discoveryError = error instanceof Error ? error.message : String(error)
    for (const row of this.tab.ports.rows) row.listening = null
  }

  private reconcile(discovered: Array<{ host: string; port: number }>): void {
    const ids = new Set(discovered.map(item => endpointId(item.host, item.port)))
    this.tab.ports.rows = this.tab.ports.rows.filter(row => row.configured || ids.has(row.id))
    for (const row of this.tab.ports.rows) row.listening = ids.has(row.id)
    for (const item of discovered) {
      const id = endpointId(item.host, item.port)
      if (!this.tab.ports.rows.some(row => row.id === id)) this.tab.ports.rows.push({ ...item, id, localPort: item.port, enabled: false, configured: false, listening: true, status: 'disabled', error: '' })
    }
    this.tab.ports.rows.sort((a, b) => a.port - b.port || a.host.localeCompare(b.host))
  }

  private persist(): Promise<void> {
    const items = this.tab.ports.rows.filter(row => row.configured).map(({ id, host, port, localPort, enabled }) => ({ id, host, port, localPort, enabled }))
    const release = closeProtection.acquire('port-rules-save')
    this.saving = this.saving.then(() => savePortRules(this.tab.hostId, items)).then(() => { this.tab.ports.saveError = '' })
      .catch(error => { this.tab.ports.saveError = `保存失败：${error instanceof Error ? error.message : error}` }).finally(release)
    return this.saving
  }

  async configure(id: string, values: { enabled?: boolean; localPort?: number }): Promise<void> {
    await this.ready
    if (this.disposed) return
    const row = this.tab.ports.rows.find(row => row.id === id)
    if (!row) return
    Object.assign(row, values, { configured: true })
    await Promise.all([this.persist(), this.restart(row)])
  }

  async add(value: string): Promise<void> {
    const target = parsePortTarget(value)
    await this.ready
    if (this.disposed) return
    const id = endpointId(target.host, target.port)
    if (!this.tab.ports.rows.some(row => row.id === id)) this.tab.ports.rows.push({ ...target, id, localPort: target.port, enabled: false, configured: true, listening: null, status: 'disabled', error: '' })
    await this.configure(id, { enabled: true })
  }

  async remove(id: string): Promise<void> {
    await this.configure(id, { enabled: false })
    const row = this.tab.ports.rows.find(row => row.id === id)
    if (!row) return
    row.configured = false
    if (!row.listening) this.tab.ports.rows = this.tab.ports.rows.filter(row => row.id !== id)
    await this.persist()
  }

  restart(row: PortRow): Promise<void> {
    const version = (this.versions.get(row.id) ?? 0) + 1
    this.versions.set(row.id, version)
    const old = this.forwards.get(row.id)
    this.forwards.delete(row.id)
    const closing = old?.close()
    row.status = row.enabled ? 'connecting' : 'disabled'
    row.error = ''
    const operation = (async () => {
      await this.operations.get(row.id)
      await closing
      if (this.disposed || this.versions.get(row.id) !== version || !row.enabled) return
      if (!this.connection || this.controller?.signal.aborted) {
        row.status = 'failed'
        row.error = this.tab.ports.needsPassword ? '请先输入 SSH 密码。' : '请先连接会话。'
        return
      }
      const forward = new PortForwarder((error, fatal) => {
        if (this.forwards.get(row.id) !== forward) return
        row.error = error?.message ?? ''
        row.status = error ? 'failed' : 'active'
        if (fatal) { this.forwards.delete(row.id); void forward.close() }
      })
      this.forwards.set(row.id, forward)
      const release = closeProtection.acquire('port-forward-start')
      try {
        const actualPort = await forward.start(this.connection, { ...row }, portPreferences.host)
        if (this.forwards.get(row.id) !== forward) return
        row.localPort = actualPort
        row.status = 'active'
        await this.persist()
      } catch (error) {
        if (this.forwards.get(row.id) !== forward) return
        this.forwards.delete(row.id)
        row.status = 'failed'
        row.error = error instanceof Error ? error.message : String(error)
      } finally { release() }
    })()
    this.operations.set(row.id, operation)
    void operation.finally(() => { if (this.operations.get(row.id) === operation) this.operations.delete(row.id) })
    return operation
  }

  stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.connection = undefined
    const discovery = this.discovery
    this.discovery = undefined
    const forwards = [...this.forwards.values()]
    this.forwards.clear()
    for (const row of this.tab.ports.rows) this.versions.set(row.id, (this.versions.get(row.id) ?? 0) + 1)
    return Promise.all([discovery?.close(), ...forwards.map(forward => forward.close())]).then(() => undefined)
  }

  fail(error: unknown): void {
    void this.stop()
    this.tab.error = error instanceof Error ? error.message : String(error)
    this.tab.state = 'error'
    this.tab.ports.needsPassword = !this.tab.error.includes('PROXY_ERROR') && /AUTHENTICATION_FAILED|authentication|permission denied/i.test(this.tab.error)
    this.discoveryFailed(error)
    for (const row of this.tab.ports.rows) {
      row.status = row.enabled ? 'failed' : 'disabled'
      row.error = row.enabled ? this.tab.error : ''
    }
  }

  async dispose(): Promise<void> { this.disposed = true; await this.stop(); await this.saving }
}

export function openPorts(hostId: string): PortsTab | undefined {
  const existing = store.tabs.find((tab): tab is PortsTab => tab.kind === 'port' && tab.hostId === hostId)
  if (existing) { reveal(existing); return existing }
  const host = store.hosts.find(host => host.id === hostId)
  if (!host) return
  const profile = { ...host, proxy: host.proxy ? copyHostProxy(host.proxy) : undefined }
  const snapshot = resolveHostConnection(profile, '')
  const password = loadCredentialRecord(hostId).then(record => record?.password)
  const tab: PortsTab = {
    id: crypto.randomUUID(), kind: 'port', hostId, label: profile.name, proxySource: hostProxySource(profile),
    state: 'connecting', error: '', sessionId: '', terminalId: '', encoding: 'utf-8',
    ports: { address: profile.address, port: profile.port, username: profile.username, rows: [], needsPassword: false, discovery: 'connecting', discoveryError: '', saveError: '' },
  }
  store.tabs.push(tab)
  const reactiveTab = store.tabs.find(item => item.id === tab.id) as PortsTab
  const runtime = new PortsRuntime(reactiveTab, snapshot, password)
  runtimes.set(tab.id, runtime)
  reveal(reactiveTab)
  void runtime.start()
  return reactiveTab
}
function reveal(tab: PortsTab): void { setBottomPanelActiveTab(tab.id, 'ports'); store.bottomPanelOpen = true; store.view = 'shell' }
export function retryPorts(id: string, password?: string): Promise<void> { return runtimes.get(id)?.start(password) ?? Promise.resolve() }
export function configurePort(tabId: string, id: string, values: { enabled?: boolean; localPort?: number }): Promise<void> { return runtimes.get(tabId)?.configure(id, values) ?? Promise.resolve() }
export function addPort(tabId: string, value: string): Promise<void> { return runtimes.get(tabId)?.add(value) ?? Promise.resolve() }
export function removePort(tabId: string, id: string): Promise<void> { return runtimes.get(tabId)?.remove(id) ?? Promise.resolve() }
export function disposePorts(id: string): Promise<void> {
  const runtime = runtimes.get(id)
  runtimes.delete(id)
  return runtime?.dispose() ?? Promise.resolve()
}
export async function setPortBindHost(host: PortBindHost): Promise<void> {
  await preferencesReady
  await savePortBindHost(host)
  portPreferences.host = host
  for (const runtime of runtimes.values()) for (const row of runtime.tab.ports.rows) if (row.enabled) void runtime.restart(row)
}
export function startPortsService(): void {
  stopWatch?.()
  stopWatch = watch(() => store.nodeConnected, connected => {
    if (!connected) for (const runtime of runtimes.values()) runtime.fail(new Error('Node 已断开，请连接后重试。'))
  })
}
export function stopPortsService(): void {
  stopWatch?.()
  stopWatch = undefined
  for (const id of runtimes.keys()) void disposePorts(id)
}
