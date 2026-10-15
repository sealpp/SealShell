import type { BottomPanelCategory } from '../stores/app'

export interface WorkspaceGroupLayout {
  /** Logical group containing one or more parallel panes. */
  workspaceGroupId: string
  panelIds: readonly string[]
  bounds?: { left: number; top: number }
}

export interface WorkspaceInstanceLayout {
  tabId: string
  marker: string
}

export function workspaceSplitMarker(index: number, count: number): string {
  if (count <= 1 || index < 0 || index >= count) return ''
  if (index === 0) return '┌'
  if (index === count - 1) return '└'
  return '├'
}

export function arrangeWorkspaceInstances(
  tabIds: readonly string[],
  groups: readonly WorkspaceGroupLayout[],
): WorkspaceInstanceLayout[] {
  const knownIds = new Set(tabIds)
  const tabOrder = new Map(tabIds.map((id, index) => [id, index]))
  const logicalGroups = new Map<string, Array<{ group: WorkspaceGroupLayout; index: number }>>()
  groups.forEach((group, index) => {
    const panelIds = group.panelIds.filter((id) => knownIds.has(id))
    if (!panelIds.length) return
    const panes = logicalGroups.get(group.workspaceGroupId) ?? []
    panes.push({ group: { ...group, panelIds }, index })
    logicalGroups.set(group.workspaceGroupId, panes)
  })

  const sortedPanes = (panes: Array<{ group: WorkspaceGroupLayout; index: number }>) => panes.slice().sort((left, right) => {
    if (!left.group.bounds && !right.group.bounds) return left.index - right.index
    if (!left.group.bounds) return 1
    if (!right.group.bounds) return -1
    return left.group.bounds.top - right.group.bounds.top
      || left.group.bounds.left - right.group.bounds.left
      || left.index - right.index
  })

  const arrangedGroups = Array.from(logicalGroups.entries()).sort((left, right) => {
    const leftFirst = Math.min(...left[1].flatMap(({ group }) => group.panelIds.map((id) => tabOrder.get(id) ?? Number.MAX_SAFE_INTEGER)))
    const rightFirst = Math.min(...right[1].flatMap(({ group }) => group.panelIds.map((id) => tabOrder.get(id) ?? Number.MAX_SAFE_INTEGER)))
    return leftFirst - rightFirst
  })
  const result: WorkspaceInstanceLayout[] = []
  const placedIds = new Set<string>()
  for (const [, panes] of arrangedGroups) {
    const arrangedPanes = sortedPanes(panes)
    const markerCount = arrangedPanes.length
    arrangedPanes.forEach(({ group: pane }, paneIndex) => {
      const marker = markerCount > 1
        ? workspaceSplitMarker(paneIndex, markerCount)
        : ''
      pane.panelIds.forEach((tabId) => {
        if (placedIds.has(tabId)) return
        placedIds.add(tabId)
        result.push({ tabId, marker })
      })
    })
  }
  for (const tabId of tabIds) {
    if (!placedIds.has(tabId)) result.push({ tabId, marker: '' })
  }
  return result
}

export function canDropWorkspaceInstance(source: BottomPanelCategory, target: BottomPanelCategory): boolean {
  return source === target
}
