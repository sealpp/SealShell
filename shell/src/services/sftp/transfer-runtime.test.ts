import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferResult } from './transfer'

const result: TransferResult = { sourcePath: '/source', targetPath: '/target', bytes: 100, atomic: true, metadataApplied: true }

beforeEach(() => { vi.resetModules() })

async function controlledTransfer() {
  const runtime = await import('./transfer-runtime')
  let progress!: (bytes: number, total: number) => void
  let finish!: (result: TransferResult) => void
  let fail!: (error: Error) => void
  const task = runtime.enqueueTransfer('test transfer', (_signal, report) => {
    progress = report
    return new Promise<TransferResult>((resolve, reject) => { finish = resolve; fail = reject })
  })
  return { ...runtime, task, progress, finish, fail }
}

describe('transfer detail visibility', () => {
  it('keeps dismissed details closed during progress updates', async () => {
    const transfer = await controlledTransfer()
    transfer.transferRuntime.panelOpen = false
    try {
      transfer.progress(25, 100)
      expect(transfer.transferRuntime.tasks[0].progress).toBe(0.25)
      expect(transfer.transferRuntime.panelOpen).toBe(false)
      transfer.progress(75, 100)
      expect(transfer.transferRuntime.panelOpen).toBe(false)
    } finally {
      transfer.finish(result)
      await transfer.task.promise
    }
  })

  it('keeps explicitly opened details open when a transfer completes', async () => {
    const transfer = await controlledTransfer()
    transfer.transferRuntime.panelOpen = true
    transfer.finish(result)
    await transfer.task.promise
    await vi.waitFor(() => expect(transfer.transferRuntime.tasks[0].state).toBe('completed'))
    expect(transfer.transferRuntime.panelOpen).toBe(true)
  })

  it('records failures without reopening dismissed details', async () => {
    const transfer = await controlledTransfer()
    transfer.transferRuntime.panelOpen = false
    transfer.fail(new Error('connection lost'))
    await expect(transfer.task.promise).rejects.toThrow('connection lost')
    await vi.waitFor(() => expect(transfer.transferRuntime.tasks[0].state).toBe('failed'))
    expect(transfer.transferRuntime.panelOpen).toBe(false)
  })
})
