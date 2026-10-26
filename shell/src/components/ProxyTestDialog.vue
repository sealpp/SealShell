<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import UiDialog from './UiDialog.vue'
import UiStatus from './UiStatus.vue'
import { RoutedTransport } from '../services/transport/routed-transport'
import { normalizeTarget, type ProxyConnection, type TcpTarget } from '../services/transport/types'

const props = defineProps<{ proxy: ProxyConnection; target?: TcpTarget }>()
const emit = defineEmits<{ close: [] }>()
const host = ref(props.target?.host ?? '')
const port = ref(props.target?.port ?? 22)
const running = ref(false)
const message = ref('')
const error = ref('')
let transport: RoutedTransport | undefined

async function test() {
  error.value = ''
  message.value = ''
  running.value = true
  const started = performance.now()
  try {
    const target = normalizeTarget({ host: host.value, port: port.value })
    transport = new RoutedTransport()
    await transport.connect(target.host, target.port, props.proxy, stage => {
      message.value = { connect: '正在连接代理…', authenticate: '正在协商代理认证…', target: '正在通过代理连接目标…' }[stage]
    })
    message.value = `连接成功，耗时 ${Math.round(performance.now() - started)} ms。`
  } catch (reason) {
    message.value = ''
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    await transport?.close('proxy_test_finished')
    transport = undefined
    running.value = false
  }
}
onBeforeUnmount(() => { void transport?.close('proxy_test_closed') })
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
