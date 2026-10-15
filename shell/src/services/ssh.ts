import { randomId } from '../utils/id'
import { readKnownHost } from './storage'
import { SshWorkerClient } from './ssh/ssh-worker-client'
import { copyConnection, type RemoteConnection } from './proxy/types'
import { initialDirectoryCommand } from './terminalDirectory'

export interface SshConnectionInfo extends RemoteConnection {
  sessionId: string
}

type OutputHandler = (payload: Uint8Array) => void
type StateHandler = (state: 'connecting' | 'online' | 'error' | 'idle', error?: string) => void

interface ActiveSession {
  info: SshConnectionInfo
  worker: SshWorkerClient
}

const sessions = new Map<string, ActiveSession>()
const execLocks = new Map<string, Promise<void>>()

async function connectWorker(info: SshConnectionInfo, onState: StateHandler, onOutput: OutputHandler, integrateShell = false): Promise<ActiveSession> {
  const known = await readKnownHost(info.host, info.port)
  const knownHostKey = known ? base64ToBytes(known.publicKey) : undefined
  const worker = new SshWorkerClient()
  // Publish online only after connectSsh has registered the usable session.
  // Telemetry watches this state and may immediately request an exec channel.
  worker.onState = (state, error) => { if (state !== 'online') onState(state, error) }
  worker.onOutput = onOutput
  try {
    await worker.connect({ ...info, knownHostKey, integrateShell })
    const active = { info: { ...copyConnection(info), sessionId: info.sessionId }, worker }
    sessions.set(info.sessionId, active)
    return active
  } catch (error) {
    await worker.close()
    throw error
  }
}

export async function connectSsh(info: SshConnectionInfo, onState: StateHandler, onOutput: OutputHandler, initialCwd?: string): Promise<SshConnectionInfo> {
  onState('connecting')
  const active = await connectWorker(info, onState, onOutput, true)
  const command = initialDirectoryCommand(initialCwd)
  if (command) active.worker.send(new TextEncoder().encode(command))
  onState('online')
  return { ...info }
}

export function sendInput(sessionId: string, payload: Uint8Array): Promise<void> {
  const active = sessions.get(sessionId)
  if (!active) return Promise.reject(new Error('SSH session is unavailable'))
  try {
    active.worker.send(payload)
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

export async function resize(sessionId: string, columns: number, rows: number): Promise<void> {
  sessions.get(sessionId)?.worker.resize(columns, rows)
}

async function releaseSession(sessionId: string): Promise<void> {
  const active = sessions.get(sessionId)
  if (!active) return
  sessions.delete(sessionId)
  await active.worker.close()
}

export async function closeSsh(sessionId: string): Promise<void> {
  await releaseSession(sessionId)
  await closeExec(sessionId)
}

export async function closeExec(sessionId: string): Promise<void> {
  for (const key of Array.from(sessions.keys())) {
    if (key.startsWith(`exec-${sessionId}-`)) await releaseSession(key)
  }
  execLocks.delete(sessionId)
}

export async function exec(info: SshConnectionInfo, command: string): Promise<{ stdout: Uint8Array; stderr: Uint8Array; exitCode: number }> {
  const previous = execLocks.get(info.sessionId) ?? Promise.resolve()
  const task = previous.then(async () => {
    const sessionId = `exec-${info.sessionId}-${randomId()}`
    const active = await connectWorker({ ...info, sessionId }, () => undefined, () => undefined)
    try {
      return await active.worker.exec(command)
    } finally {
      await releaseSession(sessionId)
    }
  })
  const lock = task.then(() => undefined, () => undefined)
  execLocks.set(info.sessionId, lock)
  try {
    return await task
  } finally {
    if (execLocks.get(info.sessionId) === lock) execLocks.delete(info.sessionId)
  }
}

export function getSshSession(sessionId: string): SshConnectionInfo | undefined {
  return sessions.get(sessionId)?.info
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const result = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index)
  return result
}
