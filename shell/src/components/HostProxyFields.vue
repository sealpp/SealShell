<script setup lang="ts">
import { computed, ref } from 'vue'
import { TabsContent, TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import { store } from '../stores/app'
import { copyHostProxy, type HostProxySettings } from '../services/proxy/types'
import { proxyPassword } from '../services/proxy/profiles'
import { normalizeTarget, validateProxy, type ProxyConnection, type ProxyDefinition, type TcpTarget } from '../services/transport/types'
import ProxyFields from './ProxyFields.vue'
import ProxyTestDialog from './ProxyTestDialog.vue'

const props = defineProps<{ modelValue: HostProxySettings; hostId?: string; target: TcpTarget; passwordChange?: string | null; savedPassword: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: HostProxySettings]; 'update:passwordChange': [value: string | null | undefined] }>()
const error = ref('')
const testing = ref<{ proxy: ProxyConnection; target: TcpTarget } | null>(null)
function change(patch: Partial<HostProxySettings>) { emit('update:modelValue', { ...copyHostProxy(props.modelValue), ...patch }) }
const inline = computed({ get: () => props.modelValue.inline, set: (value: ProxyDefinition) => change({ inline: value }) })
const mode = computed({ get: () => props.modelValue.mode, set: (value: string | number) => change({ mode: value as HostProxySettings['mode'] }) })

async function test() {
  error.value = ''
  try {
    const target = normalizeTarget(props.target)
    let proxy: ProxyConnection
    if (props.modelValue.mode === 'saved') {
      const saved = store.proxies.find(item => item.id === props.modelValue.savedId)
      if (!saved) throw new Error('请选择代理服务器')
      proxy = { ...saved, password: await proxyPassword({ kind: 'saved', id: saved.id }) }
    } else {
      const definition = { ...props.modelValue.inline }
      const password = props.passwordChange === null ? undefined : props.passwordChange ?? (props.hostId ? await proxyPassword({ kind: 'host', id: props.hostId }) : undefined)
      proxy = { ...definition, password }
    }
    validateProxy(proxy, proxy.password)
    testing.value = { proxy, target }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
</script>

<template>
  <section class="host-proxy" aria-label="主机代理">
    <label class="proxy-toggle"><input type="checkbox" :checked="modelValue.enabled" @change="change({ enabled: ($event.target as HTMLInputElement).checked })">使用代理</label>
    <div v-if="modelValue.enabled" class="host-proxy-body">
      <TabsRoot v-model="mode">
        <TabsList class="proxy-segments workbench-selection-container" aria-label="代理配置方式"><TabsTrigger class="workbench-segment" value="inline">直接填写</TabsTrigger><TabsTrigger class="workbench-segment" value="saved">从列表选择</TabsTrigger></TabsList>
        <TabsContent value="inline"><ProxyFields v-model="inline" :password-change="passwordChange" :saved-password="savedPassword" @update:password-change="emit('update:passwordChange', $event)" /></TabsContent>
        <TabsContent value="saved"><div class="proxy-field"><label for="host-saved-proxy">代理服务器</label><select id="host-saved-proxy" :value="modelValue.savedId ?? ''" @change="change({ savedId: ($event.target as HTMLSelectElement).value || null })"><option value="">不选择 / 清除引用</option><option v-for="profile in store.proxies" :key="profile.id" :value="profile.id">{{ profile.name }} · {{ profile.type === 'http' ? 'HTTP' : 'SOCKS5' }} · {{ profile.host }}:{{ profile.port }}</option></select><p v-if="!store.proxies.length" class="proxy-caption">请先在设置的代理服务器页面添加代理。</p></div></TabsContent>
      </TabsRoot>
      <div class="proxy-editor-footer"><span class="proxy-caption">关闭或切换方式会保留配置。</span><button type="button" class="settings-reset-all" @click="test">测试代理</button></div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
    <ProxyTestDialog v-if="testing" :proxy="testing.proxy" :target="testing.target" @close="testing = null" />
  </section>
</template>
