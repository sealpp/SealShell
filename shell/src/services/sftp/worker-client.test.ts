import { describe, expect, it, vi } from 'vitest'
import { SftpWorkerClient } from './worker-client'

vi.mock('../storage', () => ({ readKnownHost: vi.fn(async () => undefined), saveKnownHost: vi.fn() }))

function fixture() {
  const messages: any[] = []
  const worker = { onmessage: null as any, onerror: null as any, postMessage: vi.fn((message: unknown) => messages.push(message)), terminate: vi.fn() }
  const client = new SftpWorkerClient(worker as unknown as Worker)
  const reply = (request: any, type: string, result?: unknown) => worker.onmessage({ data: { version: 1, id: request.id, ok: true, type, result } })
  return { client, worker, messages, reply }
}
const options = { sessionId: 'test', host: 'host', port: 22, username: 'user', password: 'test' }

describe('SFTP worker ownership', () => {
  it('terminates the worker and rejects a stalled read when its transfer is cancelled', async () => {
    const { client, worker, messages, reply } = fixture()
    const controller = new AbortController()
    const connecting = client.connect(options, controller.signal)
    await vi.waitFor(() => expect(messages[0]?.type).toBe('connect'))
    reply(messages[0], 'connected')
    await connecting
    const read = client.read('/file', 0, 1024)
    const rejected = expect(read).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await rejected
    await client.disconnect()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(messages.map(message => message.type)).toEqual(['connect', 'read'])
    expect(worker.onmessage).toBeNull()
  })

  it('waits for graceful disconnect but never waits for a crashed worker', async () => {
    const { client, worker, messages, reply } = fixture()
    const closing = client.disconnect()
    expect(worker.terminate).not.toHaveBeenCalled()
    reply(messages[0], 'disconnected')
    await closing
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    const crashed = fixture()
    const read = crashed.client.read('/file')
    const rejected = expect(read).rejects.toThrow('crashed')
    crashed.worker.onerror({ message: 'crashed' })
    await rejected
    await crashed.client.disconnect()
    expect(crashed.messages).toHaveLength(1)
    expect(crashed.worker.terminate).toHaveBeenCalledTimes(1)
  })
})
