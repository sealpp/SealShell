<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { editor } from 'monaco-editor/editor/editor.api'
import { IconDeviceFloppy, IconSearch, IconX } from '@tabler/icons-vue'
import ProxyErrorAction from '../components/ProxyErrorAction.vue'
import { setBottomPanelActiveTab, store, type EditorTab } from '../stores/app'
import { saveEditorTab } from '../services/sftp/editor-tabs'
import { alertDialog } from '../services/dialogs'
import { commandService } from '../services/commands'
import type { getEditorDocument } from '../services/editor/documents'

const props = defineProps<{ params: { params: { tabId: string; [key: string]: unknown }; [key: string]: unknown } }>()
const tabId = computed(() => String(props.params?.params?.tabId ?? ''))
const tab = computed(() => store.tabs.find((candidate): candidate is EditorTab => candidate.id === tabId.value && candidate.kind === 'editor'))
const editorEl = ref<HTMLDivElement | null>(null)
const loading = ref(false)
const loadError = ref('')
const ready = ref(false)
const saving = ref(false)
let view: editor.IStandaloneCodeEditor | undefined
let document: ReturnType<typeof getEditorDocument> | undefined
let disposed = false

function focusPane(): void { setBottomPanelActiveTab(tabId.value, 'editors') }
async function mountEditor(): Promise<void> {
  const current = tab.value
  if (!current || current.state !== 'online' || !editorEl.value || view || loading.value) return
  loading.value = true
  loadError.value = ''
  try {
    const { monaco, getEditorDocument } = await import('../services/editor/documents')
    if (disposed || !editorEl.value || tab.value !== current || current.state !== 'online') return
    document = getEditorDocument(current)
    view = monaco.editor.create(editorEl.value, {
      model: document.model,
      theme: 'vs-dark',
      automaticLayout: true,
      fontFamily: 'Consolas, "Cascadia Mono", "SFMono-Regular", monospace',
      fontSize: 13,
      lineHeight: 20,
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
      minimap: { enabled: false },
      stickyScroll: { enabled: false },
      folding: true,
      guides: { indentation: true, bracketPairs: true },
      matchBrackets: 'always',
      renderLineHighlight: 'line',
      wordWrap: document.wordWrap,
      scrollBeyondLastLine: false,
      padding: { top: 8, bottom: 8 },
      quickSuggestions: false,
      wordBasedSuggestions: 'off',
      suggestOnTriggerCharacters: false,
      'semanticHighlighting.enabled': false,
      ariaLabel: `文件内容：${current.label}`,
    })
    if (document.viewState) view.restoreViewState(document.viewState)
    view.onDidFocusEditorText(focusPane)
    view.addAction({ id: 'sealshell.save', label: '保存文件', keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS], run: save })
    view.addAction({ id: 'sealshell.toggleWordWrap', label: '切换自动换行', keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyZ], run: () => {
      document!.wordWrap = document!.wordWrap === 'on' ? 'off' : 'on'
      view!.updateOptions({ wordWrap: document!.wordWrap })
    } })
    ready.value = true
  } catch (error) { loadError.value = error instanceof Error ? error.message : String(error) }
  finally { loading.value = false }
}

async function save(): Promise<void> {
  if (!tab.value?.editor.dirty || saving.value) return
  saving.value = true
  try { await saveEditorTab(tabId.value) }
  catch (error) { await alertDialog('保存失败', error instanceof Error ? error.message : String(error)) }
  finally { saving.value = false }
}
function openFind(): void { view?.focus(); void view?.getAction('actions.find')?.run() }

watch([() => tab.value?.state, editorEl], () => { void mountEditor() }, { flush: 'post' })
onBeforeUnmount(() => {
  disposed = true
  if (view && document && !document.model.isDisposed()) document.viewState = view.saveViewState()
  view?.dispose()
  view = undefined
  document = undefined
})
</script>

<template>
  <section v-if="tab" class="editor-panel" :data-editor-tab="tabId" @pointerdown="focusPane" @focusin="focusPane">
    <header class="editor-toolbar workbench-list-toolbar">
      <span class="editor-title" :title="tab.editor.path">{{ tab.label }}{{ tab.editor.dirty ? ' *' : '' }}</span>
      <span class="editor-path" :title="tab.editor.path">{{ tab.editor.path }}</span>
      <button type="button" title="查找/替换" :disabled="!ready" @click="openFind"><IconSearch :size="16" /></button>
      <button type="button" :title="saving ? '正在保存' : '保存'" :disabled="!tab.editor.dirty || saving" @click="save"><IconDeviceFloppy :size="16" /></button>
      <button type="button" title="关闭" @click="commandService.execute('tab.close', { area: 'tab', tabId })"><IconX :size="16" /></button>
    </header>
    <div v-if="tab.error" class="editor-error" role="alert">{{ tab.error }} <ProxyErrorAction :source="tab.proxySource" :message="tab.error" /></div>
    <div v-if="loadError" class="editor-error" role="alert">编辑器加载失败：{{ loadError }} <button class="workbench-list-action" @click="mountEditor">重试</button></div>
    <div v-else-if="loading || tab.state === 'connecting'" class="editor-loading" role="status">{{ loading ? '正在加载编辑器…' : '正在读取文件…' }}</div>
    <div ref="editorEl" class="editor-host" />
  </section>
</template>

<style scoped>
.editor-panel { width: 100%; height: 100%; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: var(--workbench-bg); color: var(--workbench-text); font: 400 var(--workbench-font-size)/20px var(--workbench-font-family); }
.editor-toolbar { flex-wrap: nowrap; }
.editor-title { color: var(--workbench-text-strong); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 40%; }
.editor-path { flex: 1; min-width: 0; color: var(--workbench-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.editor-toolbar button { width: 26px; padding: 0; }
.editor-host { min-height: 0; min-width: 0; flex: 1; overflow: hidden; }
/* Keep Monaco's measured hover size after positioning near a pane edge. Shrinking
   it there wraps the label, increases its height and covers the hovered button. */
.editor-host :deep(.workbench-hover-container) { width: max-content; }
.editor-error { padding: 8px 12px; color: #f48771; }
.editor-loading { padding: 8px 12px; color: var(--workbench-text-muted); }
</style>
