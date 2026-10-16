<script setup lang="ts">
import { ref } from 'vue'
import { portPreferences, setPortBindHost } from '../services/ports/runtime'
import type { PortBindHost } from '../services/ports/types'
const saving = ref(false)
const error = ref('')
async function change(event: Event) {
  saving.value = true
  error.value = ''
  try { await setPortBindHost((event.target as HTMLSelectElement).value as PortBindHost) }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { saving.value = false }
}
defineExpose({ flush: async () => !saving.value })
</script>
<template>
  <section class="port-settings">
    <h2>端口转发</h2>
    <label for="port-bind-host">本机监听地址</label>
    <select id="port-bind-host" :value="portPreferences.host" :disabled="saving" @change="change"><option value="127.0.0.1">本机（127.0.0.1）</option><option value="0.0.0.0">所有接口（0.0.0.0）</option></select>
    <p>默认仅本机可访问。选择所有接口后，其他设备也可以通过本机 IP 访问转发端口。</p>
    <p>此设置用于所有会话。修改后会重新开启已勾选的转发，现有连接将断开。</p>
    <p v-if="error || portPreferences.error" class="error" role="alert">{{ error || portPreferences.error }}</p>
  </section>
</template>
<style scoped>
.port-settings{flex:1;min-width:0;padding:24px;color:#ccc;overflow:auto;font-size:13px}.port-settings h2{font-size:18px;font-weight:500;margin:0 0 24px}.port-settings label{display:block;margin-bottom:8px}.port-settings select{padding:6px 10px;min-width:240px;background:#3c3c3c;color:#eee;border:1px solid #555;font:inherit}.port-settings p{line-height:1.6;color:#999}.port-settings .error{color:#f48771}
</style>
