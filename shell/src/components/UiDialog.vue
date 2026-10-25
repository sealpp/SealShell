<script setup lang="ts">
import { DialogClose, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui'
import { usePortalTarget } from '../ui/portal'
import { IconX } from '../ui/icons'

const props = withDefaults(defineProps<{
  open: boolean
  title: string
  description?: string
  width?: string
  height?: string
  contentClass?: string
  showTitle?: boolean
  showClose?: boolean
}>(), {
  width: '420px',
  description: '',
  height: undefined,
  contentClass: '',
  showTitle: true,
  showClose: true,
})

const emit = defineEmits<{ close: [] }>()
const portalTarget = usePortalTarget()

function onOpenChange(open: boolean) {
  if (!open) emit('close')
}
</script>

<template>
  <DialogRoot :open="props.open" @update:open="onOpenChange">
    <DialogPortal :to="portalTarget">
      <DialogOverlay class="workbench-dialog-overlay" />
      <DialogContent
        :class="['workbench-dialog-content', props.contentClass]"
        :style="{ width: props.width, height: props.height }"
      >
        <div class="workbench-dialog-header">
          <DialogTitle
            v-if="props.showTitle"
            class="workbench-dialog-title"
          >
            {{ props.title }}
          </DialogTitle>
          <DialogTitle
            v-else
            class="workbench-dialog-title workbench-dialog-title--sr-only"
          >
            {{ props.title }}
          </DialogTitle>
          <DialogClose v-if="props.showClose" as-child>
            <button type="button" class="workbench-dialog-close" aria-label="关闭">
              <IconX :size="16" />
            </button>
          </DialogClose>
        </div>
        <DialogDescription v-if="props.description" class="workbench-dialog-description">
          {{ props.description }}
        </DialogDescription>
        <DialogDescription
          v-else
          class="workbench-dialog-description workbench-dialog-description--sr-only"
        >
          {{ props.title }}
        </DialogDescription>
        <div class="workbench-dialog-body">
          <slot />
        </div>
        <div v-if="$slots.actions" class="workbench-dialog-actions">
          <slot name="actions" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
