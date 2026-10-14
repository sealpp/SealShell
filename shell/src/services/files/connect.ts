import { store } from '../../stores/app'
import { loadCredentialRecord } from '../vault'
import { getRuntimePassword } from '../ssh'
import { SftpWorkerClient } from '../sftp/worker-client'
import { NodeFileBackend } from './node-backend'
import type { FileBackend, FileEndpoint } from './types'

export async function connectFileEndpoint(endpoint: FileEndpoint): Promise<FileBackend> {
  if (endpoint.kind === 'local') {
    const backend = new NodeFileBackend()
    await backend.connect()
    if (endpoint.nodeId && backend.nodeId !== endpoint.nodeId) {
      await backend.disconnect()
      throw new Error('本机 Node 身份已改变，请重新打开本地窗口')
    }
    backend.fork = () => connectFileEndpoint({ kind: 'local', nodeId: backend.nodeId })
    return backend
  }
  const host = store.hosts.find((host) => host.id === endpoint.hostId)
  if (!host) throw new Error('远端主机配置不存在')
  const credential = await loadCredentialRecord(host.id)
  const password = credential?.password ?? getRuntimePassword(host.address)
  if (password === undefined) throw new Error('远端凭据不可用，请先连接终端')
  // Keep the live session's credentials in this factory, so closing a terminal
  // or changing its profile does not invalidate file/editor/queued transfer work.
  const options = { host: host.address, port: host.port, username: host.username, password }
  const open = async (): Promise<FileBackend> => {
    const backend = new SftpWorkerClient()
    backend.fork = open
    try { await backend.connect({ ...options, sessionId: crypto.randomUUID() }) }
    catch (error) { await backend.disconnect().catch(() => undefined); throw error }
    return backend
  }
  return open()
}
