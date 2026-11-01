<script setup lang="ts">
import { ref, watch } from 'vue'
import { RovingFocusItem, TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import { store } from '../stores/app'
import UiDialog from './UiDialog.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import ProxySettings from './ProxySettings.vue'
import PortSettings from './PortSettings.vue'
import CommandSuggestionSettings from './CommandSuggestionSettings.vue'
import ModelServiceSettings from './ModelServiceSettings.vue'
import HistorySuggestionSettings from './HistorySuggestionSettings.vue'
const aiExpanded = ref(true)
watch(() => store.settingsSection, section => {
  if (section === 'models' || section === 'suggestions') aiExpanded.value = true
})
const page = ref<{ flush(): Promise<boolean> } | null>(null)
async function close() {
  if (await page.value?.flush() === false) return
  store.settingsModalOpen = false
}
async function select(section: string | number) {
  if (await page.value?.flush() === false) return
  store.settingsSection = section as typeof store.settingsSection
}
</script>

<template>
  <UiDialog :open="store.settingsModalOpen" title="设置" width="80vw" height="80vh" content-class="settings-dialog-content" @close="close">
    <TabsRoot class="settings-layout" orientation="vertical" :model-value="store.settingsSection" @update:model-value="select">
      <TabsList as="nav" class="settings-nav workbench-selection-container" aria-label="设置分类" loop>
        <TabsTrigger value="appearance" class="settings-nav-item workbench-list-item">外观</TabsTrigger>
        <TabsTrigger value="history" class="settings-nav-item workbench-list-item">历史命令提示</TabsTrigger>
        <RovingFocusItem as-child><button type="button" class="settings-nav-item settings-nav-group" :aria-expanded="aiExpanded" aria-controls="ai-settings-items" @click="aiExpanded = !aiExpanded" @keydown.right.prevent.stop="aiExpanded = true" @keydown.left.prevent.stop="aiExpanded = false"><span :class="['codicon', aiExpanded ? 'codicon-chevron-down' : 'codicon-chevron-right']" aria-hidden="true" />AI 配置</button></RovingFocusItem>
        <div v-if="aiExpanded" id="ai-settings-items">
          <TabsTrigger value="models" class="settings-nav-item settings-nav-child workbench-list-item">模型服务</TabsTrigger>
          <TabsTrigger value="suggestions" class="settings-nav-item settings-nav-child workbench-list-item">智能命令提示</TabsTrigger>
        </div>
        <TabsTrigger value="proxies" class="settings-nav-item workbench-list-item">代理服务器</TabsTrigger>
        <TabsTrigger value="ports" class="settings-nav-item workbench-list-item">端口转发</TabsTrigger>
      </TabsList>
      <TabsContent :key="store.settingsSection" :value="store.settingsSection" class="settings-page">
        <AppearanceSettings v-if="store.settingsSection === 'appearance'" ref="page" />
        <ProxySettings v-else-if="store.settingsSection === 'proxies'" ref="page" />
        <CommandSuggestionSettings v-else-if="store.settingsSection === 'suggestions'" ref="page" />
        <ModelServiceSettings v-else-if="store.settingsSection === 'models'" ref="page" />
        <HistorySuggestionSettings v-else-if="store.settingsSection === 'history'" ref="page" />
        <PortSettings v-else ref="page" />
      </TabsContent>
    </TabsRoot>
  </UiDialog>
</template>
