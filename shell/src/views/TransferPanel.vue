<script setup lang="ts">
import ProxyErrorAction from '../components/ProxyErrorAction.vue'
import { IconRefresh, IconTrash, IconX } from '@tabler/icons-vue'
import { transferRuntime, cancelTransfer, dismissTransfer, retryTransfer, setTransferConcurrency } from '../services/sftp/transfer-runtime'

function close(): void { transferRuntime.panelOpen = false }
</script>

<template>
  <aside v-if="transferRuntime.panelOpen" class="transfer-panel">
    <header><strong>传输</strong><button type="button" title="关闭" @click="close"><IconX :size="14" /></button></header>
    <label>并发<select :value="transferRuntime.concurrency" @change="setTransferConcurrency(Number(($event.target as HTMLSelectElement).value))"><option v-for="value in [1, 2, 3, 4]" :key="value" :value="value">{{ value }}</option></select></label>
    <div v-for="task in transferRuntime.tasks" :key="task.id" class="transfer-task">
      <div class="task-head"><span>{{ task.label }}</span><span>{{ task.state }}</span></div>
      <progress max="1" :value="task.progress" />
      <div v-if="task.error" class="task-error">{{ task.error }} <ProxyErrorAction :source="task.proxySource" :message="task.error" /></div><div v-if="task.orphanPath" class="task-error">保留项：{{ task.orphanPath }}</div>
      <div class="task-actions"><button v-if="task.state === 'running' || task.state === 'queued'" type="button" title="取消" @click="cancelTransfer(task.id)"><IconX :size="13" /></button><button v-if="task.state === 'failed' || task.state === 'cancelled'" type="button" title="重试" @click="retryTransfer(task.id)"><IconRefresh :size="13" /></button><button v-if="task.state === 'failed'" type="button" title="移除记录" @click="dismissTransfer(task.id)"><IconTrash :size="13" /></button></div>
    </div>
  </aside>
</template>

<style scoped>
.transfer-panel{position:absolute;right:8px;bottom:32px;width:300px;max-height:45vh;overflow:auto;z-index:30;background:#252526;border:1px solid #444;box-shadow:0 8px 24px #0008;color:#ddd;padding:9px}.transfer-panel header,.task-head,.task-actions{display:flex;align-items:center;gap:8px}.transfer-panel header{justify-content:space-between;margin-bottom:8px;color:#fff}.transfer-panel button{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:#bbb;cursor:pointer}.transfer-panel button:hover{color:#fff}.transfer-panel label{display:flex;align-items:center;gap:8px;color:#aaa;font-size:12px}.transfer-panel select{background:#1e1e1e;border:1px solid #555;color:#ddd}.transfer-task{padding:8px 0;border-bottom:1px solid #3a3a3a;font-size:11px}.task-head{justify-content:space-between}.task-head span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.transfer-task progress{width:100%;height:4px;margin:6px 0}.task-error{color:#f48771;white-space:normal}.task-actions{justify-content:flex-end}
</style>
