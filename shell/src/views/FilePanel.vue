<script setup lang="ts">
import ProxyErrorAction from '../components/ProxyErrorAction.vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { IconArrowBackUp, IconArrowForwardUp, IconArrowUp, IconEye, IconRefresh } from '@tabler/icons-vue'
import CommandContextMenu from '../components/CommandContextMenu.vue'
import { FILE_MENU_ID } from '../services/actions/menuIds'
import type { CommandContext } from '../services/context'
import { commandService } from '../services/commands'
import { setBottomPanelActiveTab, store, type FileEntry, type FileTab } from '../stores/app'
import { transferFileEntries } from '../services/files/transfers'
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
const ROW_HEIGHT = 32
let activateTimer: number | undefined

const columns = [
  { label: '名称', minWidth: 80 },
  { label: '大小', minWidth: 64 },
  { label: '修改时间', minWidth: 110 },
  { label: '类型', minWidth: 64 },
]
const columnWidths = ref<number[]>([])
const columnResize = shallowRef<{ index: number; pointerId: number; startX: number; startWidth: number } | null>(null)
const columnStyle = computed(() => columnWidths.value.length ? {
  '--file-columns': columnWidths.value.map((width) => `${width}px`).join(' '),
  '--file-list-width': `${columnWidths.value.reduce((sum, width) => sum + width, 0) + 54}px`,
} : undefined)

function measureColumns(handle: HTMLElement): void {
  const header = handle.parentElement!.parentElement!
  columnWidths.value = Array.from(header.children, (cell) => cell.getBoundingClientRect().width)
}

function startColumnResize(event: PointerEvent, index: number): void {
  if (event.button !== 0 || columnResize.value) return
  event.preventDefault()
  const handle = event.currentTarget as HTMLElement
  measureColumns(handle)
  columnResize.value = { index, pointerId: event.pointerId, startX: event.clientX, startWidth: columnWidths.value[index] }
  handle.setPointerCapture(event.pointerId)
}

function moveColumnResize(event: PointerEvent): void {
  const resize = columnResize.value
  if (!resize || resize.pointerId !== event.pointerId) return
  columnWidths.value[resize.index] = Math.max(columns[resize.index].minWidth, Math.round(resize.startWidth + event.clientX - resize.startX))
}

function endColumnResize(event: PointerEvent): void {
  if (columnResize.value?.pointerId !== event.pointerId) return
  columnResize.value = null
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
}

function resizeColumnWithKeyboard(event: KeyboardEvent, index: number): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  measureColumns(event.currentTarget as HTMLElement)
  columnWidths.value[index] = event.key === 'Home'
    ? columns[index].minWidth
    : Math.max(columns[index].minWidth, columnWidths.value[index] + (event.key === 'ArrowLeft' ? -10 : 10))
}

const sortedEntries = computed(() => tab.value?.file.entries ?? [])
const canNavigateParent = computed(() => {
  const current = tab.value
  const paths = getFileBackend(tabId.value)?.paths
  return !!current && !!paths && !!current.file.cwd && !paths.equal(current.file.cwd, paths.parent(current.file.cwd))
})
const renderStart = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - 8))
const renderEnd = computed(() => Math.min(sortedEntries.value.length, renderStart.value + Math.ceil(viewportHeight.value / ROW_HEIGHT) + 16))
const renderedEntries = computed(() => sortedEntries.value.slice(renderStart.value, renderEnd.value))
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

function setSort(event: Event): void {
  const current = tab.value
  if (!current) return
  const value = (event.target as HTMLSelectElement).value
  const [sortKey, sortDirection] = value.split(':') as [FileTab['file']['sortKey'], FileTab['file']['sortDirection']]
  current.file.sortKey = sortKey
  current.file.sortDirection = sortDirection
  void refreshFileTab(tabId.value)
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

watch(() => tab.value?.file.cwd, syncPath)
onMounted(syncPath)
onBeforeUnmount(onDragLeave)
</script>

<template>
  <CommandContextMenu v-if="tab" :menu-id="FILE_MENU_ID" :context="fileContext">
    <div class="file-panel" :class="{ focused: isFocused }" :data-file-tab="tabId" :data-endpoint="tab.endpoint?.kind" tabindex="0" @pointerdown="setBottomPanelActiveTab(tabId, 'files')" @focusin="setBottomPanelActiveTab(tabId, 'files')" @keydown="onKeydown" @dragover.prevent @dragenter="onDragEnter" @dragleave="onDragLeave" @drop="onDrop">
      <header class="file-toolbar">
        <button type="button" title="后退" :disabled="tab.file.historyIndex <= 0" @click="goBackFileTab(tabId)"><IconArrowBackUp :size="16" /></button>
        <button type="button" title="前进" :disabled="tab.file.historyIndex >= tab.file.history.length - 1" @click="goForwardFileTab(tabId)"><IconArrowForwardUp :size="16" /></button>
        <button type="button" title="上级目录" :disabled="!canNavigateParent" @click="goToParent"><IconArrowUp :size="16" /></button>
        <button type="button" title="刷新" @click="refreshFileTab(tabId)"><IconRefresh :size="16" /></button>
        <select v-if="tab.endpoint?.kind === 'local'" value="" aria-label="本地位置" @change="navigateFileTab(tabId, ($event.target as HTMLSelectElement).value)">
          <option value="" disabled>本地位置</option><option :value="tab.file.defaultPath">用户主目录</option>
          <option v-for="root in tab.file.roots ?? []" :key="root" :value="root">{{ root }}</option>
        </select>
        <input v-model="pathInput" :aria-label="tab.endpoint?.kind === 'local' ? '本地路径' : '远端路径'" @keydown.enter="navigateFromInput" @blur="syncPath">
        <button type="button" title="显示隐藏文件" :class="{ active: tab.file.showHidden }" @click="toggleHidden"><IconEye :size="16" /></button>
        <select :value="`${tab.file.sortKey}:${tab.file.sortDirection}`" aria-label="排序" @change="setSort">
          <option value="name:asc">文件名 A-Z</option><option value="name:desc">文件名 Z-A</option>
          <option value="modified:desc">修改时间 新-旧</option><option value="modified:asc">修改时间 旧-新</option>
          <option value="size:desc">大小 大-小</option><option value="size:asc">大小 小-大</option>
        </select>
      </header>
      <div v-if="tab.file.error" class="file-error">{{ tab.file.error }} <ProxyErrorAction :source="tab.proxySource" :message="tab.file.error" /></div>
      <div ref="listEl" class="file-list" :style="columnStyle" @scroll="onListScroll">
        <div class="file-list-head">
          <span v-for="(column, index) in columns" :key="column.label" class="file-column-header">
            <span>{{ column.label }}</span>
            <span
              class="file-column-resizer"
              :class="{ dragging: columnResize?.index === index }"
              role="separator"
              tabindex="0"
              aria-orientation="vertical"
              :aria-label="`调整${column.label}列宽`"
              :aria-valuemin="column.minWidth"
              :aria-valuenow="columnWidths[index]"
              :title="`拖动调整${column.label}列宽`"
              @pointerdown="startColumnResize($event, index)"
              @pointermove="moveColumnResize"
              @pointerup="endColumnResize"
              @pointercancel="endColumnResize"
              @lostpointercapture="endColumnResize"
              @keydown="resizeColumnWithKeyboard($event, index)"
            />
          </span>
        </div>
        <div
          class="file-row file-parent"
          :class="{ disabled: !canNavigateParent }"
          :aria-disabled="!canNavigateParent"
          title="返回上一级目录"
          @dblclick="goToParent"
        >
          <span class="file-name"><span class="file-kind">↩</span><span>..</span></span>
          <span>—</span>
          <span>—</span>
          <span>目录</span>
        </div>
        <div class="virtual-spacer" :style="{ height: `${topSpacer}px` }" aria-hidden="true" />
        <div
          v-for="entry in renderedEntries"
          :key="entry.path"
          class="file-row"
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
          <span class="file-name"><span class="file-kind">{{ entry.kind === 'directory' ? '▰' : entry.kind === 'symlink' ? '↗' : '•' }}</span><span>{{ entry.name }}</span></span>
          <span>{{ entry.kind === 'directory' ? '—' : entry.size }}</span>
          <span>{{ entry.modifiedAt ? new Date(entry.modifiedAt).toLocaleString() : '—' }}</span>
          <span>{{ entry.kind }}</span>
        </div>
        <div class="virtual-spacer" :style="{ height: `${bottomSpacer}px` }" aria-hidden="true" />
        <div v-if="tab.file.loading" class="file-empty">正在加载...</div>
        <div v-else-if="!sortedEntries.length && !tab.file.error" class="file-empty">目录为空</div>
      </div>
    </div>
  </CommandContextMenu>
</template>

<style scoped>
.file-parent{color:#ddd;cursor:pointer}.file-parent.disabled{color:#777;cursor:default}
.file-panel{min-width:0;overflow:hidden;width:100%;height:100%;display:flex;flex-direction:column;background:#1e1e1e;color:#ccc;outline:none}.file-toolbar{min-height:40px;flex-wrap:wrap;display:flex;align-items:center;gap:5px;padding:5px 8px;background:#252526;border-bottom:1px solid #333}.file-toolbar button{width:27px;height:27px;display:inline-flex;align-items:center;justify-content:center;background:#333;border:1px solid #444;color:#ccc;cursor:pointer}.file-toolbar button:hover,.file-toolbar button.active{background:#0e639c;color:#fff}.file-toolbar button:disabled{opacity:.4;cursor:default}.file-toolbar input{min-width:100px;flex:1;height:27px;background:#1e1e1e;border:1px solid #555;color:#eee;padding:0 8px}.file-toolbar select{height:27px;max-width:120px;background:#1e1e1e;border:1px solid #555;color:#ddd}.file-error{padding:8px 12px;color:#f48771;background:#3a1d1d;border-bottom:1px solid #633}.file-list{min-height:0;flex:1;overflow:auto}.file-list-head,.file-row{box-sizing:border-box;display:grid;grid-template-columns:var(--file-columns,minmax(140px,1fr) 80px 155px 80px);gap:10px;align-items:center;padding:0 12px;min-width:max(100%,var(--file-list-width,510px));min-height:32px;height:32px;border-bottom:1px solid #2a2a2a}.virtual-spacer{pointer-events:none}.file-list-head{position:sticky;top:0;background:#2d2d2d;color:#aaa;font-size:12px;z-index:1}.file-row{cursor:default}.file-row:hover{background:#2a2d2e}.file-row.selected{background:#37373d;color:#ccc}.file-panel.focused .file-row.selected{background:#094771;color:#fff}.file-row.drop{outline:1px solid #3794ff}.file-row>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.file-name{display:flex;align-items:center;gap:8px;min-width:0}.file-name span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-kind{color:#dcdcaa}.file-empty{padding:28px;color:#777;text-align:center}
.file-column-header{position:relative;min-width:0;height:100%;display:flex;align-items:center}.file-column-header>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-column-resizer{position:absolute;top:0;right:-9px;bottom:0;width:8px;cursor:col-resize;touch-action:none;user-select:none;outline:none}.file-column-resizer::after{content:"";position:absolute;top:6px;bottom:6px;left:3px;width:1px;background:#444}.file-column-resizer:hover::after,.file-column-resizer:focus-visible::after,.file-column-resizer.dragging::after{top:0;bottom:0;width:2px;background:#3794ff}
</style>
