<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { IconChevronDown, IconChevronRight, IconFolder, IconFolderOpen, IconPlus, IconPlug } from '@tabler/icons-vue'
import { store } from '../stores/app'
import CommandContextMenu from '../components/CommandContextMenu.vue'
import type { CommandContext } from '../services/context'
import { commandService } from '../services/commands'
import { FOLDER_MENU_ID, HOST_MENU_ID, ROOT_MENU_ID } from '../services/actions/menuIds'
import {
  buildVisibleNodes,
  canMoveToFolder,
  nodeKey,
  normalizeMoveSelection,
  type TreeNode,
} from '../services/connectionTree'
import { moveConnectionNodes } from '../services/ws'

const draggingKeys = ref<string[]>([])
const visibleNodes = computed(() => buildVisibleNodes(store.folders, store.hosts, store.expandedFolderIds))
const cutKeys = computed(() =>
  store.connectionClipboard?.mode === 'cut' ? new Set(store.connectionClipboard.nodeKeys) : undefined,
)

function isSelected(node: TreeNode): boolean {
  return store.selectedNodeIds.has(nodeKey(node.kind, node.id))
}

function syncHostSelection() {
  const hostIds = new Set<string>()
  for (const key of store.selectedNodeIds) {
    if (key.startsWith('host:')) hostIds.add(key.slice('host:'.length))
  }
  store.selectedHostIds = hostIds
}

function setSelection(keys: Set<string>, anchor?: string) {
  store.selectedNodeIds = keys
  syncHostSelection()
  if (anchor !== undefined) store.selectionAnchorNodeId = anchor
}

function toggleFolder(folderId: string) {
  const next = new Set(store.expandedFolderIds)
  if (next.has(folderId)) next.delete(folderId)
  else next.add(folderId)
  store.expandedFolderIds = next
}

function rangeSelection(targetKey: string) {
  const ids = visibleNodes.value.map((node) => nodeKey(node.kind, node.id))
  const anchorIndex = ids.indexOf(store.selectionAnchorNodeId)
  const targetIndex = ids.indexOf(targetKey)
  if (anchorIndex === -1 || targetIndex === -1) {
    setSelection(new Set([targetKey]), targetKey)
    return
  }
  const start = Math.min(anchorIndex, targetIndex)
  const end = Math.max(anchorIndex, targetIndex)
  setSelection(new Set(ids.slice(start, end + 1)), targetKey)
}

function onNodeClick(node: TreeNode, event: MouseEvent) {
  const key = nodeKey(node.kind, node.id)
  if (event.ctrlKey || event.metaKey) {
    const next = new Set(store.selectedNodeIds)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setSelection(next, key)
  } else if (event.shiftKey) {
    rangeSelection(key)
  } else {
    setSelection(new Set([key]), key)
  }
}

function nodeContext(node: TreeNode): CommandContext {
  const key = nodeKey(node.kind, node.id)
  if (!store.selectedNodeIds.has(key)) setSelection(new Set([key]), key)
  const selected = Array.from(store.selectedNodeIds)
    .map((item) => item.split(':'))
    .filter((parts) => parts.length === 2)
  const kinds = new Set(selected.map(([kind]) => kind))
  const selectedIds = selected.filter(([kind]) => kind === node.kind).map(([, id]) => id)
  return {
    area: 'host',
    selectedIds,
    selectedNodeIds: Array.from(store.selectedNodeIds),
    selectedCount: selectedIds.length,
    nodeKind: kinds.size > 1 ? 'mixed' : node.kind,
    targetFolderId: node.kind === 'folder' ? node.id : null,
    targetNodeKey: key,
  }
}

function rootContext(): CommandContext {
  setSelection(new Set())
  return { area: 'host', selectedIds: [], selectedCount: 0, nodeKind: 'root', targetFolderId: null }
}

function openNewConnection() {
  void commandService.execute('host.new', { area: 'host', targetFolderId: null })
}

function openConnect(hostId: string) {
  void commandService.execute('host.connect', {
    area: 'host',
    selectedIds: [hostId],
    selectedCount: 1,
    nodeKind: 'host',
  })
}

function onDragStart(node: TreeNode, event: DragEvent) {
  const key = nodeKey(node.kind, node.id)
  if (!store.selectedNodeIds.has(key)) setSelection(new Set([key]), key)
  const normalized = normalizeMoveSelection(store.selectedNodeIds, store.folders, store.hosts)
  draggingKeys.value = Array.from(normalized)
  event.dataTransfer?.setData('text/plain', draggingKeys.value.join(','))
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  draggingKeys.value = []
}

function canDrop(targetFolderId: string | null): boolean {
  return draggingKeys.value.length > 0 && canMoveToFolder(new Set(draggingKeys.value), targetFolderId, store.folders)
}

function onDragOverFolder(node: TreeNode, event: DragEvent) {
  if (node.kind !== 'folder' || !canDrop(node.id)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

async function onDropFolder(node: TreeNode, event: DragEvent) {
  event.preventDefault()
  if (node.kind !== 'folder' || !canDrop(node.id)) return
  await moveConnectionNodes(new Set(draggingKeys.value), node.id)
  const expanded = new Set(store.expandedFolderIds)
  expanded.add(node.id)
  store.expandedFolderIds = expanded
  onDragEnd()
}

function onDragOverRoot(event: DragEvent) {
  if ((event.target as HTMLElement | null)?.closest('.conn-item')) return
  if (!canDrop(null)) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
}

async function onDropRoot(event: DragEvent) {
  if ((event.target as HTMLElement | null)?.closest('.conn-item')) return
  event.preventDefault()
  if (!canDrop(null)) return
  await moveConnectionNodes(new Set(draggingKeys.value), null)
  onDragEnd()
}

onBeforeUnmount(() => {
  draggingKeys.value = []
})
</script>

<template>
  <div class="connections-panel">
    <div class="connections-header">
      <span>当前连接</span>
      <button type="button" class="new-btn" title="新建连接" @click="openNewConnection">
        <IconPlus :size="12" />
        新建连接
      </button>
    </div>
    <CommandContextMenu
      :menu-id="ROOT_MENU_ID"
      :context="rootContext"
      :can-open="(event) => event.target === event.currentTarget"
    >
      <div class="conn-list" tabindex="0" @dragover="onDragOverRoot" @drop="onDropRoot">
        <CommandContextMenu
          v-for="node in visibleNodes"
          :key="nodeKey(node.kind, node.id)"
          :menu-id="node.kind === 'folder' ? FOLDER_MENU_ID : HOST_MENU_ID"
          :context="() => nodeContext(node)"
        >
          <div
            class="conn-item"
            :class="{ selected: isSelected(node), dragging: draggingKeys.includes(nodeKey(node.kind, node.id)), cut: cutKeys?.has(nodeKey(node.kind, node.id)), folder: node.kind === 'folder', 'root-host': node.kind === 'host' && node.depth === 0 }"
            :style="{ paddingLeft: `${8 + node.depth * 16}px` }"
            :draggable="true"
            :title="node.kind === 'host' ? node.host?.address : node.folder?.name"
            @click="onNodeClick(node, $event)"
            @dblclick="node.kind === 'host' && node.host ? openConnect(node.host.id) : toggleFolder(node.id)"
            @dragstart="onDragStart(node, $event)"
            @dragend="onDragEnd"
            @dragover="onDragOverFolder(node, $event)"
            @drop="onDropFolder(node, $event)"
          >
            <button
              v-if="node.kind === 'folder'"
              type="button"
              class="tree-toggle"
              :aria-label="store.expandedFolderIds.has(node.id) ? '收起文件夹' : '展开文件夹'"
              @click.stop="toggleFolder(node.id)"
            >
              <IconChevronDown v-if="store.expandedFolderIds.has(node.id)" :size="14" />
              <IconChevronRight v-else :size="14" />
            </button>
            <span v-else class="tree-toggle-spacer" aria-hidden="true"></span>
            <span v-if="node.kind === 'folder'" class="node-icon" aria-hidden="true">
              <IconFolderOpen v-if="store.expandedFolderIds.has(node.id)" :size="15" />
              <IconFolder v-else :size="15" />
            </span>
            <span class="conn-label">{{ node.label }}</span>
            <span
              v-if="node.kind === 'host'"
              class="conn-meta"
              :title="`${node.host?.username} · ${node.host?.port}`"
            >{{ node.host?.username }} · {{ node.host?.port }}</span>
            <button
              v-if="node.kind === 'host' && node.host"
              type="button"
              class="conn-btn"
              title="连接"
              @click.stop="openConnect(node.host.id)"
            >
              <IconPlug :size="14" />
            </button>
          </div>
        </CommandContextMenu>
        <p v-if="!visibleNodes.length" class="empty">暂无保存的主机或文件夹</p>
        <div class="root-drop-zone" aria-hidden="true"></div>
      </div>
    </CommandContextMenu>
  </div>
</template>

<style scoped>
.connections-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #252526;
}

.connections-header {
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 0.75rem;
  background: #2d2d2d;
  border-bottom: 1px solid #1f1f1f;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
}

.new-btn {
  background: transparent;
  border: none;
  color: #4aaaff;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}

.new-btn:hover {
  color: #fff;
}

.conn-list {
  flex: 1;
  min-height: 24px;
  overflow-y: auto;
  padding: 0;
  outline: none;
}

.conn-item {
  display: flex;
  align-items: center;
  min-height: 30px;
  box-sizing: border-box;
  padding-top: 0;
  padding-right: 8px;
  padding-bottom: 0;
  border-left: 2px solid transparent;
  background: transparent;
  cursor: pointer;
  user-select: none;
}

.conn-item:hover {
  background: #2a2d2e;
}

.conn-item.selected {
  background: #37373d;
  border-left-color: #fff;
}

.conn-item.dragging,
.conn-item.cut {
  opacity: 0.5;
}

.tree-toggle,
.tree-toggle-spacer {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 24px;
  flex: 0 0 18px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #858585;
}

.tree-toggle {
  cursor: pointer;
}

.conn-item.root-host .tree-toggle-spacer {
  display: none;
}

.node-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  flex: 0 0 20px;
  color: #c5c5c5;
}

.conn-label {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  color: #fff;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-meta {
  min-width: 0;
  flex: 0 100 auto;
  overflow: hidden;
  margin-left: 8px;
  color: #858585;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn-btn {
  display: none;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  margin-left: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: #858585;
  cursor: pointer;
}

.conn-item:hover .conn-btn,
.conn-item.selected .conn-btn {
  display: inline-flex;
}

.conn-btn:hover {
  color: #fff;
}

.empty {
  color: #888;
  font-size: 12px;
  text-align: center;
  padding: 1rem 0;
  margin: 0;
}

.root-drop-zone {
  min-height: 24px;
  pointer-events: none;
}
</style>
