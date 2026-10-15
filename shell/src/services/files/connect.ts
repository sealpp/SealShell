import { store } from '../../stores/app'
import { loadCredentialRecord } from '../vault'
import { copyConnection, type RemoteConnection } from '../proxy/types'
import { resolveHostConnection } from '../proxy/profiles'
import { SftpWorkerClient } from '../sftp/worker-client'
import { NodeFileBackend } from './node-backend'
import { FileOperationError, type FileBackend, type FileEndpoint } from './types'

export async function connectFileEndpoint(endpoint: FileEndpoint, source?: RemoteConnection, signal?: AbortSignal): Promise<FileBackend> {
  if (endpoint.kind === 'local') {
    const backend = new NodeFileBackend()
    try { await backend.connect(signal) }
    catch (error) { await backend.disconnect(); throw error }
    if (endpoint.nodeId && backend.nodeId !== endpoint.nodeId) {
      await backend.disconnect()
      throw new Error('本机 Node 身份已改变，请重新打开本地窗口')
    }
    const nodeId = backend.nodeId
    backend.fork = (signal) => connectFileEndpoint({ kind: 'local', nodeId }, undefined, signal)
    return backend
  }
  let connection = source
  if (!connection) {
    const host = store.hosts.find((host) => host.id === endpoint.hostId)
    if (!host) throw new Error('远端主机配置不存在')
    const credential = await loadCredentialRecord(host.id)
    if (credential?.password === undefined) throw new Error('远端凭据不可用，请先连接终端')
    connection = await resolveHostConnection(host, credential.password)
  }
  // Keep the live session's credentials in this factory, so closing a terminal
  // or changing its profile does not invalidate file/editor/queued transfer work.
  const options = copyConnection(connection)
  const open = async (signal?: AbortSignal): Promise<FileBackend> => {
    const backend = new SftpWorkerClient()
    backend.fork = open
    try { await backend.connect({ ...options, sessionId: crypto.randomUUID() }, signal) }
    catch (error) {
      await backend.disconnect().catch(() => undefined)
      if (error instanceof FileOperationError && error.code === 'PROXY_ERROR') throw new FileOperationError(error.code, error.message, options.proxySource)
      throw error
    }
    return backend
  }
  return open(signal)
}
