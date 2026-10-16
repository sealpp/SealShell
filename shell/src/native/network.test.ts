import { describe, expect, it, vi } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { SealMessageSchema, TransportCreditSchema, TransportDataSchema, TransportEofEventSchema } from './proto/seal_pb'
import type { NativeConnection } from './connection'
import { NativeStream } from './network'

describe('native byte streams without application dependencies', () => {
  it('grants receive credit on consumption and preserves data before EOF', async () => {
    const connection = { send: vi.fn() } as unknown as NativeConnection
    const stream = new NativeStream(connection, 3, 'tcp', 10)
    stream.receive(create(SealMessageSchema, { body: { case: 'transportData', value: create(TransportDataSchema, { streamId: 3, payload: Uint8Array.of(1, 2) }) } }))
    stream.receive(create(SealMessageSchema, { body: { case: 'transportEofEvent', value: create(TransportEofEventSchema, { streamId: 3 }) } }))
    expect(connection.send).not.toHaveBeenCalled()
    expect(await stream.read()).toEqual(Uint8Array.of(1, 2))
    expect(connection.send).toHaveBeenCalledOnce()
    expect(await stream.read()).toBeNull()
  })

  it('orders EOF after acknowledged writes and rejects blocked writes on disconnect', async () => {
    const connection = { send: vi.fn() } as unknown as NativeConnection
    const stream = new NativeStream(connection, 3, 'tcp', 10)
    const write = stream.write(Uint8Array.of(1, 2))
    const end = stream.end()
    await Promise.resolve()
    expect(connection.send).toHaveBeenCalledOnce()
    stream.receive(create(SealMessageSchema, { body: { case: 'transportCredit', value: create(TransportCreditSchema, { streamId: 3, direction: 'input', addBytes: 2n }) } }))
    await write
    await end
    expect(vi.mocked(connection.send).mock.calls[1][0].case).toBe('transportHalfCloseRequest')
    const blocked = new NativeStream(connection, 4, 'tcp', 0)
    const failed = blocked.write(Uint8Array.of(1))
    blocked.finish(new Error('disconnected'))
    await expect(failed).rejects.toThrow('disconnected')
  })
})
