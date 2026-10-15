import { expect, it, vi } from 'vitest'

const events = vi.hoisted(() => [] as string[])
vi.mock('./storage', () => ({ readKnownHost: async () => undefined }))
vi.mock('./ssh/ssh-worker-client', () => ({ SshWorkerClient: class {
  async connect() { events.push('shell opened') }
  send(data: Uint8Array) { events.push(new TextDecoder().decode(data)) }
  async close() {}
} }))

import { closeSsh, connectSsh, getSshSession } from './ssh'

it('opens the shell and restores its directory before publishing a usable online session', async () => {
  const info = { sessionId: 'restore-directory', host: 'host', port: 22, username: 'user', password: '' }
  await connectSsh(info, state => {
    events.push(state)
    if (state === 'online') expect(getSshSession(info.sessionId)).toMatchObject(info)
  }, () => undefined, '/work/project')
  expect(events.splice(0)).toEqual(['connecting', 'shell opened', " cd -- '/work/project'\r", 'online'])
  await closeSsh(info.sessionId)
})

it('keeps the login directory when the source directory is unknown', async () => {
  const info = { sessionId: 'default-directory', host: 'host', port: 22, username: 'user', password: '' }
  await connectSsh(info, state => events.push(state), () => undefined)
  expect(events.splice(0)).toEqual(['connecting', 'shell opened', 'online'])
  await closeSsh(info.sessionId)
})
