<script setup lang="ts">
import { ref } from 'vue'
import type { Terminal } from '@xterm/xterm'
import { store } from '../stores/app'
import UiDialog from './UiDialog.vue'

const text = ref('')

function getTerminal(): Terminal | undefined {
  return store.manualPaste?.context?.terminal
}

function onPaste(event: ClipboardEvent) {
  const pasted = event.clipboardData?.getData('text')
  if (pasted != null) {
    event.preventDefault()
    text.value = pasted
  }
}

function submit() {
  const terminal = getTerminal()
  if (terminal && text.value) {
    terminal.paste(text.value)
  }
  close()
}

function close() {
  store.manualPaste = null
  text.value = ''
}
</script>

<template>
  <UiDialog
    :open="true"
    title="手动粘贴"
    description="剪贴板不可用时，请在下方输入要粘贴到终端的文本。"
    width="520px"
    @close="close"
  >
    <textarea v-model="text" class="paste-input" rows="6" @paste="onPaste" />

    <template #actions>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--default" @click="close">取消</button>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--primary" :disabled="!text" @click="submit">粘贴到终端</button>
    </template>
  </UiDialog>
</template>

<style scoped>
.paste-input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--workbench-space-2);
  border: 1px solid var(--workbench-border);
  border-radius: 4px;
  background: var(--workbench-input-bg);
  color: var(--workbench-text);
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  resize: vertical;
}

.workbench-dialog-button:disabled {
  background: var(--workbench-border);
  color: var(--workbench-text-muted);
  cursor: default;
}
</style>
