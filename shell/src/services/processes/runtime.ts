import { markRaw, watch } from 'vue'
import { setBottomPanelActiveTab, store, type ProcessesTab } from '../../stores/app'
import { loadCredentialRecord } from '../vault'
import { copyHostProxy, type RemoteConnection } from '../proxy/types'
import { hostProxySource, resolveHostConnection } from '../proxy/profiles'
import { connectMonitor, type MonitorConnection } from '../monitoring/connection'
import { closeProtection } from '../close-protection'
import { LinuxProcessProvider, processTargets } from './provider'
import type { ProcessPlan, ProcessScope, ProcessSignal, ProcessSnapshot } from './types'

const runtimes = new Map<string, ProcessRuntime>()
let stopNodeWatch: (() => void) | undefined
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

class ProcessRuntime {
  private controller?: AbortController
  private connection?: MonitorConnection
  private provider?: LinuxProcessProvider
  private timer?: ReturnType<typeof setTimeout>
  private queue: Promise<unknown> = Promise.resolve()
  private visible = false
  private polling = false
  private generation = 0
  private password?: string
  private snapshot?: ProcessSnapshot
  private readonly removeWatch: () => void

  constructor(readonly tab: ProcessesTab, private readonly config: Promise<RemoteConnection>, private readonly credential: Promise<string | undefined>) {
    void config.catch(() => undefined)
    void credential.catch(() => undefined)
    this.removeWatch = watch(() => [store.bottomPanelOpen, store.bottomPanelCategory, tab.processes.paused], () => this.reconcile())
  }

  private active(): boolean {
    return this.visible && store.bottomPanelOpen && store.bottomPanelCategory === 'processes' && !this.tab.processes.paused
  }
  private current(generation: number): boolean { return generation === this.generation && !!this.controller && !this.controller.signal.aborted }
  setVisible(visible: boolean): void { this.visible = visible; this.reconcile() }
  private clearTimer(): void { clearTimeout(this.timer); this.timer = undefined }
  private reconcile(): void {
    this.clearTimer()
    const active = this.active()
    if (active !== this.polling) { this.provider?.resetBaseline(); this.polling = active }
    if (!active) return
    if (this.provider && this.tab.state === 'online' && !this.tab.processes.busy && !this.tab.processes.loading) void this.refresh()
  }
  private schedule(): void {
    this.clearTimer()
    if (this.active() && this.provider && !this.tab.processes.busy) this.timer = setTimeout(() => void this.refresh(), 2000)
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const generation = this.generation
    const task = this.queue.then(() => {
      if (!this.current(generation)) throw new Error('进程连接已关闭或重建')
      return operation()
    })
    this.queue = task.catch(() => undefined)
    return task
  }
  async start(password?: string): Promise<void> {
    this.stop()
    const generation = this.generation
    this.controller = new AbortController()
    const controller = this.controller
    const state = this.tab.processes
    this.tab.state = 'connecting'; this.tab.error = ''
    state.rows = []; state.needsPassword = false; state.unsupported = false
    state.actionError = ''; state.outcomes = []
    const release = closeProtection.acquire('process-connection')
    try {
      const config = await this.config
      if (!this.current(generation)) return
      if (password !== undefined) this.password = password
      if (this.password === undefined) this.password = await this.credential
      if (!this.current(generation)) return
      if (this.password === undefined) { state.needsPassword = true; this.tab.state = 'idle'; return }
      if (!store.nodeConnected) throw new Error('Node 未连接')
      const connection = await connectMonitor({ ...config, password: this.password }, controller.signal)
      if (!this.current(generation)) { await connection.close(); return }
      this.connection = connection
      const probe = await connection.exec('uname -s', { timeoutMs: 10000, maxOutputBytes: 1024 })
      if (!this.current(generation)) return
      if (probe.exitCode !== 0 || new TextDecoder().decode(probe.stdout).trim() !== 'Linux') {
        state.unsupported = true; this.stop(); this.tab.state = 'idle'; return
      }
      this.provider = new LinuxProcessProvider(connection)
      this.tab.state = 'online'
      this.reconcile()
    } catch (error) {
      if (!this.current(generation)) return
      this.fail(error)
      state.needsPassword = !this.tab.error.includes('PROXY_ERROR') && /AUTHENTICATION_FAILED|authentication/i.test(this.tab.error)
    } finally { release() }
  }
  private async sample(): Promise<ProcessSnapshot> {
    const generation = this.generation
    if (!this.provider) throw new Error('进程连接不可用')
    const snapshot = await this.provider.sample()
    if (!this.current(generation)) throw new Error('进程连接已关闭')
    this.snapshot = snapshot
    this.tab.processes.rows = markRaw(snapshot.rows)
    this.tab.processes.sampledAt = Date.now()
    return snapshot
  }
  async refresh(): Promise<void> {
    if (!this.provider || this.tab.processes.loading || this.tab.processes.busy) return
    const generation = this.generation
    this.clearTimer(); this.tab.processes.loading = true
    try { await this.serial(() => this.sample()) }
    catch (error) { if (this.current(generation)) this.fail(error) }
    finally { if (this.current(generation)) { this.tab.processes.loading = false; this.schedule() } }
  }
  async prepare(keys: string[], signal: ProcessSignal, scope: ProcessScope): Promise<ProcessPlan | undefined> {
    if (!this.provider || this.tab.processes.busy) return
    const generation = this.generation
    this.tab.processes.busy = true; this.tab.processes.actionError = ''; this.clearTimer()
    try {
      const snapshot = await this.serial(() => this.sample())
      return { generation, signal, scope, bootId: snapshot.bootId, targets: processTargets(snapshot.rows, keys, scope) }
    } catch (error) {
      if (this.current(generation)) { this.tab.processes.actionError = errorMessage(error); this.finishPlan() }
    }
  }
  finishPlan(): void { this.tab.processes.busy = false; this.schedule() }
  async execute(plan: ProcessPlan): Promise<void> {
    if (!this.current(plan.generation) || !this.provider || plan.bootId !== this.snapshot?.bootId) {
      this.tab.processes.actionError = '连接或主机身份已变化，请重新确认'; this.finishPlan(); return
    }
    const release = closeProtection.acquire('process-operation')
    try {
      const outcomes = await this.serial(() => this.provider!.signal(plan.bootId, plan.targets, plan.signal))
      if (!this.current(plan.generation)) return
      this.tab.processes.outcomes = outcomes
      await this.serial(() => this.sample())
    } catch (error) { if (this.current(plan.generation)) this.tab.processes.actionError = errorMessage(error) }
    finally { release(); if (this.current(plan.generation)) this.finishPlan() }
  }
  stop(): void {
    this.generation++
    this.clearTimer()
    this.controller?.abort(); this.controller = undefined
    const connection = this.connection
    this.connection = undefined; this.provider = undefined; this.snapshot = undefined
    this.queue = Promise.resolve()
    this.tab.processes.loading = false; this.tab.processes.busy = false
    if (connection) void connection.close()
  }
  fail(error: unknown): void {
    this.stop(); this.tab.state = 'error'; this.tab.error = errorMessage(error)
    this.tab.processes.rows = []
  }
  dispose(): void { this.removeWatch(); this.stop() }
}

export function openProcesses(hostId: string): ProcessesTab | undefined {
  const existing = store.tabs.find((tab): tab is ProcessesTab => tab.kind === 'process' && tab.hostId === hostId)
  if (existing) { reveal(existing); return existing }
  const host = store.hosts.find(host => host.id === hostId)
  if (!host) return
  const profile = { ...host, proxy: host.proxy ? copyHostProxy(host.proxy) : undefined }
  const config = resolveHostConnection(profile, '')
  const credential = loadCredentialRecord(hostId).then(record => record?.password)
  const tab: ProcessesTab = {
    id: crypto.randomUUID(), kind: 'process', hostId, label: host.name, proxySource: hostProxySource(profile),
    state: 'connecting', error: '', sessionId: '', terminalId: '', encoding: 'utf-8',
    processes: { address: host.address, port: host.port, username: host.username, needsPassword: false, unsupported: false, loading: false, busy: false, paused: false, rows: [], sampledAt: null, actionError: '', outcomes: [] },
  }
  store.tabs.push(tab)
  const reactiveTab = store.tabs.find(item => item.id === tab.id) as ProcessesTab
  const runtime = new ProcessRuntime(reactiveTab, config, credential)
  runtimes.set(tab.id, runtime)
  reveal(reactiveTab); void runtime.start()
  return reactiveTab
}
function reveal(tab: ProcessesTab): void { setBottomPanelActiveTab(tab.id, 'processes'); store.bottomPanelOpen = true; store.view = 'shell' }
export function setProcessVisible(id: string, visible: boolean): void { runtimes.get(id)?.setVisible(visible) }
export function refreshProcesses(id: string): Promise<void> { return runtimes.get(id)?.refresh() ?? Promise.resolve() }
export function retryProcesses(id: string, password?: string): Promise<void> { return runtimes.get(id)?.start(password) ?? Promise.resolve() }
export function prepareProcessAction(id: string, keys: string[], signal: ProcessSignal, scope: ProcessScope): Promise<ProcessPlan | undefined> { return runtimes.get(id)?.prepare(keys, signal, scope) ?? Promise.resolve(undefined) }
export function cancelProcessAction(id: string): void { runtimes.get(id)?.finishPlan() }
export function executeProcessAction(id: string, plan: ProcessPlan): Promise<void> { return runtimes.get(id)?.execute(plan) ?? Promise.resolve() }
export function disposeProcesses(id: string): void { runtimes.get(id)?.dispose(); runtimes.delete(id) }
export function startProcessesService(): void {
  stopNodeWatch?.()
  stopNodeWatch = watch(() => store.nodeConnected, connected => { if (!connected) for (const runtime of runtimes.values()) runtime.fail(new Error('Node 已断开，请重新连接')) })
}
export function stopProcessesService(): void { stopNodeWatch?.(); stopNodeWatch = undefined; for (const id of runtimes.keys()) disposeProcesses(id) }
