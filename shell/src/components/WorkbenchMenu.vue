<script setup lang="ts">
import { IconSettings } from '../ui/icons'
import CommandDropdownMenu from './CommandDropdownMenu.vue'
import { MenuId } from '../services/actions/menuIds'
</script>

<template>
  <CommandDropdownMenu
    :menu-id="MenuId.Workbench"
    :context="{ area: 'global' }"
    content-class="workbench-menu"
    side="top"
    align="end"
    :side-offset="4"
    item-class="workbench-menu-item"
  >
    <template #trigger>
      <button
        type="button"
        class="workbench-menu-trigger workbench-activity-button"
        aria-label="设置和关于"
        title="设置和关于"
      >
        <IconSettings :size="24" aria-hidden="true" />
      </button>
    </template>

  </CommandDropdownMenu>
</template>
