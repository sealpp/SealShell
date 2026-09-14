<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { store } from '../stores/app'
import { settleInteractionDialog } from '../services/dialogs'
import UiDialog from './UiDialog.vue'

const input = ref('')
const applyAll = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

watch(() => store.interactionDialog, async (dialog) => {
  input.value = dialog?.value ?? ''
  applyAll.value = false
  if (dialog?.kind === 'prompt') {
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  }
})

function close(): void {
  const dialog = store.interactionDialog
  settleInteractionDialog(dialog?.kind === 'confirm' && dialog.checkboxLabel ? { confirmed: false, checked: applyAll.value } : null)
}
function confirm(): void {
  const dialog = store.interactionDialog
  if (!dialog) return
  if (dialog.kind === 'prompt') settleInteractionDialog(input.value)
  else settleInteractionDialog(dialog.checkboxLabel ? { confirmed: true, checked: applyAll.value } : dialog.kind === 'confirm')
}
</script>

<template>
  <UiDialog
    v-if="store.interactionDialog"
    :open="true"
    :title="store.interactionDialog.title"
    width="420px"
    @close="close"
  >
    <p v-if="store.interactionDialog.message" class="message">{{ store.interactionDialog.message }}</p>
    <input
      v-if="store.interactionDialog.kind === 'prompt'"
      ref="inputEl"
      v-model="input"
      class="prompt-input"
      :placeholder="store.interactionDialog.placeholder"
      aria-label="输入值"
      @keydown.enter.prevent="confirm"
    >
    <label v-if="store.interactionDialog.checkboxLabel" class="checkbox-row">
      <input v-model="applyAll" type="checkbox" />
      <span>{{ store.interactionDialog.checkboxLabel }}</span>
    </label>
    <template #actions>
      <button
        v-if="store.interactionDialog.kind !== 'alert'"
        type="button"
        class="workbench-dialog-button workbench-dialog-button--default"
        @click="close"
      >
        {{ store.interactionDialog.cancelLabel }}
      </button>
      <button
        type="button"
        :class="['workbench-dialog-button', store.interactionDialog.danger ? 'workbench-dialog-button--danger' : 'workbench-dialog-button--primary']"
        @click="confirm"
      >
        {{ store.interactionDialog.confirmLabel }}
      </button>
    </template>
  </UiDialog>
</template>

<style scoped>
.message{margin:0;color:var(--workbench-text);line-height:1.6;white-space:pre-wrap;word-break:break-word}.prompt-input{box-sizing:border-box;width:100%;height:32px;margin-top:12px;padding:0 9px;border:1px solid #555;background:#1e1e1e;color:#eee;outline:none}.prompt-input:focus{border-color:#3794ff}.checkbox-row{display:flex;align-items:center;gap:6px;margin-top:12px;color:var(--workbench-text);font-size:12px;cursor:pointer}.checkbox-row input{margin:0;cursor:pointer}
</style>
