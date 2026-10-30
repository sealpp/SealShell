import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TransferResult } from './transfer'

const result: TransferResult = { sourcePath: '/source', targetPath: '/target', bytes: 100, atomic: true, metadataApplied: true }

beforeEach(() => { vi.resetModules() })

async function controlledTransfer() {
  const runtime = await import('./transfer-runtime')
  const { installNativeAdapter } = await import('../../native/bridge')
  const handlers = new Set<(event: any) => void>()
  let snapshot: any
  let finish!: (value: TransferResult) => void
  let fail!: (error: Error) => void
  const emit = () => handlers.forEach(handler => handler({ type: 'transfer', task: { ...snapshot } }))
  installNativeAdapter({
    subscribe: async handler => { handlers.add(handler); return () => { handlers.delete(handler) } },
    call: async <T>(operation: string, args: Record<string, unknown>): Promise<T> => {
      if (operation === 'transfer_list') return [] as T
      if (operation === 'transfer_enqueue') { snapshot = { id: args.id, label: args.label, state: 'running', progress: 0 }; emit() }
      if (operation === 'transfer_wait') return new Promise<T>((resolve, reject) => {
        finish = result => { snapshot = { ...snapshot, state: 'completed', result, progress: 1 }; emit(); resolve(result as T) }
        fail = error => { snapshot = { ...snapshot, state: 'failed', error: error.message }; emit(); reject(error) }
      })
      return undefined as T
    },
  })
  const promise = runtime.enqueueTransfer('test transfer', { sourceId: 'a', targetId: 'b', directory: '/', paths: ['/file'], moveFiles: false })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const progress = (bytes: number, total: number) => { snapshot.progress = bytes / total; emit() }
  return { ...runtime, task: { promise }, progress, finish, fail }
}

describe('transfer detail visibility', () => {
  it('starts background transfers without opening details', async () => {
    const transfer = await controlledTransfer()
    try {
      expect(transfer.transferRuntime.tasks[0].state).toBe('running')
      expect(transfer.transferRuntime.panelOpen).toBe(false)
    } finally {
      transfer.finish(result)
      await transfer.task.promise
    }
  })

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
