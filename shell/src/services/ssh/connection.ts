import type { RemoteConnection } from '../proxy/types'
import { SshClient } from './client'

/** Owns an SSH connection independently of terminal and panel lifetimes. */
export async function connectSsh(connection: RemoteConnection, signal: AbortSignal): Promise<{ worker: SshClient; close: () => Promise<void> }> {
  signal.throwIfAborted()
  const worker = new SshClient()
  const abort = () => worker.abort()
  signal.addEventListener('abort', abort, { once: true })
  const close = async () => {
    try { await worker.close() }
    finally { signal.removeEventListener('abort', abort) }
  }
  try {
    signal.throwIfAborted()
    await worker.connect({ ...connection, sessionId: crypto.randomUUID(), shell: false })
    signal.throwIfAborted()
    return { worker, close }
  } catch (error) {
    worker.abort()
    await close()
    throw error
  }
}
