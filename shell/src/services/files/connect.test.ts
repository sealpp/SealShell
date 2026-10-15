import { expect, it, vi } from 'vitest'
const attempts = vi.hoisted(() => [] as any[])
vi.mock('../sftp/worker-client', () => ({ SftpWorkerClient: class {
  fork?: () => Promise<unknown>
  async connect(options: unknown) { attempts.push(options) }
  async disconnect() {}
} }))
vi.mock('../vault', () => ({ loadCredentialRecord: vi.fn() }))
import { connectFileEndpoint } from './connect'
import { store } from '../../stores/app'
import type { RemoteConnection } from '../proxy/types'

it('forks file/editor/queued transfer connections from the captured route even after the host is removed', async () => {
  const source: RemoteConnection = { host: 'internal', port: 22, username: 'root', password: 'ssh-secret', proxy: { type: 'http', host: 'old-proxy', port: 8080, authentication: 'password', username: 'user', password: 'proxy-secret' } }
  const backend = await connectFileEndpoint({ kind: 'sftp', hostId: 'deleted-host' }, source)
  source.proxy!.host = 'changed-proxy'
  source.proxy!.password = 'changed-secret'
  store.hosts = []
  await backend.disconnect()
  const derived = await backend.fork!()
  await derived.disconnect()
  expect(attempts).toHaveLength(2)
  for (const options of attempts) expect(options).toMatchObject({ host: 'internal', password: 'ssh-secret', proxy: { host: 'old-proxy', password: 'proxy-secret' } })
  expect(attempts[0].sessionId).not.toBe(attempts[1].sessionId)
})
