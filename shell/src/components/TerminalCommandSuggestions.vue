<script setup lang="ts">
import { computed, ref, type CSSProperties } from 'vue'
import { ListboxContent, ListboxItem, ListboxRoot, PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot, type FocusOutsideEvent } from 'reka-ui'
import type { TerminalSuggestionView } from '../services/terminalSuggestions/controller'
import { usePortalTarget } from '../ui/portal'

const props = defineProps<{ suggestion: TerminalSuggestionView; appearance: CSSProperties; boundary: HTMLElement | null }>()
const emit = defineEmits<{ accept: [command: string]; dismiss: []; terminalKey: [event: KeyboardEvent] }>()
const panel = ref<HTMLDivElement | null>(null)
const listbox = ref<{ highlightFirstItem(): void; highlightItem(command: string): void } | null>(null)
const portalTarget = usePortalTarget(computed(() => props.boundary))

defineExpose({
  focus: (edge: 'first' | 'last') => {
    if (edge === 'last') listbox.value?.highlightItem(props.suggestion.candidates[props.suggestion.candidates.length - 1]!.command)
    else listbox.value?.highlightFirstItem()
  },
  contains: (target: EventTarget | null) => target instanceof Node && !!panel.value?.contains(target),
})

function onKeydown(event: KeyboardEvent): void {
  if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter', 'Escape'].includes(event.key)) return
  emit('terminalKey', event)
}

function onFocusOutside(event: FocusOutsideEvent): void {
  const target = event.detail.originalEvent.target
  // Returning to the owning terminal continues the same editing interaction.
  if (target instanceof Node && props.boundary?.contains(target)) event.preventDefault()
}
</script>

<template>
  <PopoverRoot :open="true" @update:open="open => { if (!open) emit('dismiss') }">
    <PopoverAnchor as-child><span class="terminal-command-anchor" :style="appearance" aria-hidden="true" /></PopoverAnchor>
    <PopoverPortal :to="portalTarget">
      <PopoverContent
        class="terminal-command-suggestions" aria-label="本地命令提示"
        side="bottom" align="start" :side-offset="4" :collision-padding="8"
        :collision-boundary="boundary" :prioritize-position="true"
        @open-auto-focus.prevent @close-auto-focus.prevent
        @focus-outside="onFocusOutside"
      >
        <div ref="panel" class="terminal-command-suggestions-panel" @keydown.capture="onKeydown">
          <ListboxRoot ref="listbox" class="terminal-command-suggestions-body workbench-selection-container" selection-behavior="replace" :highlight-on-hover="true">
            <ListboxContent aria-label="命令候选" class="terminal-command-suggestions-list">
              <ListboxItem
                v-for="candidate in suggestion.candidates" :key="candidate.command"
                :value="candidate.command" :data-source="candidate.source"
                class="terminal-command-suggestion workbench-list-item"
                :title="candidate.source === 'history' ? `${candidate.command}\n本地历史 · ${candidate.uses} 次` : candidate.command"
                :aria-description="candidate.source === 'history' ? `本地历史，使用过 ${candidate.uses} 次` : undefined"
                @mousedown.left.prevent="listbox?.highlightItem(candidate.command)"
                @select.prevent="emit('accept', candidate.command)"
              >
                <code><span class="terminal-command-prefix">{{ suggestion.prefix }}</span>{{ candidate.command.slice(suggestion.prefix.length) }}</code>
              </ListboxItem>
            </ListboxContent>
          </ListboxRoot>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.terminal-command-anchor { position: absolute; width: 1px; pointer-events: none; }
.terminal-command-suggestions { width: max-content; min-width: min(180px, var(--reka-popover-content-available-width)); max-width: min(420px, calc(100vw - 16px), var(--reka-popover-content-available-width)); max-height: var(--reka-popover-content-available-height); display: flex; flex-direction: column; overflow: hidden; z-index: 80; border: 1px solid var(--vscode-editorWidget-border); border-radius: var(--workbench-radius); background: var(--vscode-editorWidget-background); color: var(--workbench-text); box-shadow: 0 4px 12px var(--vscode-widget-shadow); }
.terminal-command-suggestions-panel { display: flex; flex-direction: column; min-height: 0; padding: 4px 0; }
.terminal-command-suggestions-body { display: flex; flex-direction: column; min-height: 0; }
.terminal-command-suggestions-list { overflow-y: auto; min-height: 0; outline: none; }
.terminal-command-suggestion { display: flex; align-items: center; min-height: 22px; padding: 0 8px; cursor: pointer; }
.terminal-command-suggestion code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; font: 12px/1.5 Consolas, ui-monospace, monospace; }
.terminal-command-prefix { color: var(--workbench-link); }
</style>
