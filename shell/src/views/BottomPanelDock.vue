<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { DockviewVue, themeAbyss } from 'dockview-vue'
import type { DockviewApi, DockviewPanelApi, DockviewReadyEvent } from 'dockview-vue'
import { IconFile, IconFolder, IconX } from '@tabler/icons-vue'
import { store, setBottomPanelActiveTab, type Tab, type BottomPanelCategory } from '../stores/app'
import { commandService } from '../services/commands'
import { arrangeWorkspaceInstances, canDropWorkspaceInstance } from '../services/workspace-docking'
import FilePanel from './FilePanel.vue'
import EditorPanel from './EditorPanel.vue'

const props = defineProps<{ category: BottomPanelCategory }>()
type PanelMoveGroup = NonNullable<Parameters<DockviewPanelApi['moveTo']>[0]['group']>
type ActivatablePanel = { readonly id: string; readonly api: { setActive(): void } }
type ActivePanelApi = { getPanel(id: string): ActivatablePanel | undefined; readonly activePanel?: ActivatablePanel }
type WorkspaceGroupSize = { width: number; height: number }
// Dockview defaults groups to 100px minimums; panes in this panel must flex
// in either axis so Sizing.Distribute can divide the available space.
const workspacePaneConstraints = { minimumWidth: 0, minimumHeight: 0 } as const
const edgeDropDirections = { left: 'left', right: 'right', top: 'above', bottom: 'below' } as const

const api = shallowRef<DockviewApi | null>(null)
const layoutVersion = ref(0)
const draggingId = ref('')
const activeWorkspaceGroupId = ref('')
// Dockview groups are panes. A logical workspace group can own several panes
// after an edge split, while an un-split instance keeps its own group.
const panelWorkspaceGroups = new Map<string, string>()
const dockWorkspaceGroups = new Map<string, string>()
const workspaceGroupSizes = new Map<string, WorkspaceGroupSize>()
let activeWorkspaceDrag: { tabId: string; category: BottomPanelCategory } | undefined
let subscriptions: Array<{ dispose: () => void }> = []
let syncingPanels = false
let activationToken = 0
let pendingActivation: { tabId: string; token: number } | undefined

const components = {
  file: FilePanel,
  editor: EditorPanel,
}

const tabs = computed(() => store.tabs.filter((tab): tab is Tab & { kind: 'file' | 'editor' } => tab.kind === props.category.slice(0, -1)))

function newWorkspaceGroupId(tabId: string): string {
  return `${props.category}:${tabId}`
}

function ensurePanelWorkspaceGroup(tabId: string): string {
  const existing = panelWorkspaceGroups.get(tabId)
  if (existing) return existing
  const created = newWorkspaceGroupId(tabId)
  panelWorkspaceGroups.set(tabId, created)
  return created
}

function syncDockWorkspaceGroups(currentApi: DockviewApi): void {
  const knownPanelIds = new Set(tabs.value.map((tab) => tab.id))
  for (const tabId of Array.from(panelWorkspaceGroups.keys())) {
    if (!knownPanelIds.has(tabId)) panelWorkspaceGroups.delete(tabId)
  }

  const knownDockIds = new Set<string>()
  for (const group of currentApi.groups) {
    knownDockIds.add(group.id)
    let workspaceGroupId = dockWorkspaceGroups.get(group.id)
    if (!workspaceGroupId) {
      const firstPanel = group.panels[0]
      workspaceGroupId = firstPanel ? ensurePanelWorkspaceGroup(firstPanel.id) : `${props.category}:${group.id}`
      dockWorkspaceGroups.set(group.id, workspaceGroupId)
    }
    for (const panel of group.panels) {
      if (!panelWorkspaceGroups.has(panel.id)) panelWorkspaceGroups.set(panel.id, workspaceGroupId)
    }
  }
  for (const groupId of Array.from(dockWorkspaceGroups.keys())) {
    if (!knownDockIds.has(groupId)) dockWorkspaceGroups.delete(groupId)
  }
  for (const groupId of Array.from(workspaceGroupSizes.keys())) {
    if (!knownDockIds.has(groupId)) workspaceGroupSizes.delete(groupId)
  }
}

function workspaceGroupForPanel(panelId: string): string | undefined {
  const panel = api.value?.getPanel(panelId)
  if (panel) {
    const groupId = dockWorkspaceGroups.get(panel.group.id)
    if (groupId) return groupId
  }
  return panelWorkspaceGroups.get(panelId)
}

function setCategoryActiveTab(tabId: string): void {
  if (props.category === 'files') store.activeFileTabId = tabId
  else store.activeEditorTabId = tabId
}

function captureVisibleGroupSizes(currentApi: DockviewApi): Map<string, WorkspaceGroupSize> {
  const snapshot = new Map<string, WorkspaceGroupSize>()
  for (const group of currentApi.groups) {
    if (!group.api.isVisible) continue
    const bounds = group.api.boundingBox
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue
    const size = { width: bounds.width, height: bounds.height }
    snapshot.set(group.id, size)
    workspaceGroupSizes.set(group.id, size)
  }
  return snapshot
}

function restoreGroupSizes(currentApi: DockviewApi, snapshot: Map<string, WorkspaceGroupSize>): void {
  for (const group of currentApi.groups) {
    if (!group.api.isVisible) continue
    const size = snapshot.get(group.id) ?? workspaceGroupSizes.get(group.id)
    if (!size) continue
    const bounds = group.api.boundingBox
    // Hidden category docks report zero-sized bounds. Applying a cached
    // visible size while hidden causes Dockview to emit layout changes
    // forever because the parent cannot accept that size until shown again.
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue
    if (Math.abs(bounds.width - size.width) > 1 || Math.abs(bounds.height - size.height) > 1) {
      group.api.setSize(size)
    }
  }
}

function schedulePanelActivation(tabId: string): void {
  const currentApi = api.value
  if (!currentApi) return

  const token = ++activationToken
  pendingActivation = { tabId, token }
  const activate = (): void => {
    if (pendingActivation?.token !== token) return
    const panel = currentApi.getPanel(tabId)
    if (!panel) {
      pendingActivation = undefined
      return
    }
    panel.api.setActive()
    setCategoryActiveTab(panel.id)
  }

  // Visibility changes can make Dockview select the first panel while it is
  // recalculating the grid. Re-apply the requested panel after those layout
  // passes so a clicked tab remains the actual active content.
  activate()
  requestAnimationFrame(() => {
    activate()
    requestAnimationFrame(() => {
      activate()
      if (pendingActivation?.token === token) pendingActivation = undefined
    })
  })
}

function applyWorkspaceGroupVisibility(
  preferredTabId?: string,
  preservedSizes?: Map<string, WorkspaceGroupSize>,
): void {
  const currentApi = api.value
  if (!currentApi) return
  const sizeSnapshot = preservedSizes ?? captureVisibleGroupSizes(currentApi)
  syncDockWorkspaceGroups(currentApi)
  const requestedId = props.category === 'files' ? store.activeFileTabId : store.activeEditorTabId
  const preferred = preferredTabId ? currentApi.getPanel(preferredTabId) : undefined
  const preferredGroupId = preferred ? workspaceGroupForPanel(preferred.id) : undefined
  const activeGroupStillExists = activeWorkspaceGroupId.value.length > 0
    && currentApi.groups.some((group) => dockWorkspaceGroups.get(group.id) === activeWorkspaceGroupId.value)
  const targetGroupId = preferredGroupId
    || (activeGroupStillExists ? activeWorkspaceGroupId.value : undefined)
    || (requestedId ? workspaceGroupForPanel(requestedId) : undefined)
    || currentApi.groups.map((group) => dockWorkspaceGroups.get(group.id)).find(Boolean)
  if (!targetGroupId) return
  activeWorkspaceGroupId.value = targetGroupId

  const previousSyncing = syncingPanels
  syncingPanels = true
  try {
    const visibleGroups = currentApi.groups.filter((group) => dockWorkspaceGroups.get(group.id) === targetGroupId)
    for (const group of currentApi.groups) {
      const shouldBeVisible = dockWorkspaceGroups.get(group.id) === targetGroupId
      if (group.api.isVisible !== shouldBeVisible) group.api.setVisible(shouldBeVisible)
    }
    restoreGroupSizes(currentApi, sizeSnapshot)

    const fallback = visibleGroups.flatMap((group) => group.panels).find((panel) => panel.id === requestedId)
      ?? visibleGroups[0]?.panels[0]
    const activePanel = preferred ?? fallback
    if (activePanel) {
      setCategoryActiveTab(activePanel.id)
      if (currentApi.activePanel?.id !== activePanel.id) schedulePanelActivation(activePanel.id)
    }
  } finally {
    syncingPanels = previousSyncing
  }
  tick()
}

const instanceLayout = computed(() => {
  // Dockview owns layout state outside Vue. A version tick keeps the instance
  // list in sync after moves and splits.
  layoutVersion.value
  const currentApi = api.value
  const tabIds = tabs.value.map((tab) => tab.id)
  if (!currentApi) return arrangeWorkspaceInstances(tabIds, [])
  syncDockWorkspaceGroups(currentApi)
  return arrangeWorkspaceInstances(tabIds, currentApi.groups.map((group) => ({
    workspaceGroupId: dockWorkspaceGroups.get(group.id) ?? `${props.category}:${group.id}`,
    panelIds: group.panels.map((panel) => panel.id),
    bounds: group.api.boundingBox,
  })))
})

const orderedTabs = computed(() => {
  const byId = new Map(tabs.value.map((tab) => [tab.id, tab]))
  return instanceLayout.value.flatMap(({ tabId }) => {
    const tab = byId.get(tabId)
    return tab ? [tab] : []
  })
})

const instanceMarkers = computed(() => {
  return new Map(instanceLayout.value.map(({ tabId, marker }) => [tabId, marker]))
})

function tick(): void {
  layoutVersion.value += 1
}

function groupHeadersHidden(): void {
  for (const group of api.value?.groups ?? []) {
    group.model.header.hidden = true
  }
}

function panelTitle(tab: Tab): string {
  return tab.label || (tab.kind === 'file' ? '文件列表' : '文件')
}

function restoreActivePanel(currentApi: ActivePanelApi): void {
  const requestedId = props.category === 'files' ? store.activeFileTabId : store.activeEditorTabId
  const panel = (requestedId ? currentApi.getPanel(requestedId) : undefined) ?? currentApi.activePanel
  if (!panel) return
  applyWorkspaceGroupVisibility(panel.id)
  if (panel.id !== requestedId) {
    if (store.bottomPanelCategory === props.category) setBottomPanelActiveTab(panel.id, props.category)
  }
}

function addPanel(tab: Tab): void {
  const currentApi = api.value
  if (!currentApi || (props.category === 'files' && tab.kind !== 'file') || (props.category === 'editors' && tab.kind !== 'editor')) return
  if (currentApi.getPanel(tab.id)) return

  const preservedSizes = captureVisibleGroupSizes(currentApi)
  const group = currentApi.activeGroup ?? currentApi.groups[0]
  const workspaceGroupId = ensurePanelWorkspaceGroup(tab.id)
  const options = {
    id: tab.id,
    title: panelTitle(tab),
    component: tab.kind,
    params: { tabId: tab.id },
    renderer: 'always' as const,
    inactive: true,
    ...workspacePaneConstraints,
    // Every new instance starts in its own logical group. An edge drop later
    // merges the source and target groups into one parallel layout.
    ...(group ? { position: { referenceGroup: group.id, direction: 'right' as const } } : {}),
  }
  const panel = currentApi.addPanel(options)
  dockWorkspaceGroups.set(panel.group.id, workspaceGroupId)
  groupHeadersHidden()
  applyWorkspaceGroupVisibility(undefined, preservedSizes)
}

function removePanel(tabId: string): void {
  const currentApi = api.value
  const panel = currentApi?.getPanel(tabId)
  const preservedSizes = currentApi ? captureVisibleGroupSizes(currentApi) : undefined
  if (panel && currentApi) {
    currentApi.removePanel(panel)
    panelWorkspaceGroups.delete(tabId)
    dockWorkspaceGroups.delete(panel.group.id)
  }
  if (currentApi) applyWorkspaceGroupVisibility(undefined, preservedSizes)
  tick()
}

function onReady(event: DockviewReadyEvent): void {
  api.value = event.api
  const currentApi = event.api
  subscriptions.push(
    currentApi.onDidActivePanelChange(({ panel }) => {
      if (!panel || syncingPanels) return
      // A visibility/layout pass may briefly report the group's first panel.
      // Keep the explicit instance-list selection until its deferred
      // activation has settled.
      if (pendingActivation) {
        if (pendingActivation.tabId !== panel.id) return
        pendingActivation = undefined
      }
      syncDockWorkspaceGroups(currentApi)
      activeWorkspaceGroupId.value = workspaceGroupForPanel(panel.id) ?? activeWorkspaceGroupId.value
      setBottomPanelActiveTab(panel.id, props.category)
      tick()
    }),
    currentApi.onDidLayoutChange(() => {
      groupHeadersHidden()
      if (!syncingPanels) applyWorkspaceGroupVisibility()
      else tick()
    }),
    currentApi.onWillDrop((drop) => {
      const data = drop.getData()
      if (data && data.viewId !== currentApi.id) drop.preventDefault()
      const workspaceDrag = readWorkspaceDrag(drop.nativeEvent)
      if (workspaceDrag && !canDropWorkspaceInstance(workspaceDrag.category, props.category)) drop.preventDefault()
    }),
    currentApi.onUnhandledDragOver((drop) => {
      if (activeWorkspaceDrag && canDropWorkspaceInstance(activeWorkspaceDrag.category, props.category)) drop.accept()
    }),
    currentApi.onDidDrop((drop) => {
      const workspaceDrag = activeWorkspaceDrag
      if (!workspaceDrag || !canDropWorkspaceInstance(workspaceDrag.category, props.category) || !drop.group) return
      const panel = currentApi.getPanel(workspaceDrag.tabId)
      if (!panel) return
      syncDockWorkspaceGroups(currentApi)
      const targetWorkspaceGroupId = dockWorkspaceGroups.get(drop.group.id) ?? ensurePanelWorkspaceGroup(drop.group.panels[0]?.id ?? workspaceDrag.tabId)
      // Keep Dockview's layout callbacks out of the compound add-and-move
      // operation; the new group is distributed before the source is moved.
      const previousSyncing = syncingPanels
      syncingPanels = true
      try {
        if (drop.position !== 'center') {
          const direction = edgeDropDirections[drop.position]
          const sourceGroup = panel.group
          // A hidden or zero-sized source group can leave a structural branch
          // around the target. Remove that branch before creating the target
          // split so Dockview's native distribute sizing sees the real tree.
          const sourceBounds = sourceGroup.api.boundingBox
          const sourceHasNoSize = !sourceGroup.api.isVisible
            || !sourceBounds
            || sourceBounds.width <= 0
            || sourceBounds.height <= 0
          if (sourceHasNoSize) {
            // The staging direction only chooses a temporary root slot; the
            // group is removed again when the panel enters the real split.
            const extractionGroup = currentApi.addGroup({
              direction: 'right',
              constraints: workspacePaneConstraints,
              skipSetActive: true,
            })
            panel.api.moveTo({ group: extractionGroup, position: 'center', skipSetActive: true })
          }
          const splitGroup = currentApi.addGroup({
            referenceGroup: drop.group,
            direction,
            constraints: workspacePaneConstraints,
            skipSetActive: true,
          })
          dockWorkspaceGroups.set(splitGroup.id, targetWorkspaceGroupId)
          panel.api.moveTo({ group: splitGroup, position: 'center', skipSetActive: true })

          // If the source group had other tabs, keep those tabs together in
          // their own pane. Creating that pane through addGroup preserves
          // Dockview's native distribute sizing for both horizontal and
          // vertical splits; moving the hidden source group itself does not.
          if (sourceGroup !== drop.group && sourceGroup.panels.length > 0) {
            const remainderGroup = currentApi.addGroup({
              referenceGroup: drop.group,
              direction,
              constraints: workspacePaneConstraints,
              skipSetActive: true,
            })
            dockWorkspaceGroups.set(remainderGroup.id, targetWorkspaceGroupId)
            for (const remainder of [...sourceGroup.panels]) {
              remainder.api.moveTo({ group: remainderGroup, position: 'center', skipSetActive: true })
              panelWorkspaceGroups.set(remainder.id, targetWorkspaceGroupId)
            }
          }
        } else {
          panel.api.moveTo({
            group: drop.group as unknown as PanelMoveGroup,
            position: drop.position,
            index: drop.position === 'center' ? drop.group.panels.length : undefined,
          })
        }
      } finally {
        syncingPanels = previousSyncing
      }
      panelWorkspaceGroups.set(workspaceDrag.tabId, targetWorkspaceGroupId)
      if (drop.position !== 'center') {
        // An edge drop creates a parallel pane. Merge the two logical groups
        // so they can be switched together and receive split markers.
        activeWorkspaceGroupId.value = targetWorkspaceGroupId
      }
      syncDockWorkspaceGroups(currentApi)
      const movedTab = store.tabs.find((tab) => tab.id === workspaceDrag.tabId)
      if (movedTab) selectInstance(movedTab)
      else applyWorkspaceGroupVisibility()
    }),
  )
  syncingPanels = true
  for (const tab of tabs.value) addPanel(tab)
  syncDockWorkspaceGroups(currentApi)
  restoreActivePanel(currentApi)
  syncingPanels = false
  groupHeadersHidden()
  tick()
}

function instanceMarker(tabId: string): string {
  return instanceMarkers.value.get(tabId) ?? ''
}

function selectInstance(tab: Tab): void {
  setBottomPanelActiveTab(tab.id, props.category)
  applyWorkspaceGroupVisibility(tab.id)
}

function closeInstance(tabId: string): void {
  void commandService.execute('tab.close', { area: 'tab', tabId })
}

function onDragStart(event: DragEvent, tab: Tab): void {
  const currentApi = api.value
  const panel = currentApi?.getPanel(tab.id)
  if (!event.dataTransfer || !currentApi || !panel) return
  draggingId.value = tab.id
  activeWorkspaceDrag = { tabId: tab.id, category: props.category }
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-sealshell-workspace', JSON.stringify({ tabId: tab.id, category: props.category }))
}

function onDragEnd(): void {
  draggingId.value = ''
  activeWorkspaceDrag = undefined
}

function readWorkspaceDrag(event: DragEvent | PointerEvent): { tabId: string; category: BottomPanelCategory } | undefined {
  if (!(event instanceof DragEvent)) return undefined
  const raw = event.dataTransfer?.getData('application/x-sealshell-workspace')
  if (!raw) return undefined
  try {
    const data = JSON.parse(raw) as { tabId?: string; category?: BottomPanelCategory }
    if (!data.tabId || (data.category !== 'files' && data.category !== 'editors')) return undefined
    return { tabId: data.tabId, category: data.category }
  } catch {
    return undefined
  }
}

watch(
  () => store.tabs.map((tab) => `${tab.id}:${tab.kind}`).join(','),
  (_, previous) => {
    const currentApi = api.value
    if (!currentApi) return
    const oldIds = (previous ?? '').split(',').filter(Boolean).map((value) => value.split(':')[0])
    const currentTabs = tabs.value
    const currentIds = currentTabs.map((tab) => tab.id)
    syncingPanels = true
    for (const id of oldIds.filter((id) => !currentIds.includes(id))) removePanel(id)
    for (const tab of currentTabs) addPanel(tab)
    syncDockWorkspaceGroups(currentApi)
    restoreActivePanel(currentApi)
    syncingPanels = false
    groupHeadersHidden()
    tick()
  },
  { flush: 'post' },
)

watch(
  () => props.category === 'files' ? store.activeFileTabId : store.activeEditorTabId,
  (tabId) => {
    if (!tabId || !api.value) return
    applyWorkspaceGroupVisibility(tabId)
  },
)

onBeforeUnmount(() => {
  subscriptions.forEach((subscription) => subscription.dispose())
  subscriptions = []
  api.value = null
  panelWorkspaceGroups.clear()
  dockWorkspaceGroups.clear()
  workspaceGroupSizes.clear()
})
</script>

<template>
  <div class="workspace-dock-layout">
    <div class="workspace-dock">
      <DockviewVue
        class="workspace-dockview"
        :theme="themeAbyss"
        :components="(components as any)"
        @ready="onReady"
      />
      <div v-if="!tabs.length" class="workspace-dock-empty">
        <IconFolder v-if="props.category === 'files'" :size="22" aria-hidden="true" />
        <IconFile v-else :size="22" aria-hidden="true" />
        <span>{{ props.category === 'files' ? '暂无文件列表' : '暂无打开的文件' }}</span>
      </div>
    </div>
    <aside class="workspace-instance-list" aria-label="面板实例">
      <div v-if="!tabs.length" class="workspace-instance-empty">暂无实例</div>
      <button
        v-for="tab in orderedTabs"
        :key="tab.id"
        type="button"
        class="workspace-instance"
        :class="{ active: (props.category === 'files' ? store.activeFileTabId : store.activeEditorTabId) === tab.id, dragging: draggingId === tab.id }"
        draggable="true"
        @click="selectInstance(tab)"
        @dragstart="onDragStart($event, tab)"
        @dragend="onDragEnd"
      >
        <span class="workspace-instance-marker" aria-hidden="true">{{ instanceMarker(tab.id) }}</span>
        <IconFolder v-if="tab.kind === 'file'" :size="14" aria-hidden="true" />
        <IconFile v-else :size="14" aria-hidden="true" />
        <span class="workspace-instance-label" :title="panelTitle(tab)">{{ panelTitle(tab) }}</span>
        <span class="workspace-instance-state" :class="tab.state" aria-hidden="true"></span>
        <span class="workspace-instance-close" role="button" title="关闭" @click.stop="closeInstance(tab.id)"><IconX :size="13" /></span>
      </button>
    </aside>
  </div>
</template>

<style>
.workspace-dock-layout{display:flex;min-width:0;min-height:0;width:100%;height:100%;background:#1e1e1e}.workspace-dock{position:relative;min-width:0;min-height:0;flex:1;overflow:hidden}.workspace-dockview{width:100%;height:100%}.workspace-instance-list{box-sizing:border-box;flex:0 0 var(--workspace-instance-list-width,220px);width:var(--workspace-instance-list-width,220px);min-width:160px;max-width:420px;overflow:auto;padding:6px 4px;background:#252526;border-left:1px solid #333}.workspace-instance-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#777;font-size:12px}.workspace-instance{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-height:30px;padding:0 6px;border:0;border-left:2px solid transparent;background:transparent;color:#bbb;text-align:left;cursor:pointer;font:inherit;font-size:12px}.workspace-instance:hover{background:#2d2d2d;color:#fff}.workspace-instance.active{border-left-color:#3794ff;background:#37373d;color:#fff}.workspace-instance.dragging{opacity:.5}.workspace-instance-marker{width:12px;color:#888;font-family:ui-monospace,monospace;text-align:center}.workspace-instance-label{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workspace-instance-state{width:6px;height:6px;border-radius:50%;background:#777}.workspace-instance-state.online{background:#4ec9b0}.workspace-instance-state.connecting{background:#dcdcaa}.workspace-instance-state.error{background:#f14c4c}.workspace-instance-close{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;color:#888}.workspace-instance-close:hover{color:#fff;background:#4b4b4b}
.workspace-dockview .dv-dockview{--dv-group-view-background-color:#1e1e1e;--dv-separator-border:#3c3c3c}.workspace-dockview .dv-tabs-and-actions-container{display:none}.workspace-dockview .dv-groupview{border:0}.workspace-dockview .dv-content-container{background:#1e1e1e}
.workspace-dock-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;color:#777;pointer-events:none}
</style>
