import type { FileEntry } from '../../stores/app'
import type { FilePaths } from './path'

export type FileEndpoint = { kind: 'local'; nodeId: string } | { kind: 'sftp'; hostId: string }
export interface FileDirectoryPage { path: string; entries: FileEntry[]; nextCursor?: string }
export interface FileReader { read(offset: number, length: number): Promise<ArrayBuffer>; close(): Promise<void> }
export interface FileWriter { write(offset: number, data: ArrayBuffer): Promise<void>; close(): Promise<void> }

export interface FileBackend {
  readonly paths: FilePaths
  namespace?: string
  atomicReplace?: boolean
  disconnect(): Promise<void>
  list(path: string, cursor?: string): Promise<FileDirectoryPage>
  stat(path: string, followLinks?: boolean): Promise<FileEntry>
  read(path: string, offset?: number, length?: number): Promise<ArrayBuffer>
  write(path: string, data: ArrayBuffer, offset?: number): Promise<void>
  openReader?(path: string): Promise<FileReader>
  openWriter?(path: string): Promise<FileWriter>
  mkdir(path: string): Promise<void>
  remove(path: string, recursive?: boolean): Promise<void>
  rename(source: string, target: string, overwrite?: boolean): Promise<{ atomic: boolean }>
  chmod?(path: string, mode: number): Promise<void>
  utimes?(path: string, modifiedAt: number): Promise<void>
  readlink?(path: string): Promise<string>
  symlink?(target: string, path: string): Promise<void>
}

export class FileOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export async function statIfExists(backend: FileBackend, path: string): Promise<FileEntry | undefined> {
  try { return await backend.stat(path) }
  catch (error) {
    if (error instanceof FileOperationError && error.code === 'not_found') return undefined
    throw error
  }
}
