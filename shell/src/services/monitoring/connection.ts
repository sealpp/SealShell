import type { RemoteConnection } from '../proxy/types'
import { connectSsh } from '../ssh/connection'

export type ExecResult = { stdout: Uint8Array; stderr: Uint8Array; exitCode: number }
export interface MonitorConnection {
  exec(command: string, options?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<ExecResult>
  close(): Promise<void>
}

export async function connectMonitor(connection: RemoteConnection, signal: AbortSignal): Promise<MonitorConnection> {
  const { worker, close } = await connectSsh(connection, signal)
  return { exec: (command, options) => worker.exec(command, options), close }
}
