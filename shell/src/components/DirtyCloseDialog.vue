<script setup lang="ts">
import { ref } from 'vue'
import { store } from '../stores/app'
import { closeTabs } from '../services/ws'
import { saveEditorTab } from '../services/sftp/editor-tabs'
import UiDialog from './UiDialog.vue'

const saving = ref(false)
const error = ref('')

function close(): void {
  if (saving.value) return
  error.value = ''
  store.dirtyCloseConfirm = null
}

function discard(): void {
  const pending = store.dirtyCloseConfirm
  if (!pending || saving.value) return
  const remainingTabIds = pending.remainingTabIds
  store.dirtyCloseConfirm = null
  closeTabs([pending.tabId], true)
  if (remainingTabIds.length) closeTabs(remainingTabIds)
}

async function saveAndClose(): Promise<void> {
  const pending = store.dirtyCloseConfirm
  if (!pending || saving.value) return
  const remainingTabIds = pending.remainingTabIds
  saving.value = true
  error.value = ''
  try {
    await saveEditorTab(pending.tabId)
    store.dirtyCloseConfirm = null
    closeTabs([pending.tabId], true)
    if (remainingTabIds.length) closeTabs(remainingTabIds)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <UiDialog
    v-if="store.dirtyCloseConfirm"
    :open="true"
    title="文件有未保存修改"
    width="420px"
    :show-close="!saving"
    @close="close"
  >
    <p class="message">“{{ store.dirtyCloseConfirm.path }}” 已被修改，关闭前是否保存？</p>
    <p v-if="error" class="error">保存失败：{{ error }}</p>
    <template #actions>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--default" :disabled="saving" @click="close">取消</button>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--danger" :disabled="saving" @click="discard">不保存</button>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--primary" :disabled="saving" @click="saveAndClose">{{ saving ? '保存中…' : '保存并关闭' }}</button>
    </template>
  </UiDialog>
</template>

<style scoped>
.message{margin:0;color:var(--workbench-text);line-height:1.6;word-break:break-word}.error{margin:10px 0 0;color:var(--workbench-error);word-break:break-word}
</style>
