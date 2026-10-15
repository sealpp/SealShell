import { watch } from 'vue'
import { store, type Tab } from '../stores/app'
import { closeExec, exec } from './ws'
import { LinuxTelemetryProvider } from './monitoring/metrics'

const POLL_INTERVAL_MS = 2000

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
      provider: new LinuxTelemetryProvider(command => exec(sessionId, command)),
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
      session.supported = await session.provider.probe()
      if (!session.supported) {
        await closeExec(sessionId)
        if (currentGeneration === generation) clearActiveTelemetry()
        return
      }
      if (currentGeneration !== generation || !canPoll(sessionId)) return
    }
    const telemetry = await session.provider.sample()
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
