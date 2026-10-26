<script setup lang="ts">
import { computed } from 'vue'
import ShellTerminal from './ShellTerminal.vue'

const props = defineProps<{
  params: {
    params: { tabId: string; [key: string]: any }
    [key: string]: any
  }
}>()

const tabId = computed(() => props.params?.params?.tabId ?? '')
const viewportTabIds = () => props.params.api.group.panels.map((panel: { id: string }) => panel.id)
</script>

<template>
  <div class="terminal-panel">
    <ShellTerminal v-if="tabId" :tab-id="tabId" :viewport-tab-ids="viewportTabIds" />
  </div>
</template>

<style scoped>
.terminal-panel {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--terminal-background, #0d0d0d);
}
</style>
