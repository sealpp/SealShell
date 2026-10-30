import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const events: string[] = []
  return {
    events,
    connect: vi.fn(async (_options: unknown) => { events.push('shell opened') }),
    resize: vi.fn(),
  }
})
vi.mock('./storage', () => ({ readKnownHost: async () => undefined }))
vi.mock('./ssh/client', () => ({ SshClient: class {
  connect = fixture.connect
  resize = fixture.resize
  send(data: Uint8Array) { fixture.events.push(new TextDecoder().decode(data)) }
  async close() {}
} }))

import { closeSsh, connectSsh, getSshSession, resize as resizeSsh } from './ssh'

const { events } = fixture

it('opens the shell and restores its directory before publishing a usable online session', async () => {
  const info = { sessionId: 'restore-directory', host: 'host', port: 22, username: 'user', password: '' }
  await connectSsh(info, state => {
    events.push(state)
    if (state === 'online') expect(getSshSession(info.sessionId)).toMatchObject(info)
  }, () => undefined, { columns: 123, rows: 41 }, '/work/project')
  expect(fixture.connect).toHaveBeenLastCalledWith(expect.objectContaining({ columns: 123, rows: 41, integrateShell: true }))
  expect(events.splice(0)).toEqual(['connecting', 'shell opened', " cd -- '/work/project'\r", 'online'])
  await closeSsh(info.sessionId)
})

it('keeps the login directory when the source directory is unknown', async () => {
  const info = { sessionId: 'default-directory', host: 'host', port: 22, username: 'user', password: '' }
  await connectSsh(info, state => events.push(state), () => undefined, { columns: 60, rows: 30 })
  expect(fixture.connect).toHaveBeenLastCalledWith(expect.objectContaining({ columns: 60, rows: 30 }))
  expect(events.splice(0)).toEqual(['connecting', 'shell opened', 'online'])
  await closeSsh(info.sessionId)
})

it('sends only sizes that differ from the initial PTY size or the last resize', async () => {
  fixture.resize.mockClear()
  const info = { sessionId: 'initial-size', host: 'host', port: 22, username: 'user', password: '' }
  await connectSsh(info, () => undefined, () => undefined, { columns: 123, rows: 41 })
  await resizeSsh(info.sessionId, 123, 41)
  expect(fixture.resize).not.toHaveBeenCalled()
  await resizeSsh(info.sessionId, 140, 41)
  await resizeSsh(info.sessionId, 140, 41)
  await resizeSsh(info.sessionId, 140, 50)
  expect(fixture.resize.mock.calls).toEqual([[140, 41], [140, 50]])
  await closeSsh(info.sessionId)
  events.splice(0)
})
