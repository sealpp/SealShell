<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getFocusedTabId, store } from './stores/app'
import { connect, initializePwa, setNodeDisconnectedHandler } from './services/ws'
import { commandService, keybindingService, syncAppContext, ContextKeys } from './services/commands'
import { startMonitoringService, stopMonitoringService } from './services/monitoring/runtime'
import { startProcessesService, stopProcessesService } from './services/processes/runtime'
import { startPortsService, stopPortsService } from './services/ports/runtime'
import { startWorkbenchCloseProtection } from './services/workbench-close-protection'
import PairingView from './views/PairingView.vue'
import HostFormView from './views/HostFormView.vue'
import LoginDialog from './components/LoginDialog.vue'
import MainDock from './views/MainDock.vue'
import PrimarySidebar from './views/PrimarySidebar.vue'
import ConnectionsDeleteConfirm from './components/ConnectionsDeleteConfirm.vue'
import FolderDialog from './components/FolderDialog.vue'
import TerminalSessionInfo from './components/TerminalSessionInfo.vue'
import ManualPasteDialog from './components/ManualPasteDialog.vue'
import HostKeyPrompt from './components/HostKeyPrompt.vue'
import { IconList } from '@tabler/icons-vue'
import NodeStatusMenu from './components/NodeStatusMenu.vue'
import WorkbenchMenu from './components/WorkbenchMenu.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import AboutDialog from './components/AboutDialog.vue'
import DirtyCloseDialog from './components/DirtyCloseDialog.vue'
import InteractionDialog from './components/InteractionDialog.vue'
import TransferStatusItem from './components/TransferStatusItem.vue'
import BottomPanel from './views/BottomPanel.vue'
import BottomPanelStatusButton from './components/BottomPanelStatusButton.vue'
import EncodingStatusItem from './components/EncodingStatusItem.vue'
import EncodingPickerDialog from './components/EncodingPickerDialog.vue'
import { loadTransferConcurrency } from './services/sftp/transfer-runtime'
import { loadTerminalPreferences } from './services/terminalPreferences'

const ACTIVITY_BAR_WIDTH = 48
const MIN_SIDEBAR_WIDTH = 160
const MIN_TERMINAL_WIDTH = 320

const mainEl = ref<HTMLElement | null>(null)
const activityEl = ref<HTMLElement | null>(null)
const sidebarEl = ref<HTMLElement | null>(null)
const resizingSidebar = ref(false)
let activePointerId: number | null = null
let lastPointerX = 0
let resizerEl: HTMLElement | null = null
let resizeFrame: number | null = null
let pendingResizeDelta = 0

const sidebarVisible = computed(() => store.sidebarOpen && store.sidebarView === 'connections')
const layoutStyle = computed(() => ({
  '--sidebar-width': `${store.sidebarWidth}px`,
}))

function toggleConnections() {
  void commandService.execute('workbench.toggleConnections', { area: 'global' })
}

function getTerminalWidth(): number {
  const mainWidth = mainEl.value?.clientWidth ?? 0
  const activityWidth = activityEl.value?.offsetWidth ?? ACTIVITY_BAR_WIDTH
  const sidebarWidth = sidebarVisible.value
    ? sidebarEl.value?.offsetWidth ?? store.sidebarWidth
    : 0
  return Math.max(0, mainWidth - activityWidth - sidebarWidth)
}

function resizeSidebar(deltaX: number) {
  const available = deltaX > 0 ? Math.max(0, getTerminalWidth() - MIN_TERMINAL_WIDTH) : deltaX
  store.sidebarWidth = Math.max(MIN_SIDEBAR_WIDTH, store.sidebarWidth + Math.min(deltaX, available))
}

function applyPendingResize() {
  resizeFrame = null
  if (!resizingSidebar.value || pendingResizeDelta === 0) return

  const deltaX = pendingResizeDelta
  pendingResizeDelta = 0
  resizeSidebar(deltaX)
}

function queueResize(deltaX: number) {
  pendingResizeDelta += deltaX
  if (resizeFrame === null) {
    resizeFrame = requestAnimationFrame(applyPendingResize)
  }
}

function flushPendingResize() {
  if (resizeFrame !== null) {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = null
  }

  if (!resizingSidebar.value || pendingResizeDelta === 0) return

  const deltaX = pendingResizeDelta
  pendingResizeDelta = 0
  resizeSidebar(deltaX)
}

function startResize(event: PointerEvent) {
  if (event.button !== 0 || resizingSidebar.value) return

  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return

  event.preventDefault()
  pendingResizeDelta = 0
  resizingSidebar.value = true
  activePointerId = event.pointerId
  lastPointerX = event.clientX
  resizerEl = target
  target.setPointerCapture(event.pointerId)
}

function moveResize(event: PointerEvent) {
  if (activePointerId !== event.pointerId || !resizingSidebar.value) return

  event.preventDefault()
  const deltaX = event.clientX - lastPointerX
  lastPointerX = event.clientX
  if (deltaX !== 0) {
    queueResize(deltaX)
  }
}

function endResize(event?: PointerEvent) {
  if (activePointerId === null) return
  if (event && event.pointerId !== activePointerId) return

  flushPendingResize()
  const pointerId = activePointerId
  const target = resizerEl
  resizingSidebar.value = false
  activePointerId = null
  lastPointerX = 0
  resizerEl = null

  if (target?.hasPointerCapture(pointerId)) {
    target.releasePointerCapture(pointerId)
  }
}

let reconnectTimer: number | null = null

const stopContextSync = watch(
  () => [
    store.view,
    store.activeTerminalTabId,
    store.activeFileTabId,
    store.activeEditorTabId,
    store.activeMonitorTabId,
    store.activeProcessTabId,
    store.activePortsTabId,
    store.bottomPanelCategory,
    store.focusedDock,
    store.bottomPanelOpen,
    store.tabs.map((tab) => `${tab.id}:${tab.state}`).join(','),
    store.sidebarOpen,
    store.paired,
    store.nodeConnected,
    store.pairingModalOpen,
    store.connectionModalOpen,
    store.loginDialogOpen,
    store.settingsModalOpen,
    store.aboutModalOpen,
    store.dirtyCloseConfirm,
    store.interactionDialog,
    store.encodingPicker,
  ],
  () => {
    syncAppContext({
      [ContextKeys.view]: store.view,
      [ContextKeys.activeTabId]: getFocusedTabId(),
      [ContextKeys.activeTabExists]: store.tabs.some((tab) => tab.id === getFocusedTabId()),
      [ContextKeys.focusedDock]: store.focusedDock,
      [ContextKeys.bottomPanelCategory]: store.bottomPanelCategory,
      [ContextKeys.bottomPanelOpen]: store.bottomPanelOpen,
      [ContextKeys.sidebarOpen]: store.sidebarOpen,
      [ContextKeys.isPaired]: store.paired,
      [ContextKeys.nodeConnected]: store.nodeConnected,
      [ContextKeys.modalOpen]: store.pairingModalOpen || store.connectionModalOpen || store.loginDialogOpen || store.settingsModalOpen || store.aboutModalOpen || !!store.dirtyCloseConfirm || !!store.interactionDialog || !!store.encodingPicker,
    })
  },
  { immediate: true },
)

function scheduleReconnect() {
  if (!store.paired || reconnectTimer !== null) return
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null
    void connectNode()
  }, 2000)
}

async function connectNode() {
  if (!store.paired) return
  try {
    await connect()
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
    scheduleReconnect()
  }
}

const stopCloseProtection = startWorkbenchCloseProtection(window)
let disposed = false

onMounted(async () => {
  setNodeDisconnectedHandler(scheduleReconnect)
  try {
    await initializePwa()
    await loadTransferConcurrency()
    await loadTerminalPreferences()
    if (!store.paired) {
      store.pairingModalOpen = true
    } else {
      await connectNode()
    }
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
  if (disposed) return
  startMonitoringService()
  startProcessesService()
  startPortsService()
  keybindingService.attach(window, () => {
    const tabId = getFocusedTabId()
    const tab = store.tabs.find((item) => item.id === tabId)
    const inConnections = document.activeElement instanceof Element
      && !!document.activeElement.closest('.primary-sidebar')
    return {
      area: inConnections ? 'host' : tab?.kind === 'file' ? 'file' : tab?.kind === 'editor' ? 'editor' : 'global',
      tabId,
      selectedPaths: tab?.kind === 'file' ? tab.file?.selectedPaths : undefined,
      canPasteFiles: !!store.sftpClipboard?.entries.length,
      selectedNodeIds: inConnections ? Array.from(store.selectedNodeIds) : undefined,
      selectedCount: inConnections ? store.selectedNodeIds.size : undefined,
    }
  })
})

onBeforeUnmount(() => {
  disposed = true
  stopCloseProtection()
  stopMonitoringService()
  stopProcessesService()
  stopPortsService()
  endResize()
  setNodeDisconnectedHandler(undefined)
  keybindingService.dispose()
  stopContextSync()
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
})
</script>

<template>
  <div class="app">
    <div v-if="store.error" class="global-error">{{ store.error }}</div>
    <div
      ref="mainEl"
      class="main"
      :class="{ resizing: resizingSidebar }"
      :style="layoutStyle"
    >
      <div ref="activityEl" class="activity">
        <div class="top-icons">
          <div
            class="icon"
            :class="{ active: store.sidebarOpen && store.sidebarView === 'connections' }"
            title="会话"
            @click="toggleConnections"
          >
            <IconList :size="24" />
          </div>

        </div>
        <div class="activity-bottom">
          <WorkbenchMenu />
        </div>
      </div>
      <aside ref="sidebarEl" class="sidebar primary-sidebar" :class="{ collapsed: !sidebarVisible }">
        <PrimarySidebar />
      </aside>
      <div
        v-if="sidebarVisible"
        class="panel-resizer"
        :class="{ dragging: resizingSidebar }"
        aria-hidden="true"
        @pointerdown="startResize($event)"
        @pointermove="moveResize"
        @pointerup="endResize"
        @pointercancel="endResize"
        @lostpointercapture="endResize"
      ></div>
      <div class="terminal-area">
        <div v-if="store.view === 'shell'" class="shell-workspace" :class="{ 'bottom-panel-maximized': store.bottomPanelMaximized }">
          <div class="main-dock-container">
            <MainDock />
          </div>
          <BottomPanel />
        </div>
        <div v-else class="welcome">
          <div class="welcome-logo">
            <img src="/icon.svg" class="logo-img" alt="SealShell" />
          </div>
          <h2>SealShell</h2>
          <p v-if="!store.paired">请点击左下角 Node 状态按钮，选择「配对」。</p>
          <p v-else-if="!store.hosts.length">暂无保存的主机，在「会话」列表空白处右键选择「新建连接」添加。</p>
          <p v-else>选择左侧主机（支持 Ctrl/Shift 多选），或右键批量操作。</p>
        </div>
      </div>
    </div>
    <div class="statusbar">
      <NodeStatusMenu />
      <BottomPanelStatusButton />
      <div class="statusbar-end">
        <EncodingStatusItem />
        <TransferStatusItem />
      </div>
    </div>
    <PairingView v-if="store.pairingModalOpen" />
    <HostFormView v-if="store.connectionModalOpen" />
    <LoginDialog v-if="store.loginDialogOpen" />
    <TerminalSessionInfo v-if="store.terminalSessionInfo?.open" />
    <ManualPasteDialog v-if="store.manualPaste?.open" />
    <EncodingPickerDialog v-if="store.encodingPicker" />
    <HostKeyPrompt />
    <ConnectionsDeleteConfirm v-if="store.deleteNodeConfirmOpen" />
    <FolderDialog v-if="store.folderModalOpen" />
    <SettingsDialog v-if="store.settingsModalOpen" />
    <AboutDialog v-if="store.aboutModalOpen" />
    <DirtyCloseDialog />
    <InteractionDialog />
  </div>
</template>

<style>
html, body, #app {
  margin: 0;
  padding: 0;
  height: 100%;
  overflow: hidden;
  background: #1e1e1e;
  color: #cccccc;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 13px;
}

button, input {
  font-family: inherit;
}

::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

::-webkit-scrollbar-track {
  background: #1e1e1e;
}

::-webkit-scrollbar-thumb {
  background: #424242;
  border-radius: 5px;
}

::-webkit-scrollbar-thumb:hover {
  background: #4f4f4f;
}

::-webkit-scrollbar-corner {
  background: #1e1e1e;
}

* {
  scrollbar-width: thin;
  scrollbar-color: #424242 #1e1e1e;
}
</style>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
}

.global-error {
  background: #ef4444;
  color: #fff;
  padding: 8px 12px;
  font-size: 13px;
  text-align: center;
  flex-shrink: 0;
  z-index: 100;
}

.main {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.activity {
  box-sizing: border-box;
  width: 48px;
  background: #333333;
  display: flex;
  flex-direction: column;
  align-items: center;
  border-right: 1px solid #252526;
  flex-shrink: 0;
  gap: 0;
}

.top-icons {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0;
  width: 100%;
  align-items: center;
}

.activity-bottom {
  width: 100%;
  flex: 0 0 auto;
  display: flex;
  justify-content: center;
}

.activity .icon {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #858585;
  cursor: pointer;
  user-select: none;
}

.activity .icon:hover {
  color: #fff;
}

.activity .icon.active {
  color: #fff;
  background: #37373d;
  border-left: 2px solid #fff;
}

.sidebar {
  box-sizing: border-box;
  background: #252526;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #1f1f1f;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}

.sidebar.primary-sidebar {
  width: var(--sidebar-width, 220px);
  min-width: 160px;
}

.sidebar.collapsed {
  width: 0;
  min-width: 0;
  flex-basis: 0;
  border-right: none;
}

.sidebar.collapsed > * {
  display: none;
}

.panel-resizer {
  box-sizing: border-box;
  flex: 0 0 8px;
  width: 8px;
  margin: 0 -4px;
  position: relative;
  z-index: 30;
  align-self: stretch;
  cursor: col-resize;
  touch-action: none;
  user-select: none;
}

.panel-resizer::before {
  content: '';
  position: absolute;
  inset: 0;
  background: transparent;
  transition: background 0.12s ease;
}

.panel-resizer:hover::before,
.panel-resizer.dragging::before {
  background: rgba(74, 170, 255, 0.42);
}

.main.resizing {
  user-select: none;
}

.terminal-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #1e1e1e;
  overflow: hidden;
}

.shell-workspace {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.shell-workspace.bottom-panel-maximized .main-dock-container {
  visibility: hidden;
  pointer-events: none;
}

.main-dock-container {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.welcome {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #888;
  gap: 0.5rem;
}

.welcome-logo {
  width: 64px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border-radius: 12px;
  overflow: hidden;
}

.welcome-logo img {
  width: 100%;
  height: 100%;
  display: block;
}

.welcome h2 {
  margin: 0;
  color: #4aaaff;
  font-weight: 600;
}

.welcome p {
  margin: 0;
  font-size: 13px;
  text-align: center;
  max-width: 320px;
}

.statusbar {
  height: 24px;
  background: #1e1e1e;
  border-top: 1px solid #1f1f1f;
  display: flex;
  align-items: center;
  color: #fff;
  font-size: 12px;
  flex-shrink: 0;
}

.statusbar-end {
  margin-left: auto;
  display: flex;
  align-items: center;
  height: 100%;
  min-width: 0;
}

</style>
