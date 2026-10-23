import { expect, it } from 'vitest'
import { processViewRows } from './view-model'
import type { ProcessRow } from './types'
const row = (pid: number, ppid: number, name: string): ProcessRow => ({
  key: String(pid), pid, ppid, name, command: name, user: 'user', uid: 1000, state: 'S',
  rss: 0, threads: 1, startTicks: pid, startedAt: 0, cpuTicks: 0, cpu: null,
})
it('retains ancestors of search matches without selecting or mutating descendants', () => {
  const rows = [row(10, 1, 'parent'), row(11, 10, 'match'), row(12, 10, 'other')]
  const result = processViewRows(rows, 'match', true)
  expect(result.map(item => item.pid)).toEqual([10])
  expect(result[0].children?.map(item => item.pid)).toEqual([11])
  expect(rows[0]).not.toHaveProperty('children')
  expect(processViewRows(rows, 'match', false).map(item => item.pid)).toEqual([11])
})
it('keeps orphaned processes and breaks cycles instead of hiding or infinitely nesting them', () => {
  const rows = [row(10, 11, 'a'), row(11, 10, 'b'), row(12, 99, 'orphan')]
  expect(processViewRows(rows, '', true).map(item => item.pid)).toEqual([10, 11, 12])
})
