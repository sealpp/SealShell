<script setup lang="ts">
import { computed } from 'vue'
import '@vscode/codicons/dist/codicon.css'

const props = withDefaults(defineProps<{
  kind?: 'idle' | 'busy' | 'success' | 'warning' | 'error'
  label: string
  icon?: string
  compact?: boolean
  iconOnly?: boolean
}>(), { kind: 'idle', compact: false })
const glyph = computed(() => props.icon ?? ({ idle: 'info', busy: 'loading', success: 'check', warning: 'warning', error: 'error' }[props.kind]))
</script>

<template>
  <span class="ui-status" :class="[`ui-status--${kind}`, { 'ui-status--compact': compact, 'ui-status--icon-only': iconOnly, error: kind === 'error' }]"
    :role="kind === 'error' ? 'alert' : 'status'" :title="label" aria-atomic="true">
    <span class="ui-status-icon codicon" :class="[`codicon-${glyph}`, { 'ui-status-icon--spin': kind === 'busy' && glyph === 'loading', 'ui-status-icon--pulse': kind === 'busy' && glyph !== 'loading' }]" aria-hidden="true" />
    <span class="ui-status-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.ui-status { display: flex; align-items: flex-start; gap: 6px; min-width: 0; color: var(--workbench-text-muted); font: 400 12px/18px var(--workbench-font-family); }
.ui-status-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 16px; width: 16px; height: 18px; font-size: 16px; }
.ui-status-label { min-width: 0; overflow-wrap: anywhere; }
.ui-status--busy .ui-status-icon { color: var(--workbench-link); }
.ui-status--success .ui-status-icon { color: var(--workbench-success); }
.ui-status--warning .ui-status-icon { color: var(--workbench-warning); }
.ui-status--error { color: var(--workbench-error); }
.ui-status--compact { align-items: center; }
.ui-status--compact .ui-status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ui-status--icon-only { gap: 0; }
.ui-status--icon-only .ui-status-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ui-status-icon--spin { animation: status-spin 1.4s linear infinite; }
.ui-status-icon--pulse { animation: status-pulse 1.6s ease-in-out infinite; }
@keyframes status-spin { to { transform: rotate(360deg); } }
@keyframes status-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .ui-status-icon { animation: none; } }
</style>
