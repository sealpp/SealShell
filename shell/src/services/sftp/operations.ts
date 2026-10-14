import { isVisibleFileEntry, sortFileEntries } from './sort'
import type { FileEntry, FileSortDirection, FileSortKey } from '../../stores/app'
import { statIfExists, type FileBackend, type FileDirectoryPage } from '../files/types'
import { assertNotCancelled, commitTemporary, temporarySibling, TransferOrphanError, type TransferOptions } from './transfer'
import { transferFile, type TransferResult } from './transfer'

export async function listDirectory(
  backend: FileBackend,
  path: string,
  options: { showHidden?: boolean; sortKey?: FileSortKey; sortDirection?: FileSortDirection } = {},
): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  let cursor: string | undefined
  do {
    const page: FileDirectoryPage = await backend.list(backend.paths.normalize(path), cursor)
    entries.push(...page.entries.map((entry) => ({ ...entry, temporary: entry.temporary || entry.name.startsWith('.sealshell-') })))
    cursor = page.nextCursor
  } while (cursor)
  const visible = entries.filter((entry) => isVisibleFileEntry(entry, options.showHidden ?? false))
  return sortFileEntries(visible, options.sortKey ?? 'name', options.sortDirection ?? 'asc')
}

export async function copyEntry(
  source: FileBackend, target: FileBackend, sourcePath: string, targetPath: string,
  signal?: AbortSignal, onProgress?: TransferOptions['onProgress'], knownEntry?: FileEntry,
): Promise<TransferResult[]> {
  assertNotCancelled(signal)
  if (source.namespace && source.namespace === target.namespace
    && (source.paths.equal(sourcePath, targetPath) || source.paths.descendant(targetPath, sourcePath) || source.paths.descendant(sourcePath, targetPath))) {
    throw new Error('不能将项目复制到自身或其子目录')
  }
  const info = knownEntry ?? await source.stat(sourcePath)
  if (info.kind === 'file') return [await transferFile(source, target, sourcePath, targetPath, { signal, onProgress })]
  if (info.kind !== 'directory' && info.kind !== 'symlink') throw new Error('不支持复制此文件类型')
  const temporary = temporarySibling(target, targetPath)
  let created = false
  try {
    let results: TransferResult[] = []
    if (info.kind === 'directory') {
      await target.mkdir(temporary)
      created = true
      const entries = await listDirectory(source, sourcePath, { showHidden: true })
      for (let index = 0; index < entries.length; index++) {
        const child = entries[index]
        assertNotCancelled(signal)
        results.push(...await copyEntry(source, target, child.path, target.paths.join(temporary, child.name), signal, undefined, child))
        onProgress?.(index + 1, entries.length)
      }
    } else {
      if (!source.readlink || !target.symlink) throw new Error('目标不支持符号链接')
      await target.symlink(await source.readlink(sourcePath), temporary)
      created = true
    }
    assertNotCancelled(signal)
    const commit = await commitTemporary(target, temporary, targetPath)
    results = [{ sourcePath, targetPath, bytes: results.reduce((total, result) => total + result.bytes, 0), ...commit, metadataApplied: false }]
    return results
  } catch (error) {
    if (created && await statIfExists(target, temporary)) {
      try { await target.remove(temporary, true) }
      catch { throw new TransferOrphanError(temporary, error) }
    }
    throw error
  }
}
