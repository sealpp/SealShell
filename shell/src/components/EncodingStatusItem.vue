<script setup lang="ts">
import { computed } from 'vue'
import { getActiveBottomPanelTabId, store, type EditorTab } from '../stores/app'
import { encodingShort } from '../services/encodings'

// The bottom panel only counts as focused while it is visible; once closed,
// focus falls back to the active terminal tab.
const tab = computed(() => {
  const tabId = store.focusedDock === 'bottomPanel' && store.bottomPanelOpen
    ? getActiveBottomPanelTabId()
    : store.activeTerminalTabId
  return store.tabs.find((item) => item.id === tabId)
})

const editorTab = computed(() => (tab.value?.kind === 'editor' ? (tab.value as EditorTab) : undefined))
const visible = computed(() => !!tab.value && tab.value.kind !== 'file')

const encodingText = computed(() => {
  const target = tab.value
  if (!target) return ''
  if (editorTab.value) {
    const short = encodingShort(editorTab.value.editor.encoding)
    return editorTab.value.editor.bom ? `${short} with BOM` : short
  }
  return encodingShort(target.encoding)
})

const lineEndingText = computed(() => {
  const ending = editorTab.value?.editor.lineEnding
  return ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : 'LF'
})

function openPicker(): void {
  const target = tab.value
  if (!target) return
  store.encodingPicker = { tabId: target.id }
}
</script>

<template>
  <div v-if="visible && tab" class="statusbar-right">
    <template v-if="editorTab">
      <span v-if="editorTab.state === 'error'" class="statusbar-error">{{ editorTab.error }}</span>
      <span class="statusbar-text">{{ lineEndingText }}</span>
      <span class="statusbar-text">{{ editorTab.editor.size }} bytes</span>
    </template>
    <button
      type="button"
      class="workspace-status"
      title="选择编码"
      @click="openPicker"
    >
      <span>{{ encodingText }}</span>
    </button>
  </div>
</template>

<style scoped>
.statusbar-right {
  display: inline-flex;
  align-items: center;
  height: 100%;
}

.statusbar-text {
  padding: 0 10px;
  color: #aaa;
  font-size: 12px;
}

.statusbar-error {
  padding: 0 10px;
  color: #f87171;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40vw;
}

.workspace-status {
  height: 100%;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: #aaa;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.workspace-status:hover {
  background: #3c3c3c;
  color: #fff;
}
</style>
