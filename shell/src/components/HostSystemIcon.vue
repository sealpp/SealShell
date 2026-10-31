<script setup lang="ts">
import { computed } from 'vue'
import type { HostProfile } from '../stores/app'
import { hostSystem, systemIcon } from '../services/remoteSystem'
import { IconTerminal2 } from '../ui/icons'

const props = defineProps<{ host: HostProfile }>()
const info = computed(() => hostSystem(props.host)?.info)
const icon = computed(() => info.value && systemIcon(info.value))
</script>

<template>
  <img v-if="icon" class="host-system-icon" :src="icon" :alt="info?.name" width="16" height="16" draggable="false" />
  <span v-else class="host-system-icon" role="img" aria-label="SSH 终端"><IconTerminal2 :size="16" /></span>
</template>

<style scoped>
.host-system-icon {
  display: inline-flex;
  flex: 0 0 16px;
  width: 16px;
  height: 16px;
  object-fit: contain;
}
</style>
