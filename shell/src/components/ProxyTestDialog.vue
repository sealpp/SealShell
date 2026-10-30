<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import UiDialog from './UiDialog.vue'
import UiStatus from './UiStatus.vue'
import { nativeCall } from '../native/bridge'
import { normalizeTarget, type ProxyConnection, type TcpTarget } from '../services/transport/types'

const props = defineProps<{ proxy: ProxyConnection; target?: TcpTarget }>()
const emit = defineEmits<{ close: [] }>()
const host = ref(props.target?.host ?? '')
const port = ref(props.target?.port ?? 22)
const running = ref(false)
const message = ref('')
const error = ref('')
let requestId: string | undefined

async function test() {
  error.value = ''
  message.value = ''
  running.value = true
  const started = performance.now()
  try {
    const target = normalizeTarget({ host: host.value, port: port.value })
    requestId = crypto.randomUUID()
    message.value = '正在通过代理连接目标…'
    await nativeCall('proxy_test', { id: requestId, host: target.host, port: target.port, proxy: props.proxy })
    message.value = `连接成功，耗时 ${Math.round(performance.now() - started)} ms。`
  } catch (reason) {
    message.value = ''
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    requestId = undefined
    running.value = false
  }
}
onBeforeUnmount(() => { if (requestId) void nativeCall('proxy_cancel', { id: requestId }) })
</script>

<template>
  <UiDialog :open="true" title="测试代理" width="460px" @close="emit('close')">
    <p class="proxy-caption">{{ proxy.type === 'http' ? 'HTTP CONNECT' : 'SOCKS5' }} · {{ proxy.host }}:{{ proxy.port }}</p>
    <div class="proxy-grid">
      <div class="proxy-field"><label for="proxy-test-host">测试目标地址</label><input id="proxy-test-host" v-model="host" :readonly="!!target" placeholder="目标主机或域名" :disabled="running"></div>
      <div class="proxy-field"><label for="proxy-test-port">测试目标端口</label><input id="proxy-test-port" v-model.number="port" type="number" min="1" max="65535" :readonly="!!target" :disabled="running"></div>
    </div>
    <UiStatus v-if="error || message" :kind="error ? 'error' : running ? 'busy' : 'success'" :label="error || message" />
    <template #actions><button type="button" class="workbench-dialog-button workbench-dialog-button--primary" :disabled="running" @click="test">{{ running ? '测试中…' : '开始测试' }}</button></template>
  </UiDialog>
</template>
