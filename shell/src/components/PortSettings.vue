<script setup lang="ts">
import { ref } from 'vue'
import { portPreferences, setPortBindHost } from '../services/ports/runtime'
import { useAutosave } from '../services/autosave'
import SettingsPage from './SettingsPage.vue'
import AutosaveStatus from './AutosaveStatus.vue'

const host = ref(portPreferences.host)
const autosave = useAutosave(host, () => {}, setPortBindHost)
defineExpose({ flush: autosave.flush })
</script>
<template>
  <SettingsPage title="端口转发" description="管理所有会话的本机监听范围，修改后自动保存。">
    <template #status><AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value || portPreferences.error" /></template>
    <div class="settings-field settings-field--compact">
      <label for="port-bind-host">本机监听地址</label>
      <select id="port-bind-host" v-model="host" aria-describedby="port-bind-description port-bind-impact">
        <option value="127.0.0.1">本机（127.0.0.1）</option>
        <option value="0.0.0.0">所有接口（0.0.0.0）</option>
      </select>
    </div>
    <p id="port-bind-description" class="settings-description">默认仅本机可访问。选择所有接口后，其他设备也可以通过本机 IP 访问转发端口。</p>
    <p id="port-bind-impact" class="settings-description">此设置用于所有会话。修改后会重新开启已勾选的转发，现有连接将断开。</p>
  </SettingsPage>
</template>
