<script setup lang="ts">
import { computed, ref, watch, type CSSProperties } from 'vue'
import { ListboxContent, ListboxItem, ListboxRoot, PopoverAnchor, PopoverContent, PopoverPortal, PopoverRoot, type FocusOutsideEvent } from 'reka-ui'
import type { TerminalSuggestionView } from '../services/terminalSuggestions/controller'
import { usePortalTarget } from '../ui/portal'
import UiStatus from './UiStatus.vue'

const props = defineProps<{ suggestion: TerminalSuggestionView; appearance: CSSProperties; boundary: HTMLElement | null }>()
const emit = defineEmits<{ accept: [command: string]; dismiss: []; terminalKey: [event: KeyboardEvent]; lock: []; refresh: [] }>()
const panel = ref<HTMLDivElement | null>(null)
const listbox = ref<{ highlightFirstItem(): void; highlightItem(command: string): void } | null>(null)
const portalTarget = usePortalTarget(computed(() => props.boundary))
const sourceIcons: Record<string, string> = { history: 'history', ai: 'sparkle', directory: 'folder' }
const hasContent = computed(() => props.suggestion.candidates.length > 0 || props.suggestion.loading || props.suggestion.status || props.suggestion.pending || props.suggestion.loading === false)
const working = computed(() => !!props.suggestion.loading && !props.suggestion.status)
const waitingLong = ref(false)
const showFeedback = computed(() => !!props.suggestion.status || waitingLong.value || !props.suggestion.candidates.length)
const activityLabel = computed(() => props.suggestion.activity === 'ai' ? '生成中' : props.suggestion.activity === 'context' ? '读目录' : '查找中')
watch(() => [working.value, props.suggestion.activity, props.suggestion.prefix], (_, __, onCleanup) => {
  waitingLong.value = false
  if (!working.value) return
  const timer = setTimeout(() => { waitingLong.value = true }, 8000)
  onCleanup(() => clearTimeout(timer))
}, { immediate: true })
const feedback = computed(() => {
  const view = props.suggestion
  if (view.status) return { kind: 'warning' as const, label: view.status }
  if (view.loading) return {
    kind: 'busy' as const,
    icon: view.activity === 'ai' ? 'sparkle' : undefined,
    label: waitingLong.value && view.candidates.length
      ? `${view.activity === 'ai' ? 'AI 仍在生成' : view.activity === 'context' ? '仍在读取目录' : '仍在查找建议'}，可先用已有建议`
      : view.activity === 'ai' ? 'AI 正在生成建议' : view.activity === 'context' ? '正在读取目录' : '正在查找建议',
  }
  if (view.loading === false) return { kind: 'idle' as const, label: view.pending ? `有 ${view.pending} 条新建议待显示` : view.candidates.length ? '建议已更新' : '暂无匹配建议' }
  return { kind: 'idle' as const, icon: 'clock', label: view.enhanced ? '输入停顿后补充建议' : '本地命令建议' }
})

defineExpose({
  focus: (edge: 'first' | 'last') => {
    if (edge === 'last') listbox.value?.highlightItem(props.suggestion.candidates[props.suggestion.candidates.length - 1]!.command)
    else listbox.value?.highlightFirstItem()
  },
  contains: (target: EventTarget | null) => target instanceof Node && !!panel.value?.contains(target),
})

function onKeydown(event: KeyboardEvent): void {
  if (event.target instanceof Element && event.target.closest('input, button')) return
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
  <PopoverRoot :open="!!hasContent" @update:open="open => { if (!open) emit('dismiss') }">
    <PopoverAnchor as-child><span class="terminal-command-anchor" :style="appearance" aria-hidden="true" /></PopoverAnchor>
    <PopoverPortal :to="portalTarget">
      <PopoverContent
        class="terminal-command-suggestions" :class="{ 'has-enhancement': suggestion.enhanced, 'status-only': !suggestion.candidates.length, 'is-working': working, 'is-ai-working': working && suggestion.activity === 'ai' }" aria-label="命令提示"
        :title="working ? feedback.label : undefined"
        side="bottom" align="start" :side-offset="4" :collision-padding="8"
        :collision-boundary="boundary" :prioritize-position="true"
        @open-auto-focus.prevent @close-auto-focus.prevent
        @focus-outside="onFocusOutside"
      >
        <span class="terminal-command-announcement" role="status" aria-atomic="true">{{ feedback.label }}</span>
        <div ref="panel" class="terminal-command-suggestions-panel" :class="{ 'has-candidates': suggestion.candidates.length }" @keydown.capture="onKeydown" @pointerenter="emit('lock')" @focusin="emit('lock')">
          <span v-if="working && suggestion.candidates.length" class="terminal-command-inline-activity" aria-hidden="true">
            <span class="codicon codicon-loading" /><span class="terminal-command-activity-label">{{ activityLabel }}</span>
          </span>
          <ListboxRoot ref="listbox" class="terminal-command-suggestions-body workbench-selection-container" selection-behavior="replace" :highlight-on-hover="true">
            <ListboxContent aria-label="命令候选" :aria-busy="working" class="terminal-command-suggestions-list">
              <ListboxItem
                v-for="candidate in suggestion.candidates" :key="candidate.command"
                :value="candidate.command" :data-source="candidate.source"
                class="terminal-command-suggestion workbench-list-item"
                :title="`${candidate.command}\n${candidate.source === 'history' ? `本地历史 · ${candidate.uses} 次提交` : candidate.source === 'ai' ? 'AI 推荐 · 执行前请核对完整命令' : candidate.source === 'directory' ? '目录探测' : '常用命令'}`"
                :aria-description="candidate.source === 'history' ? `本地历史，使用过 ${candidate.uses} 次` : undefined"
                @mousedown.left.prevent="listbox?.highlightItem(candidate.command)"
                @select.prevent="emit('accept', candidate.command)"
              >
                <span class="terminal-command-source codicon" :class="`codicon-${sourceIcons[candidate.source] ?? 'terminal'}`" aria-hidden="true" />
                <code v-if="suggestion.prefix && candidate.command.startsWith(suggestion.prefix)"><span class="terminal-command-prefix">{{ suggestion.prefix }}</span>{{ candidate.command.slice(suggestion.prefix.length) }}</code>
                <code v-else>{{ candidate.command }}</code>
              </ListboxItem>
            </ListboxContent>
          </ListboxRoot>
          <div v-if="showFeedback || suggestion.pending" class="terminal-command-status">
            <UiStatus v-if="showFeedback" v-bind="feedback" :compact="!suggestion.status && !waitingLong" aria-hidden="true" />
            <button v-if="suggestion.pending" type="button" :aria-label="`显示 ${suggestion.pending} 条新建议`" :title="`显示 ${suggestion.pending} 条新建议`" @click="emit('refresh')"><span class="codicon codicon-refresh" aria-hidden="true" /><span>{{ suggestion.pending }}</span></button>
          </div>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
@property --terminal-command-activity-angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
.terminal-command-anchor { position: absolute; width: 1px; pointer-events: none; }
.terminal-command-suggestions { position: relative; width: max-content; min-width: min(180px, var(--reka-popover-content-available-width)); max-width: min(420px, calc(100vw - 16px), var(--reka-popover-content-available-width)); max-height: var(--reka-popover-content-available-height); display: flex; flex-direction: column; overflow: hidden; z-index: 80; border: 1px solid var(--vscode-editorWidget-border); border-radius: var(--workbench-radius); background: var(--vscode-editorWidget-background); color: var(--workbench-text); box-shadow: 0 4px 12px var(--vscode-widget-shadow); }
.terminal-command-suggestions::before { content: ''; position: absolute; inset: 0; z-index: 1; padding: 1.5px; border-radius: inherit; pointer-events: none; opacity: 0; background: conic-gradient(from var(--terminal-command-activity-angle), transparent 0deg 270deg, color-mix(in srgb, var(--workbench-link) 15%, transparent) 296deg, var(--workbench-link) 344deg, transparent 360deg); mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0); mask-composite: exclude; transition: opacity 180ms ease; }
.terminal-command-suggestions.is-ai-working::before { opacity: .9; animation: terminal-command-flow 3.2s linear infinite; }
.terminal-command-announcement { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.terminal-command-inline-activity { position: absolute; top: 6px; right: 8px; display: flex; align-items: center; color: var(--workbench-text-muted); pointer-events: none; }
.terminal-command-inline-activity .codicon { font-size: 16px; animation: terminal-command-spin 1.4s linear infinite; }
.terminal-command-activity-label { display: none; font: 400 12px/18px var(--workbench-font-family); }
.is-ai-working .terminal-command-inline-activity { display: none; }
.is-working:not(.is-ai-working) .terminal-command-suggestion:first-child { padding-right: 32px; }
.terminal-command-suggestions-panel { display: flex; flex-direction: column; min-height: 0; padding: 4px 0; }
.terminal-command-suggestions-body { display: flex; flex-direction: column; min-height: 0; }
.terminal-command-suggestions-list { overflow-y: auto; min-height: 0; outline: none; }
.terminal-command-suggestion { display: flex; align-items: center; gap: 6px; min-height: 22px; padding: 0 8px; cursor: pointer; }
.terminal-command-source { flex: 0 0 16px; font-size: 16px; color: var(--workbench-text-muted); }
.terminal-command-suggestion[data-source='ai'] .terminal-command-source { color: var(--workbench-link); }
.terminal-command-suggestion code { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; font: 12px/1.5 Consolas, ui-monospace, monospace; }
.terminal-command-prefix { color: var(--workbench-link); }
.terminal-command-suggestions.has-enhancement { width: 420px; }
.terminal-command-suggestions.status-only { width: max-content; min-width: 32px; }
.terminal-command-status { display: flex; align-items: center; gap: 8px; box-sizing: border-box; min-height: 28px; flex-shrink: 0; padding: 3px 8px; }
.has-candidates .terminal-command-status { margin-top: 4px; border-top: 1px solid var(--workbench-border-muted); }
.terminal-command-status .ui-status { flex: 1; }
.is-ai-working .terminal-command-status .ui-status-icon { display: none; }
.terminal-command-status button { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; padding: 2px 4px; border-radius: var(--workbench-radius-small); color: var(--workbench-link); background: transparent; border: 0; font: 400 12px/18px var(--workbench-font-family); cursor: pointer; }
.terminal-command-status button:hover { background: var(--workbench-toolbar-hover-bg); }
@keyframes terminal-command-flow { to { --terminal-command-activity-angle: 360deg; } }
@keyframes terminal-command-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .terminal-command-suggestions::before, .terminal-command-suggestions.is-ai-working::before { opacity: 0; animation: none; transition: none; }
  .is-working .terminal-command-inline-activity { display: flex; }
  .terminal-command-inline-activity .codicon { display: none; animation: none; }
  .terminal-command-activity-label { display: inline; }
  .is-working .terminal-command-suggestion:first-child { padding-right: 64px; }
}
</style>
