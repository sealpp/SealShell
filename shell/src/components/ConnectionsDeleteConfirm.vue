<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../stores/app'
import { buildVisibleNodes, nodeKey, parseNodeKey } from '../services/connectionTree'
import { deleteFolders, deleteHosts } from '../services/ws'
import UiAlertDialog from './UiAlertDialog.vue'

const allExpanded = computed(() => new Set(store.folders.map((folder) => folder.id)))

const names = computed(() => {
  const wanted = new Set(store.deleteNodeKeys)
  return buildVisibleNodes(store.folders, store.hosts, allExpanded.value)
    .filter((node) => wanted.has(nodeKey(node.kind, node.id)))
    .map((node) => node.label)
})

const hasFolder = computed(() => store.deleteNodeKeys.some((key) => key.startsWith('folder:')))

function close() {
  store.deleteNodeConfirmOpen = false
  store.deleteNodeKeys = []
}

async function confirm() {
  const folderIds: string[] = []
  const hostIds: string[] = []
  for (const key of store.deleteNodeKeys) {
    const parsed = parseNodeKey(key)
    if (!parsed) continue
    if (parsed.kind === 'folder') folderIds.push(parsed.id)
    else hostIds.push(parsed.id)
  }
  await deleteFolders(folderIds)
  await deleteHosts(hostIds)
  close()
}
</script>

<template>
  <UiAlertDialog
    :open="true"
    :title="`删除 ${names.length} 项`"
    width="360px"
    action-label="删除"
    @close="close"
    @confirm="confirm"
  >
    <p v-if="hasFolder" class="warning">文件夹及其中的主机配置和凭据将被一并删除。</p>
    <ul class="node-list">
      <li v-for="name in names" :key="name">{{ name }}</li>
    </ul>
    <p class="hint">删除后不可恢复，是否继续？</p>
    <p v-if="store.error" class="error">{{ store.error }}</p>
  </UiAlertDialog>
</template>

<style scoped>
.warning {
  margin: 0 0 var(--workbench-space-2);
  color: #f59e0b;
  font-size: 12px;
}

.node-list {
  max-height: 120px;
  margin: 0 0 var(--workbench-space-3);
  padding-left: 1.25rem;
  overflow-y: auto;
  color: var(--workbench-text);
  font-size: 13px;
}

.hint {
  margin: 0;
  color: var(--workbench-text-muted);
  font-size: 12px;
}

.error {
  margin: var(--workbench-space-2) 0 0;
  color: #f87171;
  font-size: 12px;
}
</style>
