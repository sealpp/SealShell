import { isVisibleFileEntry, sortFileEntries } from './sort'
import type { FileEntry, FileSortDirection, FileSortKey } from '../../stores/app'
import type { FileBackend, FileDirectoryPage } from '../files/types'

export async function listDirectory(
  backend: FileBackend,
  path: string,
  options: { showHidden?: boolean; sortKey?: FileSortKey | null; sortDirection?: FileSortDirection } = {},
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
