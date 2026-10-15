import { expect, it, vi } from 'vitest'
import { TransferCancelledError, TransferQueue, type TransferResult } from './transfer'

const result: TransferResult = { sourcePath: '/source', targetPath: '/target', bytes: 1, atomic: true, metadataApplied: true }

it('does not remove another active task when a completed record is dismissed before finalization', async () => {
  const queue = new TransferQueue(2)
  const first = queue.enqueue('first', async () => result)
  const second = queue.enqueue('second', signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new TransferCancelledError()), { once: true })
  }))
  await first.promise.then(() => queue.dismiss(first.id))
  await vi.waitFor(() => expect(queue.list()).toHaveLength(1))
  const rejected = expect(second.promise).rejects.toBeInstanceOf(TransferCancelledError)
  expect(queue.cancel(second.id)).toBe(true)
  await rejected
})

it('releases retry context when a cancelled queued record is dismissed', async () => {
  const queue = new TransferQueue(1)
  let finish!: (result: TransferResult) => void
  const first = queue.enqueue('running', () => new Promise(resolve => { finish = resolve }))
  const run = vi.fn(async () => result)
  const queued = queue.enqueue('queued', run)
  const rejected = expect(queued.promise).rejects.toBeInstanceOf(TransferCancelledError)
  expect(queue.cancel(queued.id)).toBe(true)
  await rejected
  expect(queue.dismiss(queued.id)).toBe(true)
  expect(queue.retry(queued.id)).toBe(false)
  expect(queue.list().some(task => task.id === queued.id)).toBe(false)
  finish(result)
  await first.promise
  expect(run).not.toHaveBeenCalled()
})

it('preserves an uncleaned temporary path on a cancelled task', async () => {
  const queue = new TransferQueue()
  const task = queue.enqueue('cancelled', async () => { throw new TransferCancelledError('/target/.sealshell-temp') })
  await expect(task.promise).rejects.toBeInstanceOf(TransferCancelledError)
  await vi.waitFor(() => expect(queue.list()[0]).toMatchObject({ state: 'cancelled', orphanPath: '/target/.sealshell-temp' }))
})

it('does not hide a retained file when a later retry succeeds', async () => {
  const queue = new TransferQueue()
  let attempt = 0
  const task = queue.enqueue('retry', async () => {
    if (attempt++ === 0) throw new TransferCancelledError('/target/.sealshell-temp')
    return result
  })
  await expect(task.promise).rejects.toBeInstanceOf(TransferCancelledError)
  await vi.waitFor(() => expect(queue.list()[0].state).toBe('cancelled'))
  expect(queue.retry(task.id)).toBe(true)
  await vi.waitFor(() => expect(queue.list()[0]).toMatchObject({ state: 'completed', orphanPath: '/target/.sealshell-temp' }))
})
