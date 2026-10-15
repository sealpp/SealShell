import { watch } from 'vue'
import { setBottomPanelActiveTab, store, type MonitorTab } from '../../stores/app'
import { loadCredentialRecord } from '../vault'
import { hostProxySource, resolveHostConnection } from '../proxy/profiles'
import { copyHostProxy, type RemoteConnection } from '../proxy/types'
import { closeProtection } from '../close-protection'
import { connectMonitor, type MonitorConnection } from './connection'
import { LinuxTelemetryProvider } from './metrics'

const INTERVAL_MS = 2000
const runtimes = new Map<string, MonitorRuntime>()
let stopNodeWatch: (() => void) | undefined

class MonitorRuntime {
  private controller?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private connection?: MonitorConnection
  private credentials?: string
  private readonly snapshot: Promise<RemoteConnection>

  constructor(private readonly tab: MonitorTab, snapshot: Promise<RemoteConnection>, private readonly savedPassword: Promise<string | undefined>) {
    this.snapshot = snapshot
    // Retain a failed snapshot for the panel's retry without an unhandled rejection.
    void snapshot.catch(() => undefined)
    void savedPassword.catch(() => undefined)
  }

  async start(password?: string): Promise<void> {
    this.stop()
    const controller = new AbortController()
    this.controller = controller
    const current = () => this.controller === controller && !controller.signal.aborted
    this.tab.state = 'connecting'
    this.tab.error = ''
    this.tab.monitor.telemetry = null
    this.tab.monitor.needsPassword = false
    this.tab.monitor.unsupported = false
    const release = closeProtection.acquire('monitor-connection')
    try {
      const snapshot = await this.snapshot
      if (!current()) return
      if (password !== undefined) this.credentials = password
      if (this.credentials === undefined) this.credentials = await this.savedPassword
      if (!current()) return
      if (this.credentials === undefined) {
        this.tab.state = 'idle'
        this.tab.monitor.needsPassword = true
        return
      }
      if (!store.nodeConnected) throw new Error('Node 未连接，请连接 Node 后重试。')
      const connection = await connectMonitor({ ...snapshot, password: this.credentials }, controller.signal)
      if (!current()) { await connection.close(); return }
      this.connection = connection
      const provider = new LinuxTelemetryProvider(command => connection.exec(command))
      if (!await provider.probe()) {
        if (current()) {
          this.tab.monitor.unsupported = true
          this.tab.state = 'idle'
          this.connection = undefined
        }
        await connection.close()
        return
      }
      if (!current()) return
      this.tab.state = 'online'
      const sample = async () => {
        if (!current()) return
        try {
          const telemetry = await provider.sample()
          if (!current()) return
          this.tab.monitor.telemetry = telemetry
          this.timer = setTimeout(() => void sample(), INTERVAL_MS)
        } catch (error) {
          if (current()) this.fail(error)
        }
      }
      await sample()
    } catch (error) {
      if (current()) this.fail(error)
    } finally {
      release()
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
    const connection = this.connection
    this.connection = undefined
    if (connection) void connection.close()
  }

  fail(error: unknown): void {
    this.stop()
    this.tab.monitor.telemetry = null
    this.tab.error = error instanceof Error ? error.message : String(error)
    this.tab.monitor.needsPassword = /AUTHENTICATION_FAILED|authentication|permission denied/i.test(this.tab.error)
    this.tab.state = 'error'
  }
}

export function openMonitor(hostId: string): MonitorTab | undefined {
  const existing = store.tabs.find((tab): tab is MonitorTab => tab.kind === 'monitor' && tab.hostId === hostId)
  if (existing) { reveal(existing); return existing }
  const host = store.hosts.find(host => host.id === hostId)
  if (!host) return undefined
  const profile = { ...host, proxy: host.proxy ? copyHostProxy(host.proxy) : undefined }
  // Resolve and copy the route before any asynchronous credential lookup.
  const snapshot = resolveHostConnection(profile, '')
  const savedPassword = loadCredentialRecord(hostId).then(record => record?.password)
  const tab: MonitorTab = {
    id: crypto.randomUUID(), kind: 'monitor', hostId, label: profile.name,
    proxySource: hostProxySource(profile), state: 'connecting', error: '',
    sessionId: '', terminalId: '', encoding: 'utf-8', telemetry: null,
    monitor: { address: profile.address, port: profile.port, username: profile.username, telemetry: null, needsPassword: false, unsupported: false },
  }
  store.tabs.push(tab)
  const reactiveTab = store.tabs.find(item => item.id === tab.id) as MonitorTab
  // Register synchronously: repeated opens also deduplicate pending authentication.
  const runtime = new MonitorRuntime(reactiveTab, snapshot, savedPassword)
  runtimes.set(tab.id, runtime)
  reveal(reactiveTab)
  void runtime.start()
  return reactiveTab
}

function reveal(tab: MonitorTab): void {
  setBottomPanelActiveTab(tab.id, 'monitors')
  store.bottomPanelOpen = true
  store.view = 'shell'
}

export function retryMonitor(tabId: string, password?: string): Promise<void> {
  return runtimes.get(tabId)?.start(password) ?? Promise.resolve()
}

export function disposeMonitor(tabId: string): void {
  runtimes.get(tabId)?.stop()
  runtimes.delete(tabId)
}

export function startMonitoringService(): void {
  stopNodeWatch?.()
  stopNodeWatch = watch(() => store.nodeConnected, connected => {
    if (!connected) for (const runtime of runtimes.values()) runtime.fail(new Error('Node 已断开，请连接 Node 后重试。'))
  })
}

export function stopMonitoringService(): void {
  stopNodeWatch?.()
  stopNodeWatch = undefined
  for (const tabId of runtimes.keys()) disposeMonitor(tabId)
}
