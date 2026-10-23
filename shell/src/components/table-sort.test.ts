import { describe, expect, it } from 'vitest'
import { nextColumnSort } from './table-sort'

describe('single column sorting', () => {
  it('cycles from default through ascending and descending back to default', () => {
    const ascending = nextColumnSort(null, 'size')
    expect(ascending).toEqual({ key: 'size', direction: 'asc' })
    const descending = nextColumnSort(ascending, 'size')
    expect(descending).toEqual({ key: 'size', direction: 'desc' })
    expect(nextColumnSort(descending, 'size')).toBeNull()
  })
  it('starts another column ascending without retaining a secondary sort', () => {
    expect(nextColumnSort({ key: 'cpu', direction: 'desc' }, 'pid')).toEqual({ key: 'pid', direction: 'asc' })
  })
})
