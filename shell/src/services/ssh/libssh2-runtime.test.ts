import { describe, expect, it, vi } from 'vitest'
import { Libssh2Session } from './libssh2-runtime'

function fixture() {
  const session = new Libssh2Session()
  const module = {
    HEAPU8: new Uint8Array(1024 * 1024),
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
  it('reuses one file handle and buffer for sequential reads without discarding read-ahead', async () => {
    const { session, module } = fixture()
    const reader = await session.openReader('/file')
    await reader.read(0, 256 * 1024)
    await reader.read(12, 256 * 1024)
    await reader.read(24, 256 * 1024)
    expect(module.ssh2_sftp_open).toHaveBeenCalledTimes(1)
    expect(module.ssh2_sftp_seek64).not.toHaveBeenCalled()
    expect(module.ssh2_sftp_close_handle).not.toHaveBeenCalled()
    await reader.read(2 ** 32 + 12, 12)
    expect(module.ssh2_sftp_seek64).toHaveBeenCalledWith(7, BigInt(2 ** 32 + 12))
    await reader.close()
    await reader.close()
    expect(module.ssh2_sftp_close_handle).toHaveBeenCalledTimes(3)
  })

  it('bounds read buffers even if the caller requests an entire large file', async () => {
    const { session, module } = fixture()
    const reader = await session.openReader('/file')
    await reader.read(0, 2 ** 30)
    expect(module.ssh2_sftp_read).toHaveBeenCalledWith(7, 64, 256 * 1024)
    await reader.close()
  })

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
