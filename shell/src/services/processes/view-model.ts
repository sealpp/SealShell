import type { ProcessRow } from './types'
export interface ProcessTreeRow extends ProcessRow { children?: ProcessTreeRow[] }

export function processViewRows(rows: ProcessRow[], query: string, tree: boolean): ProcessTreeRow[] {
  const text = query.trim().toLocaleLowerCase()
  const matches = (row: ProcessRow) => !text || [row.pid, row.ppid, row.user, row.name, row.command].some(value => String(value).toLocaleLowerCase().includes(text))
  if (!tree) return rows.filter(matches)
  const byPid = new Map(rows.map(row => [row.pid, row]))
  const included = new Set<number>()
  for (const row of rows) {
    if (!matches(row)) continue
    let current: ProcessRow | undefined = row
    while (current && !included.has(current.pid)) { included.add(current.pid); current = byPid.get(current.ppid) }
  }
  const nodes = new Map(rows.filter(row => included.has(row.pid)).map(row => [row.pid, { ...row, children: [] } as ProcessTreeRow]))
  const roots: ProcessTreeRow[] = []
  for (const row of nodes.values()) {
    let ancestor = nodes.get(row.ppid)
    const visited = new Set([row.pid])
    while (ancestor && !visited.has(ancestor.pid)) { visited.add(ancestor.pid); ancestor = nodes.get(ancestor.ppid) }
    const parent = ancestor ? undefined : nodes.get(row.ppid)
    if (parent) parent.children!.push(row)
    else roots.push(row)
  }
  return roots
}
export const outcomeLabels = { sent: '已发送信号', gone: '进程已退出', changed: '身份已变化，已跳过', denied: '权限不足', failed: '操作失败或未收到确认' }
export const processStateLabels: Record<string, string> = { R: '运行', S: '睡眠', D: '不可中断', Z: '僵尸', T: '已暂停', t: '跟踪停止', I: '空闲', X: '已退出' }
