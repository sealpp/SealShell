<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { IconChevronDown, IconChevronUp } from '../ui/icons'
import type { SortDirection } from './table-sort'

const props = withDefaults(defineProps<{
  as?: 'div' | 'th'
  label: string
  direction?: SortDirection | null
  sortable?: boolean
  resizable?: boolean
  minWidth?: number
  help?: string
}>(), { as: 'div', direction: null, sortable: true, resizable: true, minWidth: 64, help: '' })
const emit = defineEmits<{ sort: []; resizeStart: []; resize: [width: number] }>()
const root = ref<HTMLElement>()
const width = ref(0)
const drag = shallowRef<{ pointer: number; x: number; width: number } | null>(null)
const hint = computed(() => [props.help, `点击${props.direction === 'asc' ? '降序排列' : props.direction === 'desc' ? '恢复默认顺序' : '升序排列'}`].filter(Boolean).join('；'))
let observer: ResizeObserver | undefined

function start(event: PointerEvent) {
  if (event.button !== 0 || drag.value) return
  event.preventDefault()
  emit('resizeStart')
  drag.value = { pointer: event.pointerId, x: event.clientX, width: root.value!.getBoundingClientRect().width }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function move(event: PointerEvent) {
  if (drag.value?.pointer !== event.pointerId) return
  emit('resize', Math.max(props.minWidth, Math.round(drag.value.width + event.clientX - drag.value.x)))
}
function end(event: PointerEvent) {
  if (drag.value?.pointer !== event.pointerId) return
  drag.value = null
  const handle = event.currentTarget as HTMLElement
  if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
}
function keyboard(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  emit('resizeStart')
  emit('resize', event.key === 'Home' ? props.minWidth
    : Math.max(props.minWidth, Math.round(root.value!.getBoundingClientRect().width) + (event.key === 'ArrowLeft' ? -10 : 10)))
}
onMounted(() => {
  observer = new ResizeObserver(() => { width.value = Math.round(root.value!.getBoundingClientRect().width) })
  observer.observe(root.value!)
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <component :is="as" ref="root" class="workbench-column-header" role="columnheader" :aria-sort="sortable ? (direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none') : undefined">
    <button v-if="sortable" type="button" class="workbench-sort-button" :aria-label="`按${label}排序`" :title="hint" @click="emit('sort')">
      <span>{{ label }}</span><component :is="direction === 'asc' ? IconChevronUp : IconChevronDown" v-if="direction" class="workbench-sort-direction" :size="16" aria-hidden="true" />
    </button>
    <div v-else class="workbench-header-content"><slot>{{ label }}</slot></div>
    <span v-if="resizable" class="workbench-column-resizer" :class="{ dragging: drag }" role="separator" tabindex="0" aria-orientation="vertical"
      :aria-label="`调整${label}列宽`" :aria-valuemin="minWidth" :aria-valuenow="width" :title="`拖动调整${label}列宽；左右键调宽，Home 缩到最小`"
      @pointerdown="start" @pointermove="move" @pointerup="end" @pointercancel="end" @lostpointercapture="end" @click.stop @keydown="keyboard" />
  </component>
</template>

<style scoped>
.workbench-column-header { position: relative; box-sizing: border-box; min-width: 0; height: 32px; padding: 0; flex-shrink: 0; text-align: left; font-weight: 600; }
.workbench-column-header[aria-sort='ascending'], .workbench-column-header[aria-sort='descending'] { color: var(--workbench-text-strong); }
.workbench-sort-button { position: absolute; inset: 0; display: flex; align-items: center; gap: 4px; width: 100%; height: 100%; box-sizing: border-box; min-width: 0; padding: 0 8px; border: 0; border-radius: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.workbench-sort-button > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workbench-sort-button > svg { flex: 0 0 14px; }
.workbench-sort-button:hover { background: var(--workbench-list-hover-bg); }
.workbench-sort-button:focus-visible { outline: 1px solid var(--workbench-focus-border); outline-offset: -1px; }
.workbench-header-content { display: flex; align-items: center; height: 100%; padding: 0 8px; }
.workbench-column-resizer { position: absolute; top: 0; right: 0; bottom: 0; z-index: 1; width: 6px; cursor: col-resize; touch-action: none; user-select: none; outline: none; }
.workbench-column-resizer::after { content: ''; position: absolute; top: 7px; bottom: 7px; right: 0; width: 1px; background: var(--workbench-table-border); }
.workbench-column-resizer:hover::after, .workbench-column-resizer:focus-visible::after, .workbench-column-resizer.dragging::after { top: 0; bottom: 0; width: 2px; background: var(--workbench-focus-border); }
</style>
