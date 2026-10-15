import { beforeEach, expect, it, vi } from 'vitest'

const worker = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  exec: vi.fn(async (_command: string) => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 })),
  close: vi.fn(async () => undefined),
}))
vi.mock('./storage', () => ({ readKnownHost: async () => undefined }))
vi.mock('./ssh/ssh-worker-client', () => ({ SshWorkerClient: class {
  connect = worker.connect
  exec = worker.exec
  close = worker.close
} }))

import { closeExec, exec as runCommand } from './ssh'
import { closeProtection } from './close-protection'

const info = { sessionId: 'monitor', host: 'host', port: 22, username: 'user', password: '' }
const result = { stdout: new Uint8Array(), stderr: new Uint8Array(), exitCode: 0 }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

beforeEach(() => {
  worker.connect.mockReset().mockResolvedValue(undefined)
  worker.exec.mockReset().mockResolvedValue(result)
  worker.close.mockReset().mockResolvedValue(undefined)
  expect(closeProtection.blocked.value).toBe(false)
})

it('protects background work from connection start through async cleanup without a visible tab', async () => {
  const connecting = deferred<undefined>()
  const cleanup = deferred<undefined>()
  worker.connect.mockReturnValueOnce(connecting.promise)
  worker.close.mockReturnValueOnce(cleanup.promise)
  const operation = runCommand(info, 'sample')
  expect(closeProtection.blocked.value).toBe(true)
  connecting.resolve(undefined)
  await vi.waitFor(() => expect(worker.close).toHaveBeenCalledOnce())
  expect(closeProtection.blocked.value).toBe(true)
  cleanup.resolve(undefined)
  await operation
  expect(closeProtection.blocked.value).toBe(false)
})

it('keeps queued and in-flight monitoring protected when the owner closes its exec sessions', async () => {
  const first = deferred<typeof result>()
  const second = deferred<typeof result>()
  worker.exec.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const a = runCommand(info, 'first')
  const b = runCommand(info, 'second')
  expect(closeProtection.reasons.value).toEqual(['remote-command', 'remote-command'])
  await vi.waitFor(() => expect(worker.exec).toHaveBeenCalledTimes(1))
  await closeExec(info.sessionId)
  expect(closeProtection.blocked.value).toBe(true)
  first.resolve(result)
  await a
  expect(closeProtection.reasons.value).toEqual(['remote-command'])
  await vi.waitFor(() => expect(worker.exec).toHaveBeenCalledTimes(2))
  second.resolve(result)
  await b
  expect(closeProtection.blocked.value).toBe(false)
})

it.each(['connect', 'exec', 'close'] as const)('releases the protection when %s fails', async stage => {
  worker[stage].mockRejectedValueOnce(new Error('failed'))
  await expect(runCommand(info, 'sample')).rejects.toThrow('failed')
  expect(closeProtection.blocked.value).toBe(false)
})
