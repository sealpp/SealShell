<script setup lang="ts">
import ProxyErrorAction from '../components/ProxyErrorAction.vue'
import FileIcon from '../components/FileIcon.vue'
import WorkbenchColumnHeader from '../components/WorkbenchColumnHeader.vue'
import { nextColumnSort } from '../components/table-sort'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { IconArrowBackUp, IconArrowForwardUp, IconArrowUp, IconEye, IconRefresh } from '../ui/icons'
import CommandContextMenu from '../components/CommandContextMenu.vue'
import { FILE_MENU_ID } from '../services/actions/menuIds'
import type { CommandContext } from '../services/context'
import { commandService } from '../services/commands'
import { setBottomPanelActiveTab, store, type FileEntry, type FileTab, type FileSortKey } from '../stores/app'
import { transferFileEntries } from '../services/files/transfers'
import { filePresentation } from '../services/files/file-type'
import { sortFileEntries } from '../services/sftp/sort'
import { getFileBackend, goBackFileTab, goForwardFileTab, navigateFileTab, navigateParentFileTab, refreshFileTab } from '../services/sftp/file-tabs'

const props = defineProps<{ params: { params: { tabId: string; [key: string]: unknown }; [key: string]: unknown } }>()
const tabId = computed(() => String(props.params?.params?.tabId ?? ''))
const tab = computed(() => store.tabs.find((candidate) => candidate.id === tabId.value && candidate.kind === 'file') as FileTab | undefined)
const isFocused = computed(() => store.focusedDock === 'bottomPanel'
  && store.bottomPanelCategory === 'files' && store.activeFileTabId === tabId.value)
const pathInput = ref('')
const dropTarget = ref<string | null>(null)
const listEl = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const ROW_HEIGHT = 22
let activateTimer: number | undefined

const columns = [
  { key: 'name', label: '名称', minWidth: 80 },
  { key: 'size', label: '大小', minWidth: 64 },
  { key: 'modified', label: '修改时间', minWidth: 110 },
  { key: 'type', label: '类型', minWidth: 64 },
] as const
const columnWidths = ref<number[]>([])
const columnStyle = computed(() => columnWidths.value.length ? {
  '--file-columns': columnWidths.value.map((width) => `${width}px`).join(' '),
  '--file-list-width': `${columnWidths.value.reduce((sum, width) => sum + width, 0)}px`,
} : undefined)

function measureColumns(): void {
  const header = listEl.value!.querySelector('.file-list-head')!
  columnWidths.value = Array.from(header.children, cell => cell.getBoundingClientRect().width)
}

const sortedEntries = computed(() => tab.value?.file.entries ?? [])
const canNavigateParent = computed(() => {
  const current = tab.value
  const paths = getFileBackend(tabId.value)?.paths
  return !!current && !!paths && !!current.file.cwd && !paths.equal(current.file.cwd, paths.parent(current.file.cwd))
})
const renderStart = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - 8))
const renderEnd = computed(() => Math.min(sortedEntries.value.length, renderStart.value + Math.ceil(viewportHeight.value / ROW_HEIGHT) + 16))
const renderedEntries = computed(() => sortedEntries.value.slice(renderStart.value, renderEnd.value)
  .map(entry => ({ entry, presentation: filePresentation(entry) })))
const topSpacer = computed(() => renderStart.value * ROW_HEIGHT)
const bottomSpacer = computed(() => Math.max(0, (sortedEntries.value.length - renderEnd.value) * ROW_HEIGHT))

function fileContext(): CommandContext {
  const current = tab.value
  const selected = current?.file.selectedPaths ?? []
  return {
    area: 'file',
    tabId: tabId.value,
    selectedPaths: selected,
    selectedCount: selected.length,
    filePath: selected[0],
    fileKind: current?.file.entries.find((entry) => entry.path === selected[0])?.kind,
    canPasteFiles: !!store.sftpClipboard?.entries.length,
  }
}

function syncPath(): void { pathInput.value = tab.value?.file.cwd ?? '' }
function onListScroll(event: Event): void {
  const element = event.currentTarget as HTMLElement
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight
}

function select(entry: FileEntry, event: MouseEvent): void {
  const current = tab.value
  if (!current) return
  const paths = sortedEntries.value.map((candidate) => candidate.path)
  const index = paths.indexOf(entry.path)
  const selected = new Set(current.file.selectedPaths)
  if (event.shiftKey && selected.size) {
    const anchor = paths.indexOf(Array.from(selected)[0])
    const start = Math.min(anchor < 0 ? index : anchor, index)
    const end = Math.max(anchor < 0 ? index : anchor, index)
    current.file.selectedPaths = paths.slice(start, end + 1)
  } else if (event.ctrlKey || event.metaKey) {
    if (selected.has(entry.path)) selected.delete(entry.path)
    else selected.add(entry.path)
    current.file.selectedPaths = Array.from(selected)
  } else {
    current.file.selectedPaths = [entry.path]
  }
}

async function openEntry(entry: FileEntry): Promise<void> {
  select(entry, new MouseEvent('click'))
  await commandService.execute('file.open', fileContext())
}

async function navigateFromInput(): Promise<void> {
  await navigateFileTab(tabId.value, pathInput.value)
  syncPath()
}

async function goToParent(): Promise<void> {
  if (!canNavigateParent.value) return
  await navigateParentFileTab(tabId.value)
  syncPath()
}

function setSort(key: FileSortKey): void {
  const current = tab.value
  if (!current) return
  const next = nextColumnSort(current.file.sortKey ? { key: current.file.sortKey, direction: current.file.sortDirection } : null, key)
  current.file.sortKey = next?.key ?? null
  current.file.sortDirection = next?.direction ?? 'asc'
  current.file.entries = sortFileEntries(current.file.entries, next?.key ?? 'name', next?.direction ?? 'asc')
  scrollTop.value = 0
  if (listEl.value) listEl.value.scrollTop = 0
}

function toggleHidden(): void {
  if (!tab.value) return
  tab.value.file.showHidden = !tab.value.file.showHidden
  void refreshFileTab(tabId.value)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement) return
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && ['c', 'x', 'v'].includes(key)) {
    event.preventDefault()
    void commandService.execute(`file.${key === 'c' ? 'copy' : key === 'x' ? 'cut' : 'paste'}`, fileContext())
  } else if (key === 'f2' || key === 'delete' || key === 'backspace' || key === 'f5') {
    event.preventDefault()
    void commandService.execute(key === 'f2' ? 'file.rename' : key === 'f5' ? 'file.refresh' : 'file.delete', fileContext())
  } else if (event.altKey && event.key === 'ArrowUp') {
    event.preventDefault()
    void goToParent()
  }
}

function onDragStart(event: DragEvent, entry: FileEntry): void {
  if (!event.dataTransfer) return
  const current = tab.value
  if (!current) return
  if (!current.file.selectedPaths.includes(entry.path)) current.file.selectedPaths = [entry.path]
  event.dataTransfer.effectAllowed = 'copy'
  event.dataTransfer.setData('application/x-sealshell-files', JSON.stringify({ sourceTabId: tabId.value, paths: current.file.selectedPaths }))
}

function onDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('application/x-sealshell-files')) return
  if (activateTimer !== undefined) window.clearTimeout(activateTimer)
  activateTimer = window.setTimeout(() => { setBottomPanelActiveTab(tabId.value, 'files') }, 500)
}

function onDragLeave(): void {
  if (activateTimer !== undefined) window.clearTimeout(activateTimer)
  activateTimer = undefined
}

async function onDrop(event: DragEvent, entry?: FileEntry): Promise<void> {
  onDragLeave()
  dropTarget.value = null
  const raw = event.dataTransfer?.getData('application/x-sealshell-files')
  if (!raw) return
  event.preventDefault()
  event.stopPropagation()
  let payload: { sourceTabId: string; paths: string[] }
  try { payload = JSON.parse(raw) as { sourceTabId: string; paths: string[] } } catch { return }
  const current = tab.value
  if (!current) return
  const targetDirectory = entry?.kind === 'directory' ? entry.path : current.file.cwd
  try { await transferFileEntries(payload.sourceTabId, tabId.value, payload.paths, targetDirectory) }
  catch (error) { current.file.error = error instanceof Error ? error.message : String(error) }
}

function isSelected(entry: FileEntry): boolean { return !!tab.value?.file.selectedPaths.includes(entry.path) }

function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${Number(value.toFixed(2))} ${units[unit]}`
}

watch(() => tab.value?.file.cwd, syncPath)
onMounted(syncPath)
onBeforeUnmount(onDragLeave)
</script>

<template>
  <CommandContextMenu v-if="tab" :menu-id="FILE_MENU_ID" :context="fileContext">
    <div class="file-panel workbench-list-panel" :class="{ focused: isFocused }" :data-file-tab="tabId" :data-endpoint="tab.endpoint?.kind" tabindex="0" @pointerdown="setBottomPanelActiveTab(tabId, 'files')" @focusin="setBottomPanelActiveTab(tabId, 'files')" @keydown="onKeydown" @dragover.prevent @dragenter="onDragEnter" @dragleave="onDragLeave" @drop="onDrop">
      <header class="file-toolbar workbench-list-toolbar">
        <button type="button" title="后退" :disabled="tab.file.historyIndex <= 0" @click="goBackFileTab(tabId)"><IconArrowBackUp :size="16" /></button>
        <button type="button" title="前进" :disabled="tab.file.historyIndex >= tab.file.history.length - 1" @click="goForwardFileTab(tabId)"><IconArrowForwardUp :size="16" /></button>
        <button type="button" title="上级目录" :disabled="!canNavigateParent" @click="goToParent"><IconArrowUp :size="16" /></button>
        <button type="button" title="刷新" @click="refreshFileTab(tabId)"><IconRefresh :size="16" /></button>
        <select v-if="tab.endpoint?.kind === 'local'" value="" aria-label="本地位置" @change="navigateFileTab(tabId, ($event.target as HTMLSelectElement).value)">
          <option value="" disabled>本地位置</option><option :value="tab.file.defaultPath">用户主目录</option>
          <option v-for="root in tab.file.roots ?? []" :key="root" :value="root">{{ root }}</option>
        </select>
        <input v-model="pathInput" :aria-label="tab.endpoint?.kind === 'local' ? '本地路径' : '远端路径'" @keydown.enter="navigateFromInput" @blur="syncPath">
        <button type="button" title="显示隐藏文件" :class="{ active: tab.file.showHidden }" :aria-pressed="tab.file.showHidden" @click="toggleHidden"><IconEye :size="16" /></button>
      </header>
      <div v-if="tab.file.error" class="file-error">{{ tab.file.error }} <ProxyErrorAction :source="tab.proxySource" :message="tab.file.error" /></div>
      <div ref="listEl" class="file-list workbench-table-scroll" role="grid" aria-label="文件列表" aria-multiselectable="true" :aria-rowcount="sortedEntries.length + 2" :style="columnStyle" @scroll="onListScroll">
        <div class="file-list-head workbench-table-head" role="row">
          <WorkbenchColumnHeader v-for="(column, index) in columns" :key="column.key" :label="column.label" :min-width="column.minWidth"
            :direction="tab.file.sortKey === column.key ? tab.file.sortDirection : null" help="默认：目录优先，名称升序"
            @sort="setSort(column.key)" @resize-start="measureColumns" @resize="columnWidths[index] = $event" />
        </div>
        <div
          class="file-row file-parent workbench-table-row"
          role="row"
          aria-rowindex="2"
          :class="{ disabled: !canNavigateParent }"
          :aria-disabled="!canNavigateParent"
          title="返回上一级目录"
          @dblclick="goToParent"
        >
          <span class="file-name workbench-table-cell" role="gridcell"><IconArrowBackUp class="file-parent-icon" :size="16" aria-hidden="true" /><span>..</span></span>
          <span class="workbench-table-cell" role="gridcell">—</span>
          <span class="workbench-table-cell" role="gridcell">—</span>
          <span class="workbench-table-cell" role="gridcell">目录</span>
        </div>
        <div class="virtual-spacer" :style="{ height: `${topSpacer}px` }" aria-hidden="true" />
        <div
          v-for="({ entry, presentation }, index) in renderedEntries"
          :key="entry.path"
          class="file-row workbench-table-row"
          role="row"
          :aria-rowindex="renderStart + index + 3"
          :aria-selected="isSelected(entry)"
          :class="{ selected: isSelected(entry), drop: dropTarget === entry.path }"
          draggable="true"
          @click="select(entry, $event)"
          @dblclick="openEntry(entry)"
          @dragstart="onDragStart($event, entry)"
          @dragenter="dropTarget = entry.kind === 'directory' ? entry.path : null"
          @dragover.prevent
          @drop="onDrop($event, entry)"
          @contextmenu="!isSelected(entry) && select(entry, $event)"
        >
          <span class="file-name workbench-table-cell" role="gridcell">
            <FileIcon :icon="presentation.icon" :label="presentation.typeLabel" />
            <span class="file-name-text">{{ entry.name }}</span>
            <span v-if="presentation.decoration" class="file-decoration" :title="presentation.typeLabel" aria-hidden="true">{{ presentation.decoration }}</span>
          </span>
          <span class="workbench-table-cell" role="gridcell" :title="entry.kind === 'directory' ? undefined : `${entry.size.toLocaleString()} 字节`">{{ entry.kind === 'directory' ? '—' : formatFileSize(entry.size) }}</span>
          <span class="workbench-table-cell" role="gridcell">{{ entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '—' }}</span>
          <span class="workbench-table-cell" role="gridcell" :title="presentation.typeLabel">{{ presentation.typeLabel }}</span>
        </div>
        <div class="virtual-spacer" :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />
        <div v-if="tab.file.loading" class="file-empty">正在加载...</div>
        <div v-else-if="!sortedEntries.length && !tab.file.error" class="file-empty">目录为空</div>
      </div>
    </div>
  </CommandContextMenu>
</template>

<style scoped>
.file-panel {
  min-width: 0;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  outline: none;
}
.file-toolbar button { width: 26px; padding: 0; }
.file-toolbar input { min-width: 100px; flex: 1; }
.file-toolbar select { max-width: 120px; padding: 0 6px; }
.file-error { padding: 8px 12px; color: var(--workbench-error); background: var(--vscode-inputValidation-errorBackground); border-bottom: 1px solid var(--vscode-inputValidation-errorBorder); }
.file-list { min-height: 0; flex: 1; overflow: auto; }
.file-list-head, .file-row {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: var(--file-columns, minmax(160px, 1fr) 90px 165px 100px);
  align-items: center;
  min-width: max(100%, var(--file-list-width, 515px));
  height: var(--workbench-row-height);
}
.file-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
}
.file-row { user-select: none; }
.file-row.drop { outline: 1px solid var(--workbench-focus-border); outline-offset: -1px; }
.file-row > [role='gridcell'] { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.file-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.file-name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-decoration { flex: none; margin-left: auto; font-size: 16px; }
.file-parent { cursor: pointer; }
.file-parent.disabled { color: var(--workbench-text-disabled); cursor: default; }
.file-parent-icon { flex: 0 0 16px; }
.virtual-spacer { pointer-events: none; }
.file-empty { padding: 28px; color: var(--workbench-text-muted); text-align: center; }
</style>
