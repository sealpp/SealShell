<script setup lang="ts">
import { computed } from 'vue'
import { DropdownMenuLabel } from 'reka-ui'
import CommandDropdownMenu from './CommandDropdownMenu.vue'
import { store } from '../stores/app'
import { MenuId } from '../services/actions/menuIds'
import type { CommandContext } from '../services/context'

const nodeStatusLabels = {
  unpaired: '未配对',
  connected: '已连接',
  disconnected: '未连接',
}

const nodeStatus = computed(() => {
  if (!store.paired) return 'unpaired'
  return store.nodeConnected ? 'connected' : 'disconnected'
})

const nodeContext = computed<CommandContext>(() => ({
  area: 'node',
  isPaired: store.paired,
}))
</script>

<template>
  <CommandDropdownMenu
    :menu-id="MenuId.NodeStatus"
    :context="nodeContext"
    content-class="node-menu"
    side="top"
    align="start"
    item-class="menu-item"
  >
    <template #trigger>
      <button
        type="button"
        class="node-status"
        :class="nodeStatus"
        :title="`本地 Node：${nodeStatusLabels[nodeStatus]}`"
        :aria-label="`本地 Node：${nodeStatusLabels[nodeStatus]}`"
      >
        <i class="codicon codicon-remote" aria-hidden="true" />
      </button>
    </template>

    <template #before><DropdownMenuLabel class="menu-header">Node 操作</DropdownMenuLabel></template>
  </CommandDropdownMenu>
</template>

<style scoped>
.node-status {
  height: 100%;
  display: flex;
  align-items: center;
  padding: 0 var(--workbench-space-3);
  border: 0;
  background: var(--workbench-border);
  color: var(--workbench-text);
  cursor: pointer;
  user-select: none;
  font: inherit;
}

.node-status:hover {
  filter: brightness(1.1);
}

.node-status.connected {
  background: var(--workbench-accent);
  color: var(--workbench-text-strong);
}

.node-status.disconnected {
  background: var(--vscode-inputValidation-errorBackground);
  color: var(--workbench-error);
}

.node-status .codicon {
  font-size: 14px;
}

</style>
