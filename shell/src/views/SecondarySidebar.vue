<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { DockviewVue, themeAbyss } from 'dockview-vue'
import type { DockviewApi, DockviewReadyEvent } from 'dockview-vue'
import MetricsPanel from './MetricsPanel.vue'

const api = ref<DockviewApi | null>(null)
const dockEl = ref<HTMLElement | null>(null)
let unsubs: (() => void)[] = []

const components = { metrics: MetricsPanel }

function onReady(event: DockviewReadyEvent) {
  api.value = event.api
  // Fill the inspector before its first visible paint instead of waiting for
  // Dockview's requestAnimationFrame-deferred resize handling.
  const observer = new ResizeObserver(([entry]) => {
    if (entry) event.api.layout(Math.round(entry.contentRect.width), Math.round(entry.contentRect.height))
  })
  observer.observe(dockEl.value!)
  unsubs.push(() => observer.disconnect())
  if (!event.api.getPanel('metrics')) {
    const group = event.api.addGroup({
      id: 'metrics-group',
      direction: 'right',
      hideHeader: true,
      locked: 'no-drop-target',
    } as any)
    event.api.addPanel({
      id: 'metrics',
      title: '系统监控',
      component: 'metrics',
      position: { referenceGroup: group, direction: 'within' },
    })
  }
  unsubs.push(() => event.api.dispose())
}

onBeforeUnmount(() => {
  unsubs.forEach((u) => u())
  unsubs = []
  api.value = null
})
</script>

<template>
  <div ref="dockEl" class="secondary-sidebar">
    <DockviewVue
      :theme="themeAbyss"
      :components="(components as any)"
      @ready="onReady"
    />
  </div>
</template>

<style>
.secondary-sidebar {
  width: 100%;
  height: 100%;
}

.secondary-sidebar .dv-dockview {
  --dv-group-view-background-color: #252526;
}
</style>
