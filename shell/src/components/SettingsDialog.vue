<script setup lang="ts">
import { ref } from 'vue'
import { store } from '../stores/app'
import UiDialog from './UiDialog.vue'
import AppearanceSettings from './AppearanceSettings.vue'
import ProxySettings from './ProxySettings.vue'
import PortSettings from './PortSettings.vue'
const page = ref<{ flush(): Promise<boolean> } | null>(null)
async function close() {
  if (await page.value?.flush() === false) return
  store.settingsModalOpen = false
}
async function select(section: 'appearance' | 'proxies' | 'ports') {
  if (await page.value?.flush() === false) return
  store.settingsSection = section
}
</script>

<template>
  <UiDialog :open="store.settingsModalOpen" title="设置" width="80vw" height="80vh" content-class="settings-dialog-content" @close="close">
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="设置分类">
        <button type="button" class="settings-nav-item" :class="{ active: store.settingsSection === 'appearance' }" @click="select('appearance')">外观</button>
        <button type="button" class="settings-nav-item" :class="{ active: store.settingsSection === 'proxies' }" @click="select('proxies')">代理服务器</button>
        <button type="button" class="settings-nav-item" :class="{ active: store.settingsSection === 'ports' }" @click="select('ports')">端口转发</button>
      </nav>
      <AppearanceSettings v-if="store.settingsSection === 'appearance'" ref="page" />
      <ProxySettings v-else-if="store.settingsSection === 'proxies'" ref="page" />
      <PortSettings v-else ref="page" />
    </div>
  </UiDialog>
</template>
