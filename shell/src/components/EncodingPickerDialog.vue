<script setup lang="ts">
import { IconCheck } from '../ui/icons'
import { computed, nextTick, ref, watch } from 'vue'
import UiDialog from './UiDialog.vue'
import { store, type EditorTab } from '../stores/app'
import { ENCODINGS } from '../services/encodings'
import { setTerminalEncoding } from '../services/terminalCommands'
import { reopenEditorTab, setEditorEncoding } from '../services/sftp/editor-tabs'
import { alertDialog } from '../services/dialogs'
import { fuzzyScore } from '../utils/fuzzy'

interface PickItem {
  key: string
  label: string
  detail?: string
  bom?: boolean
}

const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const activeIndex = ref(0)
const stage = ref<'action' | 'encoding'>('encoding')
const action = ref<'reopen' | 'save'>('reopen')

const tab = computed(() => store.tabs.find((item) => item.id === store.encodingPicker?.tabId))
const isEditor = computed(() => tab.value?.kind === 'editor')

watch(
  () => store.encodingPicker,
  async (picker) => {
    if (!picker) return
    const target = store.tabs.find((item) => item.id === picker.tabId)
    if (!target) {
      store.encodingPicker = null
      return
    }
    query.value = ''
    action.value = 'reopen'
    stage.value = target.kind === 'editor' ? 'action' : 'encoding'
    await nextTick()
    inputEl.value?.focus()
  },
  { immediate: true },
)

const items = computed<PickItem[]>(() => {
  if (isEditor.value && stage.value === 'action') {
    return [
      { key: 'reopen', label: '以该编码重新打开', detail: 'Reopen with Encoding' },
      { key: 'save', label: '以该编码保存', detail: 'Save with Encoding' },
    ]
  }
  if (isEditor.value && action.value === 'save') {
    return [
      { key: 'utf-8', label: 'UTF-8' },
      { key: 'utf-8-bom', label: 'UTF-8 with BOM', bom: true },
    ]
  }
  return ENCODINGS.map((entry) => ({ key: entry.id, label: entry.label, detail: entry.short }))
})

const filtered = computed(() => {
  const text = query.value.trim()
  if (!text) return items.value
  return items.value
    .map((item) => ({ item, score: fuzzyScore(text, `${item.label} ${item.key}`) }))
    .filter((entry): entry is { item: PickItem; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
})

const currentKey = computed(() => {
  const target = tab.value
  if (!target) return ''
  if (target.kind === 'editor') {
    const editor = (target as EditorTab).editor
    if (stage.value === 'encoding' && action.value === 'save') {
      return editor.encoding === 'utf-8' && editor.bom ? 'utf-8-bom' : 'utf-8'
    }
    return editor.encoding
  }
  return target.encoding
})

watch([filtered, stage], () => {
  const current = filtered.value.findIndex((item) => item.key === currentKey.value)
  activeIndex.value = current >= 0 ? current : 0
}, { immediate: true })

const placeholder = computed(() => {
  if (isEditor.value && stage.value === 'action') return '选择要执行的操作'
  if (isEditor.value && action.value === 'save') return '选择用于保存的编码'
  if (isEditor.value) return '选择用于重新打开的编码'
  return '选择终端编码'
})

function close(): void {
  store.encodingPicker = null
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % Math.max(filtered.value.length, 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = (activeIndex.value - 1 + filtered.value.length) % Math.max(filtered.value.length, 1)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const item = filtered.value[activeIndex.value]
    if (item) void confirm(item)
  }
}

async function confirm(item: PickItem): Promise<void> {
  const target = tab.value
  if (!target) return close()
  if (isEditor.value && stage.value === 'action') {
    action.value = item.key as 'reopen' | 'save'
    stage.value = 'encoding'
    query.value = ''
    await nextTick()
    inputEl.value?.focus()
    return
  }
  close()
  if (target.kind === 'terminal') {
    setTerminalEncoding(target.id, item.key)
  } else if (target.kind === 'editor' && action.value === 'save') {
    setEditorEncoding(target.id, 'utf-8', item.bom === true)
  } else if (target.kind === 'editor') {
    try {
      await reopenEditorTab(target.id, item.key)
    } catch (error) {
      await alertDialog('重新打开失败', error instanceof Error ? error.message : String(error))
    }
  }
}
</script>

<template>
  <UiDialog :open="true" title="选择编码" width="480px" content-class="encoding-picker" @close="close">
    <input
      ref="inputEl"
      v-model="query"
      class="picker-input"
      type="text"
      :placeholder="placeholder"
      @keydown="onKeydown"
    />
    <ul class="picker-list" role="listbox">
      <li
        v-for="(item, index) in filtered"
        :key="item.key"
        class="picker-item"
        :class="{ active: index === activeIndex }"
        role="option"
        :aria-selected="index === activeIndex"
        @click="confirm(item)"
        @mousemove="activeIndex = index"
      >
        <span class="picker-check"><IconCheck v-if="item.key === currentKey" /></span>
        <span class="picker-label">{{ item.label }}</span>
        <span v-if="item.detail" class="picker-detail">{{ item.detail }}</span>
      </li>
      <li v-if="!filtered.length" class="picker-empty">无匹配编码</li>
    </ul>
  </UiDialog>
</template>

<style scoped>
.picker-input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--workbench-space-2);
  border: 1px solid var(--workbench-border);
  border-radius: 4px;
  background: var(--workbench-input-bg);
  color: var(--workbench-text);
  font-size: 13px;
  outline: none;
}

.picker-input:focus {
  border-color: var(--workbench-accent-hover);
}

.picker-list {
  margin: 8px 0 0;
  padding: 0;
  max-height: 320px;
  overflow-y: auto;
  list-style: none;
}

.picker-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  box-sizing: border-box;
  padding: 0 8px;
  border-radius: 0;
  color: var(--workbench-text);
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.picker-item.active {
  background: var(--workbench-list-active-bg);
  color: var(--workbench-text-strong);
}

.picker-check {
  width: 16px;
  flex: 0 0 16px;
  color: var(--workbench-link);
}

.picker-item.active .picker-check {
  color: var(--workbench-text-strong);
}

.picker-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-detail {
  color: var(--workbench-text-muted);
  font-size: 11px;
}

.picker-item.active .picker-detail {
  color: var(--vscode-list-activeSelectionForeground);
}

.picker-empty {
  padding: 8px;
  color: var(--workbench-text-muted);
  font-size: 12px;
}
</style>
