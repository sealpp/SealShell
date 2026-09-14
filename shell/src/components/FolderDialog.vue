<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { store } from '../stores/app'
import UiDialog from './UiDialog.vue'
import { saveNewFolder, saveRenamedFolder } from '../services/folderCommands'

const name = ref('')
const error = ref('')
const saving = ref(false)
const inputEl = ref<HTMLInputElement | null>(null)

const isNew = computed(() => !store.editingFolderId)
const title = computed(() => isNew.value ? '新建文件夹' : '重命名文件夹')

watch(() => store.folderModalOpen, async (open) => {
  if (!open) return
  const folder = store.folders.find((item) => item.id === store.editingFolderId)
  name.value = folder?.name ?? ''
  error.value = ''
  saving.value = false
  await nextTick()
  inputEl.value?.focus()
  inputEl.value?.select()
}, { immediate: true })

function close() {
  store.folderModalOpen = false
  store.editingFolderId = ''
  store.folderParentId = null
  error.value = ''
}

function hasDuplicate(value: string): boolean {
  return store.folders.some((folder) => {
    if (folder.id === store.editingFolderId) return false
    if (folder.parentId !== store.folderParentId) return false
    return folder.name.trim() === value
  })
}

async function submit() {
  const value = name.value.trim()
  if (!value) {
    error.value = '文件夹名称不能为空'
    return
  }
  if (hasDuplicate(value)) {
    error.value = '同级已存在同名文件夹'
    return
  }
  saving.value = true
  try {
    if (isNew.value) await saveNewFolder(value)
    else await saveRenamedFolder(value)
    close()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
    saving.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault()
    void submit()
  }
}
</script>

<template>
  <UiDialog :open="true" :title="title" width="380px" @close="close">
    <div class="folder-form">
      <label for="folder-name">名称</label>
      <input
        id="folder-name"
        ref="inputEl"
        v-model="name"
        autocomplete="off"
        placeholder="文件夹名称"
        @keydown="onKeydown"
      />
      <p v-if="error" class="error">{{ error }}</p>
    </div>
    <template #actions>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--default" @click="close">取消</button>
      <button type="button" class="workbench-dialog-button workbench-dialog-button--primary" :disabled="saving" @click="submit">确认</button>
    </template>
  </UiDialog>
</template>

<style scoped>
.folder-form label {
  display: block;
  margin-bottom: var(--workbench-space-1);
  color: var(--workbench-text-muted);
  font-size: 12px;
}

.folder-form input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--workbench-space-2);
  border: 1px solid var(--workbench-border);
  border-radius: 4px;
  background: var(--workbench-input-bg);
  color: var(--workbench-text);
  font-size: 13px;
}

.error {
  margin: var(--workbench-space-2) 0 0;
  color: #f87171;
  font-size: 12px;
}
</style>
