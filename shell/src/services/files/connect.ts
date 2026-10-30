import { store } from '../../stores/app'
import { loadCredentialRecord } from '../vault'
import { copyConnection, type RemoteConnection } from '../proxy/types'
import { resolveHostConnection } from '../proxy/profiles'
import { NativeFileBackend } from './native-backend'
import type { FileBackend, FileEndpoint } from './types'

export async function connectFileEndpoint(endpoint: FileEndpoint, source?: RemoteConnection, signal?: AbortSignal): Promise<FileBackend> {
  let connection = source
  if (endpoint.kind === 'sftp' && !connection) {
    const host = store.hosts.find(host => host.id === endpoint.hostId)
    if (!host) throw new Error('远端主机配置不存在')
    const credential = await loadCredentialRecord(host.id)
    if (credential?.password === undefined) throw new Error('远端凭据不可用，请先连接终端')
    connection = await resolveHostConnection(host, credential.password)
  }
  const snapshot = connection ? copyConnection(connection) : undefined
  const open = async (signal?: AbortSignal): Promise<FileBackend> => {
    const backend = new NativeFileBackend(snapshot)
    backend.fork = open
    try { await backend.connect(signal); return backend }
    catch (error) { await backend.disconnect().catch(() => {}); throw error }
  }
  return open(signal)
}
