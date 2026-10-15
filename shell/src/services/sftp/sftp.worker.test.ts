import { afterEach, expect, it, vi } from 'vitest'
import type { SftpBackend } from './types'

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('finishes a session operation before starting metadata or disconnect requests', async () => {
  const responses: any[] = []
  vi.stubGlobal('postMessage', (response: unknown) => responses.push(response))
  vi.stubGlobal('onmessage', undefined)
  const { installSftpWorkerBackend } = await import('./sftp.worker')
  const order: string[] = []
  let finishRead!: (data: ArrayBuffer) => void
  installSftpWorkerBackend({
    read: async () => { order.push('read'); return new Promise<ArrayBuffer>(resolve => { finishRead = resolve }) },
    stat: async () => { order.push('stat'); return { path: '/file', size: 12 } },
    disconnect: async () => { order.push('disconnect') },
  } as unknown as SftpBackend)
  const receive = (globalThis as any).onmessage
  receive({ data: { version: 1, id: 'read', type: 'read', path: '/file' } })
  receive({ data: { version: 1, id: 'stat', type: 'stat', path: '/file' } })
  receive({ data: { version: 1, id: 'disconnect', type: 'disconnect' } })
  await vi.waitFor(() => expect(order).toEqual(['read']))
  finishRead(new ArrayBuffer(12))
  await vi.waitFor(() => expect(responses).toHaveLength(3))
  expect(order).toEqual(['read', 'stat', 'disconnect'])
  expect(responses.map(response => response.id)).toEqual(['read', 'stat', 'disconnect'])
})
