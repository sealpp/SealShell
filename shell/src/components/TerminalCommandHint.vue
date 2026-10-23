<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { TerminalSuggestionView } from '../services/terminalSuggestions/controller'
defineProps<{ suggestion: TerminalSuggestionView; appearance: CSSProperties }>()
</script>

<template>
  <span
    class="terminal-command-hint"
    :style="appearance"
    role="status"
    :aria-label="`命令提示：${suggestion.command}。按右方向键补全，Escape 关闭。`"
    :data-source="suggestion.source"
  >{{ suggestion.suffix }}</span>
</template>

<style scoped>
.terminal-command-hint {
  position: absolute;
  z-index: 1;
  overflow: hidden;
  white-space: pre;
  text-overflow: ellipsis;
  color: var(--terminal-foreground, #d4d4d4);
  opacity: .45;
  pointer-events: none;
  user-select: none;
}
</style>
