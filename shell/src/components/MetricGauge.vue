<script setup lang="ts">
import { computed } from 'vue'

type GaugeStatus = 'normal' | 'warning' | 'critical' | 'unavailable'

const props = withDefaults(
  defineProps<{
    name: string
    value: number | null
    unit?: string
    status?: GaugeStatus
  }>(),
  {
    unit: '%',
    status: 'unavailable',
  },
)

const STATUS_COLORS: Record<GaugeStatus, string> = {
  normal: 'var(--workbench-success)',
  warning: 'var(--workbench-warning)',
  critical: 'var(--workbench-error)',
  unavailable: 'var(--workbench-text-disabled)',
}

const TRACK_COLOR = 'var(--workbench-border)'

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function formatValue(value: number | null): string {
  return value === null ? '--' : `${value.toFixed(1)}${props.unit}`
}

const available = computed(() => props.value !== null && props.status !== 'unavailable')
const value = computed(() => (props.value === null ? 0 : clamp(props.value)))
const color = computed(() => STATUS_COLORS[props.status])
const style = computed(() => ({
  '--gauge-value': `${value.value}%`,
  '--gauge-color': available.value ? color.value : TRACK_COLOR,
}))
</script>

<template>
  <div class="metric-gauge" :data-status="props.status">
    <div class="metric-gauge-chart" :style="style" :aria-label="`${props.name} ${formatValue(props.value)}`">
      <span class="metric-gauge-value">{{ formatValue(props.value) }}</span>
    </div>
  </div>
</template>

<style scoped>
.metric-gauge {
  width: 100%;
  height: var(--metric-gauge-size, 118px);
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.metric-gauge-chart {
  width: var(--metric-gauge-size, 96px);
  height: var(--metric-gauge-size, 96px);
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: conic-gradient(
    var(--gauge-color) var(--gauge-value),
    var(--workbench-border) var(--gauge-value)
  );
  position: relative;
}

.metric-gauge-chart::after {
  content: '';
  position: absolute;
  inset: var(--metric-gauge-inset, 14px);
  border-radius: 50%;
  background: var(--workbench-bg);
}

.metric-gauge-value {
  position: relative;
  z-index: 1;
  color: var(--workbench-text-strong);
  font-size: var(--metric-gauge-font-size, 18px);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
</style>
