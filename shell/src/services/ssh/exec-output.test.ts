import { expect, it, vi } from 'vitest'
import { Libssh2Session } from './libssh2-runtime'

function fixture() {
  const session = new Libssh2Session()
  const module = {
    HEAPU8: new Uint8Array(1000), _malloc: () => 64, _free: vi.fn(),
    ssh2_channel_open_session: () => 7, ssh2_channel_exec: () => 0,
    ssh2_channel_eof: () => 1, ssh2_channel_get_exit_status: () => 3,
    ssh2_channel_close: vi.fn().mockReturnValueOnce(-37).mockReturnValue(0),
    ssh2_channel_free: vi.fn().mockReturnValueOnce(-37).mockReturnValue(0),
  }
  let count = 0
  Object.assign(session, { module, session: 1, readChannelNow: () => count++ < 2 ? new Uint8Array([1, 2, 3]) : new Uint8Array() })
  vi.spyOn(session.transport, 'waitForData').mockResolvedValue()
  return { session, module }
}
it('bounds combined output and finishes nonblocking channel cleanup on failure', async () => {
  const { session, module } = fixture()
  await expect(session.exec('sample', 5)).rejects.toThrow('大小限制')
  expect(module.ssh2_channel_close).toHaveBeenCalledTimes(2)
  expect(module.ssh2_channel_free).toHaveBeenCalledTimes(2)
  expect(module._free).toHaveBeenCalledWith(64)
})
it('returns separate byte streams and the real exit code', async () => {
  const { session } = fixture()
  const result = await session.exec('sample', 6)
  expect(result).toEqual({ stdout: new Uint8Array([1, 2, 3]), stderr: new Uint8Array([1, 2, 3]), exitCode: 3 })
})
