<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store } from '../stores/app'
import { useAutosave } from '../services/autosave'
import { confirmDialog } from '../services/dialogs'
import { hasModelServiceKey, modelServices, newServiceModel, saveModelService, validateService } from '../services/modelServices/catalog'
import { checkModel, discoverModels } from '../services/modelServices/client'
import { apiEndpoint } from '../services/modelServices/protocol'
import { protocolLabels, type DiscoveredModel, type ModelService, type ServiceModel } from '../services/modelServices/types'
import { commandSuggestions } from '../services/terminalSuggestions/runtime'
import AutosaveStatus from './AutosaveStatus.vue'
import ServiceModelRow from './ServiceModelRow.vue'
const props = defineProps<{ service: ModelService }>()
const draft = ref<ModelService>(JSON.parse(JSON.stringify(props.service)))
const apiKey = ref<string | undefined>(), hasKey = ref(false)
let savedKey: string | undefined
const autosave = useAutosave(() => ({ service: JSON.parse(JSON.stringify(draft.value)) as ModelService, apiKey: apiKey.value }), value => validateService(value.service), async value => {
  await saveModelService(value.service, value.apiKey === savedKey ? undefined : value.apiKey)
  if (value.apiKey !== undefined) { savedKey = value.apiKey; hasKey.value = !!value.apiKey.trim() }
})
const busy = ref(''), error = ref(''), status = ref(''), search = ref(''), online = ref<DiscoveredModel[] | null>(null)
const modelResults = ref<Record<string, string>>({}), manualId = ref(''), manualName = ref('')
let request: AbortController | undefined
const filtered = computed(() => (online.value ?? []).filter(model => `${model.id} ${model.name}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())))
const endpoints = computed(() => { try { return { models: apiEndpoint(draft.value.baseUrl, draft.value.protocol, 'models'), generate: apiEndpoint(draft.value.baseUrl, draft.value.protocol, 'generate') } } catch { return null } })
onMounted(async () => { try { hasKey.value = await hasModelServiceKey(draft.value.id) } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) } })
onBeforeUnmount(() => request?.abort())
watch(() => JSON.stringify(draft.value), () => { request?.abort(); modelResults.value = {} })
watch(() => [draft.value.baseUrl, draft.value.protocol, JSON.stringify(draft.value.proxy), apiKey.value], () => { request?.abort(); online.value = null; status.value = ''; error.value = ''; modelResults.value = {} })
async function flush(): Promise<boolean> { return await autosave.flush() }
async function run(kind: string, operation: (signal: AbortSignal, snapshot: ModelService) => Promise<void>) {
  error.value = ''; status.value = ''
  if (!await flush() || autosave.state.value === 'invalid') { error.value = autosave.error.value; return }
  request?.abort(); const controller = new AbortController(); request = controller; busy.value = kind
  try { await operation(controller.signal, JSON.parse(JSON.stringify(draft.value))) }
  catch (reason) { if (!controller.signal.aborted) error.value = reason instanceof Error ? reason.message : String(reason); else status.value = '已取消检测' }
  finally { if (request === controller) { busy.value = ''; request = undefined } }
}
async function fetchModels(check = false) {
  online.value = null
  await run(check ? 'api' : 'list', async (signal, snapshot) => {
    const started = performance.now()
    const models = await discoverModels(snapshot, signal)
    if (!check) online.value = models
    status.value = `${check ? 'API 模型列表可用' : '已获取在线模型'} · ${models.length} 个 · ${Math.round(performance.now() - started)} ms`
  })
}
async function testModel(model: ServiceModel) {
  await run(model.id, async (signal, snapshot) => {
    try {
      const selected = snapshot.models.find(item => item.id === model.id)!
      const latency = await checkModel({ service: snapshot, model: selected, protocol: selected.protocol === 'inherit' ? snapshot.protocol : selected.protocol }, signal)
      modelResults.value[model.id] = `可用 · ${latency} ms`
    } catch (reason) { modelResults.value[model.id] = reason instanceof Error ? reason.message : String(reason); throw reason }
  })
}
function addModel(model: DiscoveredModel) {
  const id = model.id.trim()
  if (!id || draft.value.models.some(item => item.id === id)) return
  draft.value.models.push(newServiceModel(draft.value, { ...model, id }))
}
function addManual() { addModel({ id: manualId.value, name: manualName.value }); manualId.value = ''; manualName.value = '' }
function references(modelId: string): string {
  const primary = modelServices.primary
  const labels: string[] = []
  if (primary?.serviceId === draft.value.id && primary.modelId === modelId) labels.push('主模型及继承主模型的功能')
  const choice = commandSuggestions.modelSelection
  if (choice.mode === 'custom' && choice.model?.serviceId === draft.value.id && choice.model.modelId === modelId) labels.push('智能命令提示')
  return labels.length ? `\n当前用于：${labels.join('、')}。删除后需重新选择模型。` : ''
}
async function removeModel(model: ServiceModel) {
  if (!await confirmDialog('删除模型', `删除「${model.name || model.id}」？${references(model.id)}`, { danger: true, confirmLabel: '删除' })) return
  draft.value.models = draft.value.models.filter(item => item.id !== model.id)
}
function setProxy(event: Event) {
  const mode = (event.target as HTMLSelectElement).value
  draft.value.proxy = mode === 'saved' ? { mode, id: store.proxies[0]?.id ?? '' } : { mode: mode as 'direct' | 'system' }
}
async function proxies() { if (await flush()) store.settingsSection = 'proxies' }
defineExpose({ flush })
</script>
<template>
  <section class="model-service-editor" :aria-label="`${service.name} 配置`">
    <AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value" />
    <div class="settings-fields-grid">
      <label class="settings-field">服务名称<input v-model="draft.name"></label>
      <label class="settings-field">默认协议<select v-model="draft.protocol" aria-label="默认协议"><option v-for="(label, key) in protocolLabels" :key="key" :value="key">{{ label }}</option></select></label>
      <label class="settings-field settings-field--wide">API 地址<input v-model="draft.baseUrl" type="url" spellcheck="false" placeholder="https://api.example.com/v1"></label>
      <div class="settings-field settings-field--wide"><label for="model-api-key">API Key</label><span class="settings-secret-control"><input id="model-api-key" v-model="apiKey" type="password" autocomplete="new-password" :placeholder="hasKey ? '已保存，输入可更换' : '输入 API Key'"><button v-if="hasKey || apiKey" class="settings-icon-button" type="button" aria-label="清除 API Key" @click="apiKey = ''"><span class="codicon codicon-trash" aria-hidden="true" /></button></span></div>
      <label class="settings-field">连接方式<select :value="draft.proxy.mode" aria-label="连接方式" @change="setProxy"><option value="direct">直连</option><option value="system">跟随系统代理</option><option value="saved" :disabled="!store.proxies.length">指定代理</option></select></label>
      <label v-if="draft.proxy.mode === 'saved'" class="settings-field">代理服务器<select v-model="draft.proxy.id" aria-label="代理服务器"><option v-if="!store.proxies.some(item => draft.proxy.mode === 'saved' && item.id === draft.proxy.id)" :value="draft.proxy.id" disabled>代理已删除，请重新选择</option><option v-for="proxy in store.proxies" :key="proxy.id" :value="proxy.id">{{ proxy.name }}</option></select></label>
    </div>
    <button type="button" class="proxy-text-button" @click="proxies">管理代理服务器</button>
    <details v-if="endpoints" class="settings-help"><summary>实际请求地址</summary><p class="settings-description">模型列表：{{ endpoints.models }}<br>默认生成接口：{{ endpoints.generate }}</p></details>
    <div class="model-toolbar"><button class="settings-reset-all" type="button" :disabled="!!busy" @click="fetchModels(true)">检测 API 地址</button><button class="settings-reset-all" type="button" :disabled="!!busy" @click="fetchModels(false)">获取模型列表</button><button v-if="busy" class="settings-reset-all" type="button" @click="request?.abort()">取消</button></div>
    <p v-if="busy" role="status" class="settings-description">{{ busy === 'list' ? '正在获取模型列表…' : '正在检测…' }}</p>
    <p v-if="status" role="status" class="model-test-result">{{ status }}</p><p v-if="error" role="alert" class="model-error">{{ error }}</p>
    <p v-if="error" class="settings-description">模型列表不可用不代表生成接口不可用，可以手动填写模型 ID 后检测。</p>
    <div v-if="online !== null" class="model-online-list"><label class="settings-field">在线模型<input v-model="search" type="search" placeholder="搜索模型名称或 ID"></label><p class="settings-description">点击加号添加到此服务。在线列表不会自动添加或删除已配置模型。</p><p v-if="!filtered.length" class="settings-description">没有匹配的在线模型，可手动填写模型 ID。</p><div v-for="model in filtered" :key="model.id" class="model-online-row"><div><span>{{ model.name }}</span><small>{{ model.id }}</small></div><button type="button" class="settings-icon-button" :disabled="draft.models.some(item => item.id === model.id)" :aria-label="`添加模型 ${model.id}`" @click="addModel(model)"><span :class="['codicon', draft.models.some(item => item.id === model.id) ? 'codicon-check' : 'codicon-add']" aria-hidden="true" /></button></div></div>
    <fieldset class="settings-group"><legend class="settings-section-title">已添加模型</legend><p v-if="!draft.models.length" class="settings-description">获取在线列表后添加，或填写模型 ID。添加后可选择为主模型或功能模型。</p><ServiceModelRow v-for="model in draft.models" :key="model.id" :model="model" :service="draft" :busy="!!busy" :result="modelResults[model.id]" @test="testModel(model)" @remove="removeModel(model)" /></fieldset>
    <form class="model-manual-form" @submit.prevent="addManual"><label class="settings-field">模型 ID<input v-model="manualId" spellcheck="false" required placeholder="填写服务提供的模型 ID"></label><label class="settings-field">显示名称（可选）<input v-model="manualName"></label><button type="submit" class="settings-reset-all" :disabled="!manualId.trim()">添加模型</button></form>
    <p class="settings-description">模型检测会发起一次简短生成请求，可能产生少量调用费用。检测失败不阻止保存配置。</p>
  </section>
</template>
