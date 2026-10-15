<script setup lang="ts">
import { computed } from 'vue'
import { IconX } from '@tabler/icons-vue'
import { commandService } from '../services/commands'
import { store } from '../stores/app'
import MetricGauge from '../components/MetricGauge.vue'
import ProxyErrorAction from '../components/ProxyErrorAction.vue'

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
  const metric = store.telemetry?.metrics[id]
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

const activeTab = computed(() => store.tabs.find((tab) => tab.id === store.activeTerminalTabId))
const activeHost = computed(() => {
  const tab = activeTab.value
  return tab ? store.hosts.find((host) => host.id === tab.hostId) : undefined
})
const hostLabel = computed(() => {
  const host = activeHost.value
  if (!host) return '选择终端后显示'
  return `${host.address}:${host.port}`
})
const connectionLabel = computed(() => {
  const tab = activeTab.value
  if (!tab) return '未选择终端'
  if (tab.state === 'online') return '在线'
  if (tab.state === 'connecting') return '连接中'
  if (tab.state === 'error') return '连接失败'
  return '未连接'
})

function closePanel() {
  void commandService.execute('workbench.togglePanel', { area: 'global' })
}

function statusKey(metric: MetricCard): string {
  return store.telemetry ? metric.status : 'waiting'
}

function statusText(metric: MetricCard): string {
  if (!store.telemetry) return '等待数据'
  if (metric.status === 'unavailable') return '数据不可用'
  if (metric.kind === 'stat') return '运行中'
  if (metric.status === 'critical') return '高负载'
  if (metric.status === 'warning') return '注意'
  return '正常'
}
</script>

<template>
  <div class="metrics-panel">
    <div class="metrics-header">
      <div class="metrics-heading">
        <span class="title">系统监控</span>
        <span class="host-label" :title="hostLabel">{{ hostLabel }}</span>
      </div>
      <div class="metrics-actions">
        <span class="connection-status" :data-state="activeTab?.state ?? 'idle'">
          <span class="status-dot" aria-hidden="true"></span>
          {{ connectionLabel }}
        </span>
        <button type="button" class="panel-close" aria-label="关闭系统监控" title="关闭系统监控" @click="closePanel">
          <IconX :size="15" aria-hidden="true" />
        </button>
      </div>
    </div>
    <div class="metrics-content">
      <div v-if="!activeTab" class="panel-empty">
        <strong>选择一个终端</strong>
        <span>连接后显示实时系统状态</span>
      </div>
      <div v-else-if="activeTab.state !== 'online'" class="panel-empty">
        <strong>{{ connectionLabel }}</strong>
        <span>终端连接后显示实时系统状态</span>
      </div>
      <div v-else-if="activeTab.telemetryError" class="panel-empty"><strong>监控连接失败</strong><span>{{ activeTab.telemetryError }}</span><ProxyErrorAction :source="activeTab.proxySource" :message="activeTab.telemetryError" /><small v-if="activeTab.proxySource">更新代理后请重新连接终端。</small></div>
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
  background: var(--workbench-surface, #252526);
}

.metrics-header {
  min-height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem 0.45rem 0.75rem;
  background: var(--workbench-surface-raised, #2d2d2d);
  border-bottom: 1px solid var(--workbench-border-muted, #1f1f1f);
  white-space: nowrap;
  flex-shrink: 0;
}

.metrics-header .title {
  font-size: 12px;
  font-weight: 600;
  color: var(--workbench-text-strong, #fff);
}

.metrics-heading {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.host-label {
  max-width: 142px;
  overflow: hidden;
  color: var(--workbench-text-muted, #888);
  font-size: 10px;
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
  color: var(--workbench-text-muted, #888);
  font-size: 10px;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--workbench-text-disabled, #666);
}

.connection-status[data-state='online'] { color: #4ec9b0; }
.connection-status[data-state='online'] .status-dot { background: #4ec9b0; }
.connection-status[data-state='connecting'] { color: #dcdcaa; }
.connection-status[data-state='connecting'] .status-dot { background: #dcdcaa; }
.connection-status[data-state='error'] { color: #f14c4c; }
.connection-status[data-state='error'] .status-dot { background: #f14c4c; }

.panel-close {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--workbench-text-muted, #888);
  cursor: pointer;
}

.panel-close:hover {
  background: var(--workbench-surface, #252526);
  color: var(--workbench-text-strong, #fff);
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
  color: var(--workbench-text-muted, #888);
  font-size: 12px;
  text-align: center;
  padding: 2.25rem 0.5rem;
}

.panel-empty strong {
  color: var(--workbench-text, #ccc);
  font-size: 12px;
  font-weight: 500;
}

.panel-empty span {
  color: var(--workbench-text-disabled, #666);
  font-size: 11px;
}

.dashboard {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
}

.metric {
  background: var(--workbench-bg, #1e1e1e);
  min-width: 0;
  padding: 0.5rem;
  border-radius: 4px;
  border: 1px solid var(--workbench-border, #333);
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
  color: var(--workbench-text-muted, #999);
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
  background: #151515;
  border-radius: 4px;
}

.metric[data-metric-kind='stat'] {
  grid-column: 1 / -1;
}

.metric[data-metric-kind='gauge'] .metric-gauge {
  --metric-gauge-size: 76px;
  --metric-gauge-inset: 11px;
  --metric-gauge-font-size: 15px;
}

.metric-stat-value {
  color: var(--workbench-text-strong, #fff);
  font-size: 32px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  line-height: 1;
}

.metric-footer {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  color: var(--workbench-text-muted, #888);
  font-size: 11px;
}

.metric-status {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric[data-status='normal'] .metric-status {
  color: #4ec9b0;
}

.metric[data-status='warning'] .metric-status {
  color: #dcdcaa;
}

.metric[data-status='critical'] .metric-status {
  color: #f14c4c;
}

.metric[data-status='waiting'] .metric-status,
.metric[data-status='unavailable'] .metric-status {
  color: var(--workbench-text-disabled, #666);
}
</style>
