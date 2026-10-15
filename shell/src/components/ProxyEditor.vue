<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ProxyFields from './ProxyFields.vue'
import { store } from '../stores/app'
import { useAutosave } from '../services/autosave'
import { proxyPassword, saveProxyProfile } from '../services/proxy/profiles'
import type { ProxyProfile } from '../services/proxy/types'
import { validateProxy, type ProxyConnection, type ProxyDefinition } from '../services/transport/types'

const props = defineProps<{ profile: ProxyProfile }>()
const emit = defineEmits<{ test: [proxy: ProxyConnection] }>()
const draft = ref({ ...props.profile })
const passwordChange = ref<string | null | undefined>()
const savedPassword = ref(false)
const testError = ref('')
const fields = computed({ get: () => draft.value, set: (value: ProxyDefinition) => { draft.value = { ...draft.value, ...value } } })
onMounted(async () => { savedPassword.value = (await proxyPassword({ kind: 'saved', id: props.profile.id })) !== undefined })
const autosave = useAutosave(() => ({ profile: { ...draft.value }, password: passwordChange.value }), value => {
  if (!value.profile.name.trim()) throw new Error('请输入代理名称')
  if (store.proxies.some(item => item.id !== value.profile.id && item.name === value.profile.name.trim())) throw new Error('已存在同名代理')
  validateProxy(value.profile, value.password ?? undefined)
}, async value => {
  await saveProxyProfile(value.profile, value.password)
  if (value.password !== undefined) savedPassword.value = value.password !== null
})
async function test() {
  testError.value = ''
  try {
    const definition = { ...draft.value }
    const password = passwordChange.value === null ? undefined : passwordChange.value ?? await proxyPassword({ kind: 'saved', id: definition.id })
    validateProxy(definition, password)
    emit('test', { ...definition, password })
  } catch (reason) { testError.value = reason instanceof Error ? reason.message : String(reason) }
}
defineExpose({ flush: autosave.flush })
</script>

<template>
  <section class="proxy-editor" aria-label="代理配置">
    <div class="proxy-field"><label for="proxy-name">代理名称</label><input id="proxy-name" v-model="draft.name" placeholder="例如：办公室代理" autocomplete="off"></div>
    <ProxyFields v-model="fields" v-model:password-change="passwordChange" :saved-password="savedPassword" />
    <div class="proxy-editor-footer"><span class="settings-save-status" role="status">{{ autosave.status.value }}</span><button type="button" class="settings-reset-all" @click="test">测试代理</button></div>
    <p v-if="autosave.error.value || testError" class="error" role="alert">{{ autosave.error.value || testError }}</p>
  </section>
</template>
