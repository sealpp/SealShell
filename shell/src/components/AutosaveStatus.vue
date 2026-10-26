<script setup lang="ts">
import { computed } from 'vue'
import type { AutosaveState } from '../services/autosave'
import UiStatus from './UiStatus.vue'

const props = defineProps<{ state: AutosaveState; status: string; error?: string }>()
const kind = computed(() => props.error ? 'error' : props.state === 'saving' ? 'busy' : props.state === 'saved' ? 'success' : 'idle')
</script>

<template>
  <UiStatus class="settings-save-status" :kind="kind" :label="error || status" :icon="state === 'pending' && !error ? 'clock' : undefined" />
</template>
