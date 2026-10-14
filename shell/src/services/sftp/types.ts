import type { FileBackend } from '../files/types'
import type { FileEntry } from '../../stores/app'

export const SFTP_RPC_VERSION = 1 as const
export type SftpRpcVersion = typeof SFTP_RPC_VERSION

export interface SftpConnectionOptions {
  sessionId: string
  host: string
  port: number
  username: string
  password: string
  defaultPath?: string
  knownHostKey?: ArrayBuffer
}

export interface SftpStat extends FileEntry {
  kind: FileEntry['kind']
}

export interface SftpDirectoryPage {
  path: string
  entries: FileEntry[]
  nextCursor?: string
}

export interface SftpBackend extends FileBackend {
  connect(options: SftpConnectionOptions): Promise<void>
  supports?(extension: string): boolean
}

export type SftpRequest =
  | { version: SftpRpcVersion; id: string; type: 'connect'; options: SftpConnectionOptions }
  | { version: SftpRpcVersion; id: string; type: 'disconnect' }
  | { version: SftpRpcVersion; id: string; type: 'list'; path: string; cursor?: string }
  | { version: SftpRpcVersion; id: string; type: 'stat'; path: string }
  | { version: SftpRpcVersion; id: string; type: 'read'; path: string; offset?: number; length?: number }
  | { version: SftpRpcVersion; id: string; type: 'write'; path: string; payload: ArrayBuffer; offset?: number }
  | { version: SftpRpcVersion; id: string; type: 'mkdir'; path: string }
  | { version: SftpRpcVersion; id: string; type: 'remove'; path: string; recursive?: boolean }
  | { version: SftpRpcVersion; id: string; type: 'rename'; source: string; target: string; overwrite?: boolean }
  | { version: SftpRpcVersion; id: string; type: 'chmod'; path: string; mode: number }
  | { version: SftpRpcVersion; id: string; type: 'utimes'; path: string; modifiedAt: number }
  | { version: SftpRpcVersion; id: string; type: 'readlink'; path: string }
  | { version: SftpRpcVersion; id: string; type: 'symlink'; target: string; path: string }
  | { version: SftpRpcVersion; id: string; type: 'cancel'; requestId: string }

export type SftpRequestInput = SftpRequest extends infer Request
  ? Request extends SftpRequest
    ? Omit<Request, 'version' | 'id'>
    : never
  : never

export type SftpResponse =
  | { version: SftpRpcVersion; id: string; ok: true; type: 'connected' | 'disconnected' | 'cancelled' | 'mkdir' | 'remove' | 'rename' | 'chmod' | 'utimes' | 'symlink'; result?: unknown }
  | { version: SftpRpcVersion; id: string; ok: true; type: 'list'; result: SftpDirectoryPage }
  | { version: SftpRpcVersion; id: string; ok: true; type: 'stat'; result: SftpStat }
  | { version: SftpRpcVersion; id: string; ok: true; type: 'read'; result: ArrayBuffer }
  | { version: SftpRpcVersion; id: string; ok: true; type: 'write'; result?: unknown }
  | { version: SftpRpcVersion; id: string; ok: true; type: 'readlink'; result: string }
  | { version: SftpRpcVersion; id: string; ok: false; error: { code: string; message: string } }

export interface SftpHostKeyEvent {
  version: SftpRpcVersion
  type: 'hostKey'
  publicKey: ArrayBuffer
  fingerprint: string
}
