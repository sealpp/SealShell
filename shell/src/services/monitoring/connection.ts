import { readKnownHost } from '../storage'
import type { RemoteConnection } from '../proxy/types'
import { SshWorkerClient } from '../ssh/ssh-worker-client'

export type ExecResult = { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }
export interface MonitorConnection {
  exec(command: string): Promise<ExecResult>
  close(): Promise<void>
}

export async function connectMonitor(connection: RemoteConnection, signal: AbortSignal): Promise<MonitorConnection> {
  signal.throwIfAborted()
  const worker = new SshWorkerClient()
  // A monitor owns its Worker and transport. Cancelling an in-flight command
  // destroys that Worker rather than freeing a WASM session still in use.
  const abort = () => worker.abort()
  signal.addEventListener('abort', abort, { once: true })
  const close = async () => {
    try { await worker.close() }
    finally { signal.removeEventListener('abort', abort) }
  }
  try {
    const known = await readKnownHost(connection.host, connection.port)
    signal.throwIfAborted()
    const knownHostKey = known ? Uint8Array.from(atob(known.publicKey), c => c.charCodeAt(0)) : undefined
    await worker.connect({ ...connection, sessionId: crypto.randomUUID(), knownHostKey, shell: false })
    signal.throwIfAborted()
    return { exec: command => worker.exec(command), close }
  } catch (error) {
    await close()
    throw error
  }
}
