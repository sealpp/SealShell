import { describe, expect, it, vi } from 'vitest'
import { Libssh2Session } from './libssh2-runtime'

function fixture() {
  const session = new Libssh2Session()
  const module = {
    HEAPU8: new Uint8Array(4096),
    _malloc: vi.fn(() => 64),
    _free: vi.fn(),
    ssh2_sftp_open: vi.fn(() => 7),
    ssh2_sftp_read: vi.fn(() => 12),
    ssh2_sftp_write: vi.fn(() => 12),
    ssh2_sftp_seek64: vi.fn(),
    ssh2_sftp_close_handle: vi.fn().mockReturnValueOnce(-37).mockReturnValueOnce(-37).mockReturnValue(0),
    ssh2_session_last_errno: vi.fn(() => -6),
    ssh2_session_last_error: vi.fn(() => 'Timeout waiting for status message'),
  }
  Object.assign(session, { module, session: 1, sftp: 2 })
  vi.spyOn(session.transport, 'waitForData').mockResolvedValue()
  return { session, module }
}

describe('nonblocking SFTP handle lifetime', () => {
  it('finishes closing a read handle before returning its data', async () => {
    const { session, module } = fixture()
    expect((await session.readPath('/file', 0, 12)).byteLength).toBe(12)
    expect(module.ssh2_sftp_close_handle).toHaveBeenCalledTimes(3)
    expect(session.transport.waitForData).toHaveBeenCalledTimes(2)
  })

  it('finishes closing a written handle and frees the data buffer', async () => {
    const { session, module } = fixture()
    await session.writePath('/file', new ArrayBuffer(12))
    expect(module.ssh2_sftp_close_handle).toHaveBeenCalledTimes(3)
    expect(module._free).toHaveBeenCalledWith(64)
  })

  it('reports allocation failure accurately and frees buffers if close fails', async () => {
    const { session, module } = fixture()
    module.ssh2_sftp_close_handle.mockReset().mockReturnValue(-6)
    await expect(session.readPath('/file', 0, 12)).rejects.toThrow('-6: libssh2 memory allocation failed')
    expect(module._free).toHaveBeenCalledWith(64)
  })
})
