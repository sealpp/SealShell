import { watch } from 'vue'
import { store, type MetricValue, type Tab, type Telemetry } from '../stores/app'
import { closeExec, exec } from './ws'

const POLL_INTERVAL_MS = 2000
const LINUX_PROBE_COMMAND = 'uname -s'
const LINUX_SAMPLE_COMMAND = [
  "printf '__SEAL_CPU__\\n'; cat /proc/stat",
  "printf '__SEAL_MEM__\\n'; free -b",
  "printf '__SEAL_DISK__\\n'; df -P -k /",
  "printf '__SEAL_PROCS__\\n'; ps -eo pid",
].join('; ')

type CpuSample = {
  total: number
  idle: number
}

type SectionName = 'CPU' | 'MEM' | 'DISK' | 'PROCS'

const decoder = new TextDecoder('utf-8', { fatal: false })

function metric(value: number | string | null, unit: string): MetricValue {
  const valid = typeof value === 'number' ? Number.isFinite(value) : value !== null
  return {
    value: valid ? value : null,
    unit,
    quality: valid ? 'valid' : 'missing',
  }
}

function parseSections(text: string): Record<SectionName, string> {
  const sections = {} as Record<SectionName, string>
  let current: SectionName | null = null

  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^__SEAL_(CPU|MEM|DISK|PROCS)__$/)
    if (marker) {
      current = marker[1] as SectionName
      sections[current] = ''
    } else if (current) {
      sections[current] += `${line}\n`
    }
  }

  return sections
}

function parseCpu(text: string, previous: CpuSample | null): { value: number | null; sample: CpuSample | null } {
  const match = text.match(/^cpu\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m)
  if (!match) return { value: null, sample: null }

  const user = Number(match[1])
  const nice = Number(match[2])
  const system = Number(match[3])
  const idle = Number(match[4])
  const sample = { total: user + nice + system + idle, idle }

  if (previous === null) {
    return {
      value: sample.total === 0 ? 0 : 100 - (sample.idle / sample.total) * 100,
      sample,
    }
  }

  const deltaTotal = sample.total - previous.total
  const deltaIdle = sample.idle - previous.idle
  return {
    value: deltaTotal === 0 ? 0 : 100 - (deltaIdle / deltaTotal) * 100,
    sample,
  }
}

function parseMemory(text: string): number | null {
  const match = text.match(/Mem:\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/)
  if (!match) return null
  const total = Number(match[1])
  const available = Number(match[2])
  return total === 0 ? 0 : ((total - available) / total) * 100
}

function parseDisk(text: string): number | null {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return null
  const parts = lines[lines.length - 1].trim().split(/\s+/)
  if (parts.length < 5) return null
  const used = Number(parts[2])
  const available = Number(parts[3])
  const total = used + available
  return total === 0 ? 0 : (used / total) * 100
}

function parseProcessCount(text: string): number | null {
  const lines = text.trim().split(/\r?\n/)
  if (!text.trim() || lines.length === 0) return null
  return Math.max(0, lines.length - 1)
}

class LinuxTelemetryProvider {
  private lastCpu: CpuSample | null = null

  async probe(sessionId: string): Promise<boolean> {
    const result = await exec(sessionId, LINUX_PROBE_COMMAND)
    return result.exitCode === 0 && decoder.decode(result.stdout).trim() === 'Linux'
  }

  async sample(sessionId: string): Promise<Telemetry> {
    const result = await exec(sessionId, LINUX_SAMPLE_COMMAND)
    const output = decoder.decode(result.stdout)
    const sections = parseSections(output)
    const cpu = parseCpu(sections.CPU ?? '', this.lastCpu)
    this.lastCpu = cpu.sample

    return {
      sampledAt: Date.now(),
      metrics: {
        'cpu.usage': metric(cpu.value, 'percent'),
        'memory.usage': metric(parseMemory(sections.MEM ?? ''), 'percent'),
        'disk.usage': metric(parseDisk(sections.DISK ?? ''), 'percent'),
        'process.count': metric(parseProcessCount(sections.PROCS ?? ''), 'count'),
      },
    }
  }
}

type TelemetrySession = {
  provider: LinuxTelemetryProvider
  supported: boolean | undefined
}

let stopWatch: (() => void) | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
const telemetrySessions = new Map<string, TelemetrySession>()

function activeTab(): Tab | undefined {
  return store.tabs.find((tab) => tab.id === store.activeTerminalTabId)
}

function canPoll(sessionId: string): boolean {
  const tab = activeTab()
  return store.nodeConnected && store.view === 'shell' && store.panelOpen && tab?.kind === 'terminal' && tab.state === 'online' && tab.sessionId === sessionId
}

function stopPolling(): void {
  generation += 1
  if (timer) {
    clearTimeout(timer)
    timer = undefined
  }
  store.telemetry = null
}

function clearActiveTelemetry(): void {
  const tab = activeTab()
  if (tab) tab.telemetry = null
  store.telemetry = null
}

function pruneTelemetrySessions(): void {
  const activeSessions = new Set(store.tabs.map((tab) => tab.sessionId))
  for (const sessionId of telemetrySessions.keys()) {
    if (!activeSessions.has(sessionId)) telemetrySessions.delete(sessionId)
  }
}

function telemetrySession(sessionId: string): TelemetrySession {
  let session = telemetrySessions.get(sessionId)
  if (!session) {
    session = {
      provider: new LinuxTelemetryProvider(),
      supported: undefined,
    }
    telemetrySessions.set(sessionId, session)
  }
  return session
}

async function poll(sessionId: string, currentGeneration: number): Promise<void> {
  if (currentGeneration !== generation || !canPoll(sessionId)) return

  const session = telemetrySession(sessionId)
  try {
    if (session.supported === false) {
      clearActiveTelemetry()
      return
    }
    if (session.supported === undefined) {
      session.supported = await session.provider.probe(sessionId)
      if (!session.supported) {
        await closeExec(sessionId)
        if (currentGeneration === generation) clearActiveTelemetry()
        return
      }
      if (currentGeneration !== generation || !canPoll(sessionId)) return
    }
    const telemetry = await session.provider.sample(sessionId)
    if (currentGeneration !== generation || !canPoll(sessionId)) return
    const tab = activeTab()
    if (tab) { tab.telemetry = telemetry; tab.telemetryError = '' }
    store.telemetry = telemetry
  } catch (error) {
    telemetrySessions.delete(sessionId)
    if (currentGeneration === generation) {
      clearActiveTelemetry()
      const tab = activeTab()
      if (tab) tab.telemetryError = error instanceof Error ? error.message : String(error)
    }
    if (error instanceof Error && error.message.includes('PROXY_ERROR')) return
  }

  if (currentGeneration === generation && canPoll(sessionId)) {
    timer = setTimeout(() => void poll(sessionId, currentGeneration), POLL_INTERVAL_MS)
  }
}

function reconcile(): void {
  stopPolling()
  pruneTelemetrySessions()
  const tab = activeTab()
  if (!tab || !canPoll(tab.sessionId)) return
  tab.telemetryError = ''

  const currentGeneration = generation
  void poll(tab.sessionId, currentGeneration)
}

export function startTelemetryService(): void {
  if (stopWatch) return
  stopWatch = watch(
    [
      () => store.nodeConnected,
      () => store.view,
      () => store.panelOpen,
      () => store.activeTerminalTabId,
      () => activeTab()?.sessionId,
      () => activeTab()?.state,
    ],
    reconcile,
    { immediate: true },
  )
}

export function stopTelemetryService(): void {
  stopPolling()
  stopWatch?.()
  stopWatch = undefined
}
