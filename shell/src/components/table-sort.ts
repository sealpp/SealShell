export type SortDirection = 'asc' | 'desc'
export interface ColumnSort<Key extends string = string> { key: Key; direction: SortDirection }

/** Every column uses the same single-column cycle, independent of its data type. */
export function nextColumnSort<Key extends string>(current: ColumnSort<Key> | null, key: Key): ColumnSort<Key> | null {
  if (current?.key !== key) return { key, direction: 'asc' }
  return current.direction === 'asc' ? { key, direction: 'desc' } : null
}
