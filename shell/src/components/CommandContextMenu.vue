<script setup lang="ts">
import { computed, ref, shallowRef } from 'vue'
import {
  ContextMenuContent,
  ContextMenuPortal,
  ContextMenuRoot,
  ContextMenuTrigger,
} from 'reka-ui'
import CommandMenuItems from './CommandMenuItems.vue'
import type { CommandContext } from '../services/context'
import { menuRegistry } from '../services/commands'
import { usePortalTarget } from '../ui/portal'

const props = defineProps<{
  menuId: string
  context: CommandContext | (() => CommandContext)
  canOpen?: (event: MouseEvent) => boolean
}>()

const emit = defineEmits<{ openChange: [open: boolean] }>()
const open = ref(false)
const triggerEl = shallowRef<Element | null>(null)
const invocationContext = shallowRef<CommandContext | null>(null)
const portalTarget = usePortalTarget(triggerEl)

const items = computed(() => {
  if (!invocationContext.value) return []
  return menuRegistry.resolve(props.menuId, invocationContext.value)
})

function resolveContext(): CommandContext {
  return typeof props.context === 'function' ? props.context() : props.context
}

function onContextMenu(event: MouseEvent) {
  if (props.canOpen && !props.canOpen(event)) {
    event.preventDefault()
    return
  }
  triggerEl.value = event.currentTarget as Element
  invocationContext.value = resolveContext()
}

function onOpenChange(nextOpen: boolean) {
  open.value = nextOpen
  emit('openChange', nextOpen)
  if (!nextOpen) {
    invocationContext.value = null
  }
}
</script>

<template>
  <ContextMenuRoot :open="open" @update:open="onOpenChange">
    <ContextMenuTrigger as-child @contextmenu="onContextMenu">
      <slot />
    </ContextMenuTrigger>

    <ContextMenuPortal :to="portalTarget">
      <ContextMenuContent
        class="command-menu-content"
        :avoid-collisions="true"
        :collision-padding="8"
        :prioritize-position="true"
        :loop="true"
      >
        <CommandMenuItems :items="items" :portal-target="portalTarget" />
      </ContextMenuContent>
    </ContextMenuPortal>
  </ContextMenuRoot>
</template>
