import { expect, it } from 'vitest'
import { SshWorkerClient } from './ssh-worker-client'

function workerFixture() {
  const events: any[] = []
  let terminated = false
  const worker = {
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
    onerror: undefined as ((event: { message: string }) => void) | undefined,
    postMessage(value: unknown) { events.push(value) },
    terminate() { terminated = true },
  }
  return { worker, events, get terminated() { return terminated }, client: new SshWorkerClient(worker as unknown as Worker) }
}

it('sends the close request and waits for resource cleanup before terminating the worker', async () => {
  const fixture = workerFixture()
  const closing = fixture.client.close()
  expect(fixture.events).toEqual([{ type: 'close' }])
  expect(fixture.terminated).toBe(false)
  fixture.worker.onmessage!({ data: { type: 'closed' } })
  await closing
  expect(fixture.terminated).toBe(true)
})

it('rejects a pending connect when the worker acknowledges closure', async () => {
  const fixture = workerFixture()
  const connecting = fixture.client.connect({ sessionId: 'session', host: 'host', port: 22, username: 'user', password: '' })
  const rejected = expect(connecting).rejects.toThrow('closed')
  const closing = fixture.client.close()
  fixture.worker.onmessage!({ data: { type: 'closed' } })
  await closing
  await rejected
})

it('does not wait for a reply from a worker that already crashed', async () => {
  const fixture = workerFixture()
  fixture.worker.onerror!({ message: 'Worker failed to load' })
  await fixture.client.close()
  expect(fixture.terminated).toBe(true)
  expect(fixture.events).toEqual([])
})

it('cancels a pending authentication without waiting for the server', async () => {
  const fixture = workerFixture()
  const connecting = fixture.client.connect({ sessionId: 'monitor', host: 'host', port: 22, username: 'user', password: '', shell: false })
  const rejected = expect(connecting).rejects.toThrow('cancelled')
  fixture.client.abort()
  await rejected
  await fixture.client.close()
  expect(fixture.terminated).toBe(true)
})

it('rejects in-flight and subsequent commands when its owner cancels the connection', async () => {
  const fixture = workerFixture()
  const pending = fixture.client.exec('sleep 100')
  const rejected = expect(pending).rejects.toThrow('cancelled')
  fixture.client.abort()
  await rejected
  await expect(fixture.client.exec('uname -s')).rejects.toThrow('closed')
  expect(fixture.terminated).toBe(true)
})
