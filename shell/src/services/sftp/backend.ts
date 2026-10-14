import { posixPaths } from '../files/path'
import type { SftpBackend } from './types'

export function createUnavailableSftpBackend(): SftpBackend {
  const fail = async (): Promise<never> => {
    throw new Error('SFTP backend is not configured')
  }
  return {
    paths: posixPaths,    connect: fail,
    disconnect: async () => undefined,
    list: fail,
    stat: fail,
    read: fail,
    write: fail,
    mkdir: fail,
    remove: fail,
    rename: fail,
  }
}
