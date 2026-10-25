<script setup lang="ts">
import { IconCheck, IconChevronRight } from '../ui/icons'
import {
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from 'reka-ui'
import type { ResolvedMenuItem } from '../services/commands'

const props = withDefaults(defineProps<{
  items: ResolvedMenuItem[]
  portalTarget?: HTMLElement
  itemClass?: string
}>(), {
  itemClass: 'command-menu-item',
})

function execute(item: ResolvedMenuItem) {
  if (item.disabled || !item.action) return
  void item.action()
}
</script>

<template>
  <template v-for="item in props.items" :key="item.id">
    <DropdownMenuSeparator v-if="item.separator" class="command-menu-separator" />
    <DropdownMenuSub v-else-if="item.children?.length">
      <DropdownMenuSubTrigger :class="['command-menu-item', props.itemClass]" :disabled="item.disabled">
        <span class="command-menu-check"><IconCheck v-if="item.checked" /></span>
        <component :is="item.icon" v-if="item.icon" :size="16" aria-hidden="true" />
        <span class="command-menu-label">{{ item.label }}</span>
        <span class="command-menu-shortcut">{{ item.shortcut ?? '' }}</span>
        <span class="command-menu-chevron"><IconChevronRight /></span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal :to="props.portalTarget">
        <DropdownMenuSubContent
          class="command-menu-content"
          :avoid-collisions="true"
          :collision-padding="8"
          :side-flip="true"
          :prioritize-position="true"
        >
          <CommandDropdownMenuItems
            :items="item.children"
            :portal-target="props.portalTarget"
            :item-class="props.itemClass"
          />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
    <DropdownMenuItem
      v-else
      :class="['command-menu-item', props.itemClass]"
      :disabled="item.disabled"
      @select="execute(item)"
    >
      <span class="command-menu-check"><IconCheck v-if="item.checked" /></span>
      <component :is="item.icon" v-if="item.icon" :size="16" aria-hidden="true" />
      <span class="command-menu-label">{{ item.label }}</span>
      <span v-if="item.shortcut" class="command-menu-shortcut">{{ item.shortcut }}</span>
    </DropdownMenuItem>
  </template>
</template>
