<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../stores/app'
import { commandService } from '../services/commands'
import CommandContextMenu from '../components/CommandContextMenu.vue'
import type { CommandContext } from '../services/context'
import { TAB_MENU_ID } from '../services/actions/menuIds'
import { IconFileText, IconFolder, IconTerminal2, IconX } from '../ui/icons'

const props = defineProps<{
  params: {
    params: { tabId: string; [key: string]: any }
    api: {
      id: string
      title: string | undefined
      close: () => void
      [key: string]: any
    }
    [key: string]: any
  }
}>()

const tabId = computed(() => props.params?.params?.tabId ?? '')
const tab = computed(() => store.tabs.find((t) => t.id === tabId.value))
const title = computed(() => tab.value?.label || props.params?.api?.title || tabId.value)
const icon = computed(() => {
  if (tab.value?.kind === 'file') return IconFolder
  if (tab.value?.kind === 'editor') return IconFileText
  return IconTerminal2
})

const dotClass = computed(() => {
  const state = tab.value?.state
  if (state === 'online') return 'dot online'
  if (state === 'connecting') return 'dot connecting'
  return 'dot offline'
})

function onClose() {
  if (tabId.value) {
    void commandService.execute('tab.close', tabContext())
  } else {
    props.params.api.close()
  }
}

function tabGroupTabIds(): string[] {
  const panels = props.params?.api?.group?.panels as Array<{ id?: string }> | undefined
  if (!Array.isArray(panels)) return tabId.value ? [tabId.value] : []
  return panels.map((panel) => panel.id).filter((id): id is string => !!id)
}

function tabContext(): CommandContext {
  return {
    area: 'tab',
    tabId: tabId.value,
    tabGroupTabIds: tabGroupTabIds(),
  }
}

function onDoubleClick() {
  if (!tabId.value || tab.value?.kind !== 'terminal') return
  void commandService.execute('terminal.newTab', tabContext())
}
</script>

<template>
  <CommandContextMenu
    v-if="tab"
    :menu-id="TAB_MENU_ID"
    :context="tabContext"
  >
    <div class="terminal-tab" @dblclick="onDoubleClick">
      <component :is="icon" :size="16" class="terminal-tab-icon" />
      <span :class="dotClass" />
      <span class="terminal-tab-label" :title="title">{{ title }}</span>
      <button
        type="button"
        class="terminal-tab-close"
        title="断开连接"
        @click.stop="onClose"
        @dblclick.stop
      >
        <IconX :size="16" />
      </button>
    </div>
  </CommandContextMenu>
</template>

<style scoped>
.terminal-tab {
  height: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  user-select: none;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot.online {
  background: var(--workbench-success);
}

.dot.connecting {
  background: var(--workbench-warning);
}

.dot.offline {
  background: var(--workbench-error);
}

.terminal-tab-label {
  flex: 1;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.terminal-tab-close {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  padding: 0;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.7;
}

.terminal-tab-close:hover {
  background: var(--workbench-toolbar-hover-bg);
  color: var(--workbench-text-strong);
  opacity: 1;
}
</style>
