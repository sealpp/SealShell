<script setup lang="ts">
import { computed } from 'vue'
import { IconFolder, IconChartLine } from '@tabler/icons-vue'
import { commandService } from '../services/commands'
import { store } from '../stores/app'

const filesOpen = computed(() => store.bottomPanelOpen && store.bottomPanelCategory !== 'monitors')
const monitorsOpen = computed(() => store.bottomPanelOpen && store.bottomPanelCategory === 'monitors')
const count = computed(() => store.tabs.filter(tab => tab.kind === 'monitor').length)
</script>

<template>
  <button
    type="button"
    class="workspace-status"
    :class="{ active: filesOpen }"
    :aria-pressed="filesOpen"
    :title="filesOpen ? '隐藏文件管理' : '显示文件管理'"
    @click="commandService.execute('workbench.toggleFileManager', { area: 'global' })"
  >
    <IconFolder :size="14" aria-hidden="true" />
    <span>文件管理</span>
  </button>
  <button type="button" class="workspace-status" :class="{ active: monitorsOpen, monitoring: count > 0 }"
    :aria-pressed="monitorsOpen" :aria-label="`性能监测 ${count}`"
    :title="`${monitorsOpen ? '隐藏' : '显示'}性能监测 · ${count} 个实例`"
    @click="commandService.execute('workbench.toggleMonitoring', { area: 'global' })">
    <IconChartLine :size="14" aria-hidden="true" /><span>性能监测</span><span class="monitor-count">{{ count }}</span>
  </button>
</template>

<style scoped>
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

.workspace-status:hover,
.workspace-status.active {
  background: #3c3c3c;
  color: #fff;
}
.workspace-status.monitoring { color: #ccc; }
.monitor-count { min-width: 13px; text-align: center; font-variant-numeric: tabular-nums; }
</style>
