<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { DockviewVue, themeAbyss } from 'dockview-vue'
import type { DockviewApi, DockviewReadyEvent } from 'dockview-vue'
import ConnectionsPanel from './ConnectionsPanel.vue'

const api = ref<DockviewApi | null>(null)
let unsubs: (() => void)[] = []

const components = { connections: ConnectionsPanel }

function onReady(event: DockviewReadyEvent) {
  api.value = event.api
  if (!event.api.getPanel('connections')) {
    const group = event.api.addGroup({
      id: 'connections-group',
      direction: 'right',
      hideHeader: true,
      locked: 'no-drop-target',
    } as any)
    event.api.addPanel({
      id: 'connections',
      title: '会话',
      component: 'connections',
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
  <DockviewVue
    class="primary-sidebar"
    :theme="themeAbyss"
    :components="(components as any)"
    @ready="onReady"
  />
</template>

<style>
.primary-sidebar {
  width: 100%;
  height: 100%;
}

.primary-sidebar .dv-dockview {
  --dv-group-view-background-color: #252526;
}
</style>
