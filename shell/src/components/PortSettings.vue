<script setup lang="ts">
import { computed, ref } from 'vue'
import { portPreferences, setPortBindHost } from '../services/ports/runtime'
import { useAutosave } from '../services/autosave'
import SettingsPage from './SettingsPage.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import AutosaveStatus from './AutosaveStatus.vue'

const host = ref(portPreferences.host)
const allowRemote = computed({ get: () => host.value === '0.0.0.0', set: value => { host.value = value ? '0.0.0.0' : '127.0.0.1' } })
const autosave = useAutosave(host, () => {}, setPortBindHost)
defineExpose({ flush: autosave.flush })
</script>
<template>
  <SettingsPage title="端口转发">
    <template #status><AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value || portPreferences.error" /></template>
    <SettingsSwitch v-model="allowRemote" label="允许其他设备访问" :description="allowRemote ? '通过本机 IP 连接转发端口。' : '仅此设备可连接转发端口。'" />
    <p class="settings-description">更改会断开现有转发连接。</p>
  </SettingsPage>
</template>
