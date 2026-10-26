<script setup lang="ts">
import { ref } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import { store } from '../stores/app'
import UiDialog from './UiDialog.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import ProxySettings from './ProxySettings.vue'
import PortSettings from './PortSettings.vue'
import CommandSuggestionSettings from './CommandSuggestionSettings.vue'
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
        <TabsTrigger value="suggestions" class="settings-nav-item workbench-list-item">命令提示</TabsTrigger>
        <TabsTrigger value="proxies" class="settings-nav-item workbench-list-item">代理服务器</TabsTrigger>
        <TabsTrigger value="ports" class="settings-nav-item workbench-list-item">端口转发</TabsTrigger>
      </TabsList>
      <TabsContent :key="store.settingsSection" :value="store.settingsSection" class="settings-page">
        <AppearanceSettings v-if="store.settingsSection === 'appearance'" ref="page" />
        <ProxySettings v-else-if="store.settingsSection === 'proxies'" ref="page" />
        <CommandSuggestionSettings v-else-if="store.settingsSection === 'suggestions'" ref="page" />
        <PortSettings v-else ref="page" />
      </TabsContent>
    </TabsRoot>
  </UiDialog>
</template>
