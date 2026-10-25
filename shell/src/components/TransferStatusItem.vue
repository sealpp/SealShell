<script setup lang="ts">
import { computed } from 'vue'
import { IconAlertTriangle, IconArrowsUpDown, IconCheck, IconCircleMinus, IconClock, IconLoader2 } from '@tabler/icons-vue'
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui'
import { transferRuntime } from '../services/sftp/transfer-runtime'
import TransferPanel from '../views/TransferPanel.vue'
import { usePortalTarget } from '../ui/portal'

const portalTarget = usePortalTarget()
const preview = computed(() => {
  const tasks = transferRuntime.tasks
  const running = tasks.filter((task) => task.state === 'running')
  const queued = tasks.filter((task) => task.state === 'queued').length
  const completed = tasks.filter((task) => task.state === 'completed').length
  const cancelled = tasks.filter((task) => task.state === 'cancelled').length
  const failed = tasks.filter((task) => task.state === 'failed').length
  const orphans = tasks.filter((task) => task.orphanPath).length
  const attention = tasks.filter((task) => task.state === 'failed' || task.orphanPath).length
  const parts = ['传输']
  if (running.length === 1) parts.push(`${Math.floor(running[0].progress * 100)}%`)
  else if (running.length > 1) parts.push(`${running.length} 项进行中`)
  if (queued) parts.push(`等待 ${queued}`)
  if (attention) parts.push(`需处理 ${attention}`)
  else if (!running.length && !queued) {
    if (cancelled) parts.push(`已取消 ${cancelled}`)
    else if (completed) parts.push(`已完成 ${completed}`)
  }
  const details = tasks.length ? [
    `进行中 ${running.length} · 等待 ${queued} · 已完成 ${completed}`,
    ...(failed ? [`失败 ${failed}`] : []),
    ...(cancelled ? [`已取消 ${cancelled}`] : []),
    ...(orphans ? [`保留文件 ${orphans}，请在详情中处理`] : []),
    ...(running.length === 1 ? [running[0].label] : []),
  ] : ['暂无传输任务']
  const icon = running.length ? IconLoader2 : attention ? IconAlertTriangle : queued ? IconClock
    : cancelled ? IconCircleMinus : completed ? IconCheck : IconArrowsUpDown
  return { text: parts.join(' · '), title: [...details, '点击查看传输详情'].join('\n'), icon, busy: running.length > 0, attention }
})
</script>

<template>
  <PopoverRoot v-model:open="transferRuntime.panelOpen">
    <PopoverTrigger as-child>
      <button type="button" class="transfer-status" :class="{ active: transferRuntime.panelOpen, attention: preview.attention }" aria-label="传输详情" :aria-description="preview.text" :title="preview.title">
        <component :is="preview.icon" :size="14" :class="{ spinning: preview.busy }" aria-hidden="true" />
        <span>{{ preview.text }}</span>
        <IconAlertTriangle v-if="preview.busy && preview.attention" :size="14" aria-hidden="true" />
      </button>
    </PopoverTrigger>
    <PopoverPortal :to="portalTarget">
      <PopoverContent class="transfer-popover" side="top" align="end" :side-offset="6" :collision-padding="8">
        <TransferPanel />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style scoped>
.transfer-status{height:100%;display:inline-flex;flex:none;align-items:center;gap:5px;padding:0 10px;border:0;background:transparent;color:var(--workbench-text-muted);cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
.transfer-status:hover,.transfer-status.active{background:var(--vscode-statusBarItem-hoverBackground);color:var(--workbench-text-strong)}.transfer-status:focus-visible{outline:1px solid var(--workbench-accent);outline-offset:-1px}.transfer-status.attention{color:var(--workbench-warning)}
.transfer-popover{z-index:60;outline:none;max-width:calc(100vw - 16px)}
.spinning{animation:transfer-spin 1s linear infinite}@keyframes transfer-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>
