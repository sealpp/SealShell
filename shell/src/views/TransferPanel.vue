<script setup lang="ts">
import ProxyErrorAction from '../components/ProxyErrorAction.vue'
import { IconRefresh, IconTrash, IconX } from '../ui/icons'
import { PopoverClose } from 'reka-ui'
import type { TransferTaskState } from '../services/sftp/transfer'
import { transferRuntime, cancelTransfer, dismissTransfer, retryTransfer, setTransferConcurrency } from '../services/sftp/transfer-runtime'

const stateLabels: Record<TransferTaskState, string> = { queued: '等待中', running: '传输中', completed: '已完成', failed: '失败', cancelled: '已取消' }
</script>

<template>
  <aside class="transfer-panel">
    <header><strong>传输详情</strong><PopoverClose as-child><button type="button" title="关闭传输详情" aria-label="关闭传输详情"><IconX :size="16" /></button></PopoverClose></header>
    <label>并发<select :value="transferRuntime.concurrency" @change="setTransferConcurrency(Number(($event.target as HTMLSelectElement).value))"><option v-for="value in [1, 2, 3, 4]" :key="value" :value="value">{{ value }}</option></select></label>
    <div class="transfer-task-list">
    <div v-if="!transferRuntime.tasks.length" class="transfer-empty">暂无传输任务</div>
    <div v-for="task in transferRuntime.tasks" :key="task.id" class="transfer-task">
      <div class="task-head"><span :title="task.label">{{ task.label }}</span><span>{{ stateLabels[task.state] }}<template v-if="task.state === 'running'"> {{ Math.floor(task.progress * 100) }}%</template></span></div>
      <progress max="1" :value="task.progress" :aria-label="task.label" />
      <div v-if="task.error" class="task-error">{{ task.error }} <ProxyErrorAction :source="task.proxySource" :message="task.error" /></div><div v-if="task.orphanPath" class="task-error">保留项：{{ task.orphanPath }}</div>
      <div class="task-actions"><button v-if="task.state === 'running' || task.state === 'queued'" type="button" title="取消" @click="cancelTransfer(task.id)"><IconX :size="16" /></button><button v-if="task.state === 'failed' || task.state === 'cancelled'" type="button" title="重试" @click="retryTransfer(task.id)"><IconRefresh :size="16" /></button><button v-if="task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled'" type="button" title="移除记录" @click="dismissTransfer(task.id)"><IconTrash :size="16" /></button></div>
    </div>
    </div>
  </aside>
</template>

<style scoped>
.transfer-panel{box-sizing:border-box;display:flex;flex-direction:column;width:340px;max-width:calc(100vw - 16px);max-height:min(45vh,var(--reka-popover-content-available-height));background:var(--workbench-surface);border:1px solid var(--workbench-border);box-shadow:0 8px 24px var(--vscode-widget-shadow);color:var(--workbench-text);padding:9px}.transfer-panel header,.task-head,.task-actions{display:flex;align-items:center;gap:8px}.transfer-panel header{justify-content:space-between;margin-bottom:8px;color:var(--workbench-text-strong)}.transfer-panel button{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--workbench-text);cursor:pointer}.transfer-panel button:hover{color:var(--workbench-text-strong)}.transfer-panel label{display:flex;align-items:center;gap:8px;color:var(--workbench-text-muted);font-size:12px}.transfer-panel select{background:var(--workbench-input-bg);border:1px solid var(--workbench-border);color:var(--workbench-text)}.transfer-task{padding:8px 0;border-bottom:1px solid var(--workbench-border);font-size:11px}.task-head{justify-content:space-between}.task-head span:last-child{flex-shrink:0}.task-head span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transfer-task progress{width:100%;height:4px;margin:6px 0}.task-error{color:var(--workbench-error);white-space:normal}.task-actions{justify-content:flex-end}
.transfer-task-list{min-height:0;overflow:auto;margin-top:6px}.transfer-empty{padding:24px 12px;text-align:center;color:var(--workbench-text-muted);font-size:12px}
</style>
