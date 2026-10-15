import { posixPaths } from '../files/path'
import { Libssh2Session } from '../ssh/libssh2-runtime'
import { joinRemotePath, normalizeRemotePath } from './path'
import type { FileEntry } from '../../stores/app'
import type { SftpBackend, SftpDirectoryPage, SftpStat } from './types'

export function createLibssh2SftpBackend(onHostKey: (publicKey: Uint8Array) => Promise<boolean>): SftpBackend {
  let session: Libssh2Session | undefined
  const backend: SftpBackend = {
    paths: posixPaths,
    async connect(next) {
      session = new Libssh2Session()
      await session.connect({
        host: next.host,
        port: next.port,
        username: next.username,
        password: next.password ?? '',
        proxy: next.proxy,
        onHostKey: async (key) => {
          if (next.knownHostKey) {
            const known = new Uint8Array(next.knownHostKey)
            if (known.length !== key.length || !known.every((value, index) => value === key[index])) {
              const error = new Error('remote host key does not match the saved fingerprint') as Error & { code?: string }
              error.code = 'HOST_KEY_MISMATCH'
              throw error
            }
            return true
          }
          return onHostKey(key)
        },
      })
      await session.initSftp()
    },
    async disconnect() { await session?.close(); session = undefined },
    async list(path): Promise<SftpDirectoryPage> {
      if (!session) throw new Error('SFTP session is unavailable')
      const entries = await session.listDirectory(normalizeRemotePath(path))
      return { path: normalizeRemotePath(path), entries: entries.map((entry): FileEntry => ({ ...entry, path: joinRemotePath(path, entry.name), hidden: entry.name.startsWith('.') })) }
    },
    async stat(path): Promise<SftpStat> {
      if (!session) throw new Error('SFTP session is unavailable')
      const result = await session.statPath(normalizeRemotePath(path))
      return { name: normalizeRemotePath(path).split('/').pop() || '/', path: normalizeRemotePath(path), ...result }
    },
    async read(path, offset, length) { if (!session) throw new Error('SFTP session is unavailable'); return session.readPath(normalizeRemotePath(path), offset, length) },
    async write(path, data, offset) { if (!session) throw new Error('SFTP session is unavailable'); await session.writePath(normalizeRemotePath(path), data, offset) },
    async openReader(path) { if (!session) throw new Error('SFTP session is unavailable'); return session.openReader(normalizeRemotePath(path)) },
    async openWriter(path) { if (!session) throw new Error('SFTP session is unavailable'); return session.openWriter(normalizeRemotePath(path)) },
    async mkdir(path) { if (!session) throw new Error('SFTP session is unavailable'); await session.mkdirPath(normalizeRemotePath(path)) },
    async remove(path, recursive) { if (!session) throw new Error('SFTP session is unavailable'); await session.removePath(normalizeRemotePath(path), recursive) },
    async rename(source, target, overwrite) { if (!session) throw new Error('SFTP session is unavailable'); return session.renamePath(normalizeRemotePath(source), normalizeRemotePath(target), overwrite) },
    async chmod(path, mode) { if (!session) throw new Error('SFTP session is unavailable'); await session.chmodPath(normalizeRemotePath(path), mode) },
    async utimes(path, modifiedAt) { if (!session) throw new Error('SFTP session is unavailable'); await session.utimesPath(normalizeRemotePath(path), modifiedAt) },
    async readlink(path) { if (!session) throw new Error('SFTP session is unavailable'); return session.readlinkPath(normalizeRemotePath(path)) },
    async symlink(target, path) { if (!session) throw new Error('SFTP session is unavailable'); await session.symlinkPath(target, normalizeRemotePath(path)) },
    supports(extension) { return session?.supports(extension) ?? false },
  }
  return backend
}
