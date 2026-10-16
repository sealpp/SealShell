<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { IconDeviceDesktopPlus, IconFile, IconFolder, IconChartLine, IconFocus2, IconMaximize, IconMaximizeOff, IconX } from '@tabler/icons-vue'
import { getActiveBottomPanelTabId, setBottomPanelActiveTab, store, type BottomPanelCategory } from '../stores/app'
import {
  BOTTOM_PANEL_DEFAULT_HEIGHT_RATIO,
  BOTTOM_PANEL_MIN_HEIGHT,
  clampBottomPanelHeight,
  normalBottomPanelMaxHeight,
  shouldCollapseBottomPanel,
  shouldExitMaximizedBottomPanel,
  shouldMaximizeBottomPanel,
  shouldReopenBottomPanel,
} from '../services/bottom-panel-layout'
import BottomPanelDock from './BottomPanelDock.vue'
import { commandService } from '../services/commands'

const MIN_LIST_WIDTH = 64
const MAX_LIST_WIDTH = 420

const panelEl = ref<HTMLElement | null>(null)
const resizing = ref(false)
const shellWorkspaceHeight = ref(0)
const terminalHeaderBottom = ref<number | null>(null)
const terminalHeaderHeight = ref(0)
let activePointerId: number | null = null
let startPointerY = 0
let startHeight = 0
let listResizing = false
let listPointerId: number | null = null
let listStartX = 0
let listStartWidth = 0
let resizeObserver: ResizeObserver | null = null
let observedHeader: Element | null = null
let resizeUsesBottomAnchor = false
let resizeCollapsed = false
let resizeTarget: HTMLElement | null = null

const visible = computed(() => store.view === 'shell' && store.bottomPanelOpen)
const heightStyle = computed(() => ({ height: store.bottomPanelMaximized ? '100%' : `${clampNormalHeight(store.bottomPanelHeight)}px` }))
const terminalContext = computed(() => ({ area: 'terminal' as const, tabId: store.activeTerminalTabId }))
const canOpenTerminalMonitor = computed(() => commandService.isEnabled('monitor.open', terminalContext.value))

function getShellWorkspace(): HTMLElement | null {
  const parent = panelEl.value?.parentElement
  return parent instanceof HTMLElement ? parent : null
}

function getNormalMaxHeight(): number {
  const availableHeight = shellWorkspaceHeight.value || getShellWorkspace()?.clientHeight || window.innerHeight || 900
  const shell = getShellWorkspace()
  if (!shell) return Math.max(BOTTOM_PANEL_MIN_HEIGHT, Math.round(availableHeight))
  const shellRect = shell.getBoundingClientRect()
  return normalBottomPanelMaxHeight(availableHeight, terminalHeaderBottom.value, shellRect.top, terminalHeaderHeight.value)
}

function clampNormalHeight(value: number): number {
  return clampBottomPanelHeight(value, getNormalMaxHeight())
}

function initializeHeight(): void {
  if (store.bottomPanelHeight === 320) {
    store.bottomPanelHeight = clampNormalHeight((shellWorkspaceHeight.value || window.innerHeight || 900) * BOTTOM_PANEL_DEFAULT_HEIGHT_RATIO)
  } else {
    store.bottomPanelHeight = clampNormalHeight(store.bottomPanelHeight)
  }
}

function measureLayout(): void {
  const shell = getShellWorkspace()
  if (!shell) return
  shellWorkspaceHeight.value = shell.clientHeight

  const hasTerminal = store.tabs.some((tab) => tab.kind === 'terminal')
  const header = hasTerminal ? shell.querySelector('.main-dock .dv-tabs-and-actions-container') : null
  if (header instanceof HTMLElement) {
    const rect = header.getBoundingClientRect()
    terminalHeaderBottom.value = rect.bottom
    terminalHeaderHeight.value = rect.height
  } else {
    terminalHeaderBottom.value = null
    terminalHeaderHeight.value = 0
  }

  if (observedHeader !== header) {
    if (observedHeader) resizeObserver?.unobserve(observedHeader)
    observedHeader = header
    if (header) resizeObserver?.observe(header)
  }
}

function enterMaximized(): void {
  if (store.bottomPanelMaximized) return
  store.bottomPanelRestoreHeight = startHeight
  store.bottomPanelHeight = clampNormalHeight(startHeight)
  store.bottomPanelMaximized = true
}

function restoreFromMaximized(): void {
  if (!store.bottomPanelMaximized) return
  store.bottomPanelMaximized = false
  store.bottomPanelHeight = clampNormalHeight(store.bottomPanelRestoreHeight)
}

function exitMaximizedForResize(): void {
  store.bottomPanelMaximized = false
  store.bottomPanelHeight = getNormalMaxHeight()
  resizeUsesBottomAnchor = true
}

function toggleMaximized(): void {
  if (store.bottomPanelMaximized) {
    restoreFromMaximized()
    return
  }
  store.bottomPanelRestoreHeight = store.bottomPanelHeight
  store.bottomPanelMaximized = true
}

function closePanel(): void {
  store.bottomPanelOpen = false
}

function selectCategory(category: BottomPanelCategory): void {
  setBottomPanelActiveTab(getActiveBottomPanelTabId(category), category)
}

function startResize(event: PointerEvent): void {
  if (event.button !== 0 || resizing.value) return
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  event.preventDefault()
  resizing.value = true
  activePointerId = event.pointerId
  startPointerY = event.clientY
  startHeight = store.bottomPanelMaximized ? store.bottomPanelRestoreHeight : store.bottomPanelHeight
  resizeUsesBottomAnchor = false
  resizeTarget = target
  target.setPointerCapture(event.pointerId)
  window.addEventListener('pointermove', moveResize)
  window.addEventListener('pointerup', endResize)
  window.addEventListener('pointercancel', endResize)
}

function moveResize(event: PointerEvent): void {
  if (!resizing.value || activePointerId !== event.pointerId) return
  event.preventDefault()

  const shell = getShellWorkspace()
  const shellRect = shell?.getBoundingClientRect()
  const shellTop = shellRect?.top ?? 0
  const maximizeBoundary = terminalHeaderBottom.value ?? shellTop

  if (store.bottomPanelMaximized) {
    if (shouldExitMaximizedBottomPanel(event.clientY, maximizeBoundary)) exitMaximizedForResize()
    else return
  }

  const requestedHeight = resizeUsesBottomAnchor
    ? (shellRect?.bottom ?? 0) - event.clientY
    : startHeight + startPointerY - event.clientY

  if (resizeCollapsed) {
    if (!shouldReopenBottomPanel(requestedHeight)) return
    resizeCollapsed = false
    store.bottomPanelOpen = true
    store.bottomPanelHeight = clampNormalHeight(requestedHeight)
    return
  }

  if (shouldMaximizeBottomPanel(event.clientY, maximizeBoundary, requestedHeight, getNormalMaxHeight())) {
    enterMaximized()
    return
  }

  if (shouldCollapseBottomPanel(requestedHeight)) {
    store.bottomPanelOpen = false
    resizeCollapsed = true
    return
  }

  store.bottomPanelHeight = clampNormalHeight(requestedHeight)
}

function endResize(event?: PointerEvent): void {
  if (activePointerId === null) return
  if (event && event.pointerId !== activePointerId) return
  const pointerId = activePointerId
  activePointerId = null
  resizing.value = false
  resizeUsesBottomAnchor = false
  resizeCollapsed = false
  window.removeEventListener('pointermove', moveResize)
  window.removeEventListener('pointerup', endResize)
  window.removeEventListener('pointercancel', endResize)
  if (resizeTarget?.hasPointerCapture(pointerId)) {
    resizeTarget.releasePointerCapture(pointerId)
  }
  resizeTarget = null
}

function onViewportResize(): void {
  measureLayout()
  if (visible.value && !store.bottomPanelMaximized) store.bottomPanelHeight = clampNormalHeight(store.bottomPanelHeight)
}

function clampListWidth(value: number): number {
  return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(value)))
}

function startListResize(event: PointerEvent): void {
  if (event.button !== 0 || listResizing) return
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  event.preventDefault()
  listResizing = true
  listPointerId = event.pointerId
  listStartX = event.clientX
  listStartWidth = store.bottomPanelInstanceListWidth
  target.setPointerCapture(event.pointerId)
}

function moveListResize(event: PointerEvent): void {
  if (!listResizing || listPointerId !== event.pointerId) return
  event.preventDefault()
  store.bottomPanelInstanceListWidth = clampListWidth(listStartWidth - (event.clientX - listStartX))
}

function endListResize(event?: PointerEvent): void {
  if (listPointerId === null) return
  if (event && event.pointerId !== listPointerId) return
  const target = event?.currentTarget
  const pointerId = listPointerId
  listPointerId = null
  listResizing = false
  if (target instanceof HTMLElement && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
}

onMounted(() => {
  if (typeof ResizeObserver === 'undefined') {
    initializeHeight()
    window.addEventListener('resize', onViewportResize)
    return
  }
  resizeObserver = new ResizeObserver(() => {
    measureLayout()
    if (visible.value && !store.bottomPanelMaximized) store.bottomPanelHeight = clampNormalHeight(store.bottomPanelHeight)
  })
  const shell = getShellWorkspace()
  if (shell) resizeObserver.observe(shell)
  void nextTick(() => {
    measureLayout()
    initializeHeight()
  })
  window.addEventListener('resize', onViewportResize)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onViewportResize)
  resizeObserver?.disconnect()
  resizeObserver = null
  observedHeader = null
  endResize()
  endListResize()
})

watch(
  () => [store.tabs.length, store.view, store.bottomPanelOpen],
  () => void nextTick(measureLayout),
)
</script>

<template>
  <section v-show="visible" ref="panelEl" class="workspace-panel" :class="{ maximized: store.bottomPanelMaximized }" :style="heightStyle" aria-label="面板">
    <div
      class="workspace-resizer"
      :class="{ dragging: resizing }"
      role="separator"
      aria-label="调整面板高度"
      @pointerdown="startResize"
    ></div>
    <nav class="workspace-categories" role="tablist" aria-label="面板视图">
      <button
        type="button"
        role="tab"
        class="workspace-category"
        :class="{ active: store.bottomPanelCategory === 'files' }"
        :aria-selected="store.bottomPanelCategory === 'files'"
        @click="selectCategory('files')"
      >
        <IconFolder :size="14" aria-hidden="true" />
        <span>文件列表</span>
      </button>
      <button
        type="button"
        role="tab"
        class="workspace-category"
        :class="{ active: store.bottomPanelCategory === 'editors' }"
        :aria-selected="store.bottomPanelCategory === 'editors'"
        @click="selectCategory('editors')"
      >
        <IconFile :size="14" aria-hidden="true" />
        <span>文件编辑</span>
      </button>
      <button type="button" role="tab" class="workspace-category"
        :class="{ active: store.bottomPanelCategory === 'monitors' }"
        :aria-selected="store.bottomPanelCategory === 'monitors'" @click="selectCategory('monitors')">
        <IconChartLine :size="14" aria-hidden="true" /><span>性能监测</span>
      </button>
      <div class="workspace-actions">
        <button v-if="store.bottomPanelCategory === 'monitors'" type="button" class="workspace-action" :disabled="!canOpenTerminalMonitor"
          aria-label="打开或定位当前终端的性能监测" :title="canOpenTerminalMonitor ? '打开或定位当前终端的性能监测' : '当前没有可用的终端会话'"
          @click="commandService.execute('monitor.open', terminalContext)"><IconFocus2 :size="15" aria-hidden="true" /></button>
        <button v-if="store.bottomPanelCategory === 'files'" type="button" class="workspace-action" :disabled="!store.paired"
          aria-label="新建本地窗口并分栏" title="新建本地窗口并分栏 (Alt+L)"
          @click="commandService.execute('file.newLocalSplit', { area: 'global' })"><IconDeviceDesktopPlus :size="15" /></button>
        <button
          type="button"
          class="workspace-action"
          :aria-label="store.bottomPanelMaximized ? '恢复面板大小' : '最大化面板'"
          :title="store.bottomPanelMaximized ? '恢复面板大小' : '最大化面板'"
          @click="toggleMaximized"
        >
          <IconMaximizeOff v-if="store.bottomPanelMaximized" :size="15" aria-hidden="true" />
          <IconMaximize v-else :size="15" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="workspace-action"
          aria-label="关闭面板"
          title="关闭面板"
          @click="closePanel"
        >
          <IconX :size="15" aria-hidden="true" />
        </button>
      </div>
    </nav>
    <div class="workspace-content">
      <div class="workspace-category-view" :class="{ active: store.bottomPanelCategory === 'files' }">
        <BottomPanelDock category="files" />
      </div>
      <div class="workspace-category-view" :class="{ active: store.bottomPanelCategory === 'editors' }">
        <BottomPanelDock category="editors" />
      </div>
      <div class="workspace-category-view" :class="{ active: store.bottomPanelCategory === 'monitors' }">
        <BottomPanelDock category="monitors" />
      </div>
    </div>
    <div
      class="workspace-list-resizer"
      :class="{ dragging: listResizing }"
      role="separator"
      aria-label="调整实例列表宽度"
      @pointerdown="startListResize"
      @pointermove="moveListResize"
      @pointerup="endListResize"
      @pointercancel="endListResize"
      @lostpointercapture="endListResize"
    ></div>
  </section>
</template>

<style scoped>
.workspace-panel {
  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  flex: 0 0 auto;
  min-height: 0;
  min-width: 0;
  background: #1e1e1e;
  border-top: 1px solid #111;
  color: #ccc;
}

.workspace-panel.maximized {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100% !important;
  z-index: 20;
}

.workspace-resizer {
  position: absolute;
  top: -4px;
  left: 0;
  right: 0;
  z-index: 25;
  height: 8px;
  cursor: row-resize;
  touch-action: none;
  user-select: none;
}

.workspace-resizer::before {
  content: '';
  position: absolute;
  inset: 2px 0;
  background: transparent;
  transition: background 0.12s ease;
}

.workspace-resizer:hover::before,
.workspace-resizer.dragging::before {
  background: rgba(74, 170, 255, 0.42);
}

.workspace-categories {
  box-sizing: border-box;
  display: flex;
  align-items: stretch;
  flex: 0 0 35px;
  min-height: 35px;
  background: #252526;
  border-bottom: 1px solid #333;
}

.workspace-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  padding: 0 6px;
}

.workspace-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #aaa;
  cursor: pointer;
}

.workspace-action:hover:not(:disabled),
.workspace-action:focus-visible {
  background: #3c3c3c;
  color: #fff;
  outline: none;
}

.workspace-action:disabled {
  opacity: 0.4;
  cursor: default;
}

.workspace-category {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 96px;
  padding: 0 13px;
  border: 0;
  border-top: 2px solid transparent;
  background: transparent;
  color: #999;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.workspace-category:hover {
  color: #fff;
  background: #2d2d2d;
}

.workspace-category.active {
  border-top-color: #3794ff;
  background: #1e1e1e;
  color: #fff;
}

.workspace-content {
  position: relative;
  min-height: 0;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.workspace-category-view {
  position: absolute;
  inset: 0;
  display: none;
  min-width: 0;
  min-height: 0;
  --workspace-instance-list-width: v-bind('store.bottomPanelInstanceListWidth + "px"');
}

.workspace-category-view.active {
  display: flex;
}

.workspace-list-resizer {
  position: absolute;
  top: 35px;
  right: calc(v-bind('store.bottomPanelInstanceListWidth + "px"') - 4px);
  bottom: 0;
  z-index: 20;
  width: 8px;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}

.workspace-list-resizer::before {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
}

.workspace-list-resizer:hover::before,
.workspace-list-resizer.dragging::before {
  background: rgba(74, 170, 255, 0.42);
}
</style>
