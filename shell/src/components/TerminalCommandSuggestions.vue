<script setup lang="ts">
import { computed, ref, type CSSProperties } from 'vue'
import { ListboxContent, ListboxItem, ListboxRoot, PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot } from 'reka-ui'
import type { TerminalSuggestionView } from '../services/terminalSuggestions/controller'
import { usePortalTarget } from '../ui/portal'

const props = defineProps<{ suggestion: TerminalSuggestionView; appearance: CSSProperties; boundary: HTMLElement | null }>()
const emit = defineEmits<{ accept: [command: string]; dismiss: [] }>()
const panel = ref<HTMLDivElement | null>(null)
const listbox = ref<{ highlightFirstItem(): void; highlightItem(command: string): void } | null>(null)
const portalTarget = usePortalTarget(computed(() => props.boundary))

defineExpose({
  focus: () => listbox.value?.highlightFirstItem(),
  contains: (target: EventTarget | null) => target instanceof Node && !!panel.value?.contains(target),
})
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
      >
        <div ref="panel" class="terminal-command-suggestions-panel">
          <div class="terminal-command-suggestions-heading">本地命令提示<span>{{ suggestion.candidates.length }} 项</span></div>
          <ListboxRoot ref="listbox" class="terminal-command-suggestions-body" selection-behavior="replace" :highlight-on-hover="true">
            <ListboxContent aria-label="命令候选" class="terminal-command-suggestions-list">
              <ListboxItem
                v-for="candidate in suggestion.candidates" :key="candidate.command"
                :value="candidate.command" :data-source="candidate.source"
                class="terminal-command-suggestion" :title="candidate.command"
                @mousedown.left.prevent="listbox?.highlightItem(candidate.command)"
                @select.prevent="emit('accept', candidate.command)"
              >
                <code><span class="terminal-command-prefix">{{ suggestion.prefix }}</span>{{ candidate.command.slice(suggestion.prefix.length) }}</code>
                <span class="terminal-command-source">{{ candidate.source === 'history' ? `本地历史 · ${candidate.uses} 次` : '常用命令' }}</span>
              </ListboxItem>
            </ListboxContent>
          </ListboxRoot>
          <div class="terminal-command-suggestions-help"><span>Alt+↓ 进入 · ↑↓ 选择</span><span>Enter 补入 · Esc 关闭</span></div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.terminal-command-anchor { position: absolute; width: 1px; pointer-events: none; }
.terminal-command-suggestions { width: min(400px, calc(100vw - 16px)); max-width: var(--reka-popover-content-available-width); max-height: var(--reka-popover-content-available-height); display: flex; flex-direction: column; overflow: hidden; z-index: 80; border: 1px solid #454545; border-radius: 4px; background: #202020; color: #ccc; box-shadow: 0 5px 16px #0007; font: 13px/1.4 var(--workbench-font-family, 'Segoe UI', sans-serif); }
.terminal-command-suggestions-panel { display: flex; flex-direction: column; min-height: 0; }
.terminal-command-suggestions-body { display: flex; flex-direction: column; min-height: 0; }
.terminal-command-suggestions-heading, .terminal-command-suggestions-help { display: flex; justify-content: space-between; gap: 12px; padding: 7px 10px; color: #aaa; font-size: 11px; flex-shrink: 0; }
.terminal-command-suggestions-heading { border-bottom: 1px solid #333; }
.terminal-command-suggestions-list { overflow-y: auto; min-height: 0; outline: none; }
.terminal-command-suggestion { display: flex; align-items: center; gap: 16px; padding: 7px 10px; cursor: pointer; outline: none; }
.terminal-command-suggestion:hover { background: #2a2d2e; }
.terminal-command-suggestions:focus-within .terminal-command-suggestion[data-highlighted] { background: #094771; color: #fff; }
.terminal-command-suggestion code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; font: 12px/1.5 Consolas, ui-monospace, monospace; }
.terminal-command-prefix { color: #75beff; }
.terminal-command-source { flex-shrink: 0; font-size: 11px; color: #aaa; }
.terminal-command-suggestions-help { flex-wrap: wrap; border-top: 1px solid #333; }
</style>
