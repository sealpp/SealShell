import type { FileEntry, FileSortDirection, FileSortKey } from '../../stores/app'
import { filePresentation } from '../files/file-type'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function compareFileEntries(left: FileEntry, right: FileEntry, key: FileSortKey, direction: FileSortDirection, leftType: string, rightType: string): number {
  const directoryOrder = Number(right.kind === 'directory') - Number(left.kind === 'directory')
  if (directoryOrder) return directoryOrder
  let result = 0
  if (key === 'name') result = collator.compare(left.name, right.name)
  else if (key === 'modified') result = left.modifiedAt - right.modifiedAt || collator.compare(left.name, right.name)
  else if (key === 'size') result = left.size - right.size || collator.compare(left.name, right.name)
  else result = collator.compare(leftType, rightType) || collator.compare(left.name, right.name)
  return direction === 'asc' ? result : -result
}

export function sortFileEntries(entries: readonly FileEntry[], key: FileSortKey, direction: FileSortDirection): FileEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, type: key === 'type' ? filePresentation(entry).typeLabel : '' }))
    .sort((a, b) => compareFileEntries(a.entry, b.entry, key, direction, a.type, b.type) || a.index - b.index)
    .map(({ entry }) => entry)
}

export function isVisibleFileEntry(entry: FileEntry, showHidden: boolean): boolean {
  if (entry.temporary) return false
  return showHidden || !entry.hidden && !entry.name.startsWith('.')
}
