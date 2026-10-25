<script setup lang="ts">
import { computed, ref } from 'vue'
import { IconRefresh } from '../ui/icons'
import { retryMonitor } from '../services/monitoring/runtime'
import { setBottomPanelActiveTab, store, type MonitorTab } from '../stores/app'
import MetricGauge from '../components/MetricGauge.vue'
import ProxyErrorAction from '../components/ProxyErrorAction.vue'

const props = defineProps<{ params: { params: { tabId: string } } }>()
const tab = computed(() => store.tabs.find((candidate): candidate is MonitorTab => candidate.id === props.params.params.tabId && candidate.kind === 'monitor'))
const password = ref('')
const telemetry = computed(() => tab.value?.monitor.telemetry)
const connectionLabel = computed(() => tab.value?.state === 'online' ? '正在监测' : tab.value?.state === 'connecting' ? '连接中' : tab.value?.state === 'error' ? '连接失败' : '未连接')
const hostLabel = computed(() => tab.value ? `${tab.value.monitor.username}@${tab.value.monitor.address}:${tab.value.monitor.port}` : '')
function login() {
  const value = password.value
  password.value = ''
  if (tab.value) void retryMonitor(tab.value.id, value)
}

type MetricStatus = 'normal' | 'warning' | 'critical' | 'unavailable'
type MetricKind = 'gauge' | 'stat'

type MetricCard = {
  id: string
  name: string
  value: number | null
  valueText: string
  label: string
  kind: MetricKind
  status: MetricStatus
}

function numericMetric(id: string): number | null {
  const metric = telemetry.value?.metrics[id]
  if (metric?.quality !== 'valid' || typeof metric.value !== 'number' || !Number.isFinite(metric.value)) {
    return null
  }
  return metric.value
}

function percentMetric(id: string): number | null {
  const value = numericMetric(id)
  return value !== null && value >= 0 && value <= 100 ? value : null
}

function metricText(value: number | null, digits: number, suffix = ''): string {
  return value === null ? '--' : `${value.toFixed(digits)}${suffix}`
}

function percentStatus(value: number | null): MetricStatus {
  if (value === null) return 'unavailable'
  if (value >= 90) return 'critical'
  if (value >= 70) return 'warning'
  return 'normal'
}

const metrics = computed<MetricCard[]>(() => {
  const cpu = percentMetric('cpu.usage')
  const memory = percentMetric('memory.usage')
  const disk = percentMetric('disk.usage')
  const processes = numericMetric('process.count')
  const processCount = processes !== null && processes >= 0 ? processes : null

  return [
    {
      id: 'cpu.usage',
      name: 'CPU 使用率',
      value: cpu,
      valueText: metricText(cpu, 1, '%'),
      label: '核心使用',
      kind: 'gauge',
      status: percentStatus(cpu),
    },
    {
      id: 'memory.usage',
      name: '内存使用率',
      value: memory,
      valueText: metricText(memory, 1, '%'),
      label: '总内存',
      kind: 'gauge',
      status: percentStatus(memory),
    },
    {
      id: 'disk.usage',
      name: '磁盘使用率',
      value: disk,
      valueText: metricText(disk, 1, '%'),
      label: '根分区',
      kind: 'gauge',
      status: percentStatus(disk),
    },
    {
      id: 'process.count',
      name: '进程数量',
      value: processCount,
      valueText: metricText(processCount, 0),
      label: '状态',
      kind: 'stat',
      status: processCount === null ? 'unavailable' : 'normal',
    },
  ]
})

function statusKey(metric: MetricCard): string {
  return telemetry.value ? metric.status : 'waiting'
}

function statusText(metric: MetricCard): string {
  if (!telemetry.value) return '等待数据'
  if (metric.status === 'unavailable') return '数据不可用'
  if (metric.kind === 'stat') return '运行中'
  if (metric.status === 'critical') return '高负载'
  if (metric.status === 'warning') return '注意'
  return '正常'
}
</script>

<template>
  <div v-if="tab" class="metrics-panel" :data-monitor-id="tab.id" @pointerdown="setBottomPanelActiveTab(tab.id, 'monitors')">
    <div class="metrics-header">
      <div class="metrics-heading">
        <span class="title">{{ tab.label }}</span>
        <span class="host-label" :title="hostLabel">{{ hostLabel }}</span>
      </div>
      <div class="metrics-actions">
        <span class="connection-status" :data-state="tab.state"><span class="status-dot" aria-hidden="true"></span>{{ connectionLabel }}</span>
        <button v-if="tab.state === 'error' && !tab.monitor.needsPassword" type="button" class="panel-action" aria-label="重试监测" title="使用原配置重试" @click="retryMonitor(tab.id)"><IconRefresh :size="16" /></button>
      </div>
    </div>
    <div class="metrics-content">
      <form v-if="tab.monitor.needsPassword" class="panel-empty monitor-login" @submit.prevent="login">
        <strong>输入 SSH 密码</strong><span>密码仅用于本次监测</span>
        <input v-model="password" type="password" aria-label="监测密码" autocomplete="off" autofocus />
        <span v-if="tab.error" role="alert">{{ tab.error }}</span>
        <button type="submit" class="workbench-dialog-button workbench-dialog-button--primary">连接监测</button>
      </form>
      <div v-else-if="tab.monitor.unsupported" class="panel-empty"><strong>暂不支持此系统</strong><span>当前性能监测仅支持 Linux</span></div>
      <div v-else-if="tab.state === 'error'" class="panel-empty"><strong>监测连接失败</strong><span role="alert">{{ tab.error }}</span><ProxyErrorAction :source="tab.proxySource" :message="tab.error" /><small v-if="tab.proxySource">修改配置后，关闭此实例再重新打开。</small></div>
      <div v-else-if="tab.state !== 'online'" class="panel-empty"><strong>{{ connectionLabel }}</strong><span>正在连接监测目标</span></div>
      <div v-else class="dashboard">
        <article
          v-for="metric in metrics"
          :key="metric.id"
          class="metric"
          :data-metric-id="metric.id"
          :data-metric-kind="metric.kind"
          :data-metric-value="metric.valueText"
          :data-status="statusKey(metric)"
        >
          <div class="metric-header">
            <h3>{{ metric.name }}</h3>
          </div>
          <MetricGauge
            v-if="metric.kind === 'gauge'"
            :name="metric.name"
            :value="metric.value"
            :status="metric.status"
          />
          <div v-else class="metric-stat" aria-label="进程数量">
            <span class="metric-stat-value">{{ metric.valueText }}</span>
          </div>
          <div class="metric-footer">
            <span>{{ metric.label }}</span>
            <span class="metric-status">{{ statusText(metric) }}</span>
          </div>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.metrics-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--workbench-surface);
}

.metrics-header {
  min-height: 30px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 3px 10px;
  background: var(--workbench-surface);
  border-bottom: 1px solid var(--workbench-border-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

.metrics-header .title {
  font-size: 12px;
  font-weight: 600;
  color: var(--workbench-text-strong);
}

.metrics-heading {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.host-label {
  min-width: 0;
  overflow: hidden;
  color: var(--workbench-text-muted);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metrics-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.connection-status {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  color: var(--workbench-text-muted);
  font-size: 12px;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--workbench-text-disabled);
}

.connection-status[data-state='online'] { color: var(--workbench-success); }
.connection-status[data-state='online'] .status-dot { background: var(--workbench-success); }
.connection-status[data-state='connecting'] { color: var(--workbench-warning); }
.connection-status[data-state='connecting'] .status-dot { background: var(--workbench-warning); }
.connection-status[data-state='error'] { color: var(--workbench-error); }
.connection-status[data-state='error'] .status-dot { background: var(--workbench-error); }

.panel-action {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--workbench-text-muted);
  cursor: pointer;
}

.panel-action:hover {
  background: var(--workbench-surface);
  color: var(--workbench-text-strong);
}

.metrics-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.75rem;
}

.panel-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  color: var(--workbench-text-muted);
  font-size: 12px;
  text-align: center;
  padding: 2.25rem 0.5rem;
}

.panel-empty strong {
  color: var(--workbench-text);
  font-size: 12px;
  font-weight: 500;
}

.panel-empty span {
  color: var(--workbench-text-disabled);
  font-size: 11px;
}

.dashboard {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(150px, 100%), 1fr));
  gap: 0.5rem;
}

.metric {
  background: var(--workbench-bg);
  min-width: 0;
  padding: 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--workbench-border);
}

.metric-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
  margin-bottom: 0.1rem;
}

.metric-header h3 {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--workbench-text-muted);
  font-size: 12px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-stat {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 78px;
  background: var(--workbench-bg);
  border-radius: 4px;
}


.metric[data-metric-kind='gauge'] .metric-gauge {
  --metric-gauge-size: 76px;
  --metric-gauge-inset: 11px;
  --metric-gauge-font-size: 15px;
}

.metric-stat-value {
  color: var(--workbench-text-strong);
  font-size: 32px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1;
}

.metric-footer {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  color: var(--workbench-text-muted);
  font-size: 11px;
}

.metric-status {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric[data-status='normal'] .metric-status {
  color: var(--workbench-success);
}

.metric[data-status='warning'] .metric-status {
  color: var(--workbench-warning);
}

.metric[data-status='critical'] .metric-status {
  color: var(--workbench-error);
}

.metric[data-status='waiting'] .metric-status,
.metric[data-status='unavailable'] .metric-status {
  color: var(--workbench-text-disabled);
}
.monitor-login input { width: min(240px, 100%); box-sizing: border-box; padding: 6px 8px; background: var(--workbench-input-bg); border: 1px solid var(--workbench-border); color: var(--workbench-text); }
</style>
