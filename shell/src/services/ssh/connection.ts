import { readKnownHost } from '../storage'
import type { RemoteConnection } from '../proxy/types'
import { SshWorkerClient } from './ssh-worker-client'

/** Owns an SSH Worker independently of terminal and panel lifetimes. */
export async function connectSsh(connection: RemoteConnection, signal: AbortSignal): Promise<{ worker: SshWorkerClient; close: () => Promise<void> }> {
  signal.throwIfAborted()
  const worker = new SshWorkerClient()
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
    return { worker, close }
  } catch (error) {
    worker.abort()
    await close()
    throw error
  }
}
