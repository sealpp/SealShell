<script setup lang="ts">
import { IconCheck, IconChevronRight } from '../ui/icons'
import {
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from 'reka-ui'
import type { ResolvedMenuItem } from '../services/commands'

const props = defineProps<{
  items: ResolvedMenuItem[]
  portalTarget?: HTMLElement
}>()

function execute(item: ResolvedMenuItem) {
  if (item.disabled || !item.action) return
  void item.action()
}
</script>

<template>
  <template v-for="item in props.items" :key="item.id">
    <ContextMenuSeparator v-if="item.separator" class="command-menu-separator" />
    <ContextMenuSub v-else-if="item.children?.length">
      <ContextMenuSubTrigger
        class="command-menu-item command-menu-subtrigger"
        :disabled="item.disabled"
      >
        <span class="command-menu-check"><IconCheck v-if="item.checked" /></span>
        <span class="command-menu-label">{{ item.label }}</span>
        <span class="command-menu-shortcut">{{ item.shortcut ?? '' }}</span>
        <span class="command-menu-chevron"><IconChevronRight /></span>
      </ContextMenuSubTrigger>
      <ContextMenuPortal :to="props.portalTarget">
        <ContextMenuSubContent
          class="command-menu-content"
          :avoid-collisions="true"
          :collision-padding="8"
          :side-flip="true"
          :prioritize-position="true"
        >
          <CommandMenuItems :items="item.children" :portal-target="props.portalTarget" />
        </ContextMenuSubContent>
      </ContextMenuPortal>
    </ContextMenuSub>
    <ContextMenuItem
      v-else
      class="command-menu-item"
      :disabled="item.disabled"
      @select="execute(item)"
    >
      <span class="command-menu-check"><IconCheck v-if="item.checked" /></span>
      <span class="command-menu-label">{{ item.label }}</span>
      <span v-if="item.shortcut" class="command-menu-shortcut">{{ item.shortcut }}</span>
    </ContextMenuItem>
  </template>
</template>
