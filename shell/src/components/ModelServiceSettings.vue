<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import ModelPicker from './ModelPicker.vue'
import ModelServiceEditor from './ModelServiceEditor.vue'
import ModelServicePicker from './ModelServicePicker.vue'
import type { ServicePreset } from '../services/modelServices/presets'
import { deleteModelService, modelServices, newModelService, saveModelService, setPrimaryModel } from '../services/modelServices/catalog'
import { confirmDialog } from '../services/dialogs'
import { commandSuggestions } from '../services/terminalSuggestions/runtime'
import type { ModelSelection } from '../services/modelServices/types'
const selectedId = ref(modelServices.services[0]?.id ?? ''), error = ref('')
const pickerOpen = ref(false), adding = ref(false), addError = ref('')
const addButton = ref<HTMLButtonElement | null>(null)
const serviceList = ref<HTMLElement | null>(null)
let focusNewService: boolean | undefined
const editor = ref<InstanceType<typeof ModelServiceEditor> | null>(null)
const selected = computed(() => modelServices.services.find(item => item.id === selectedId.value))
async function flush(): Promise<boolean> { return await editor.value?.flush() ?? true }
async function select(id: string) { if (await flush()) selectedId.value = id }
async function openPicker() {
  if (!await flush()) return
  addError.value = ''; pickerOpen.value = true
}
function closePicker() { if (!adding.value) pickerOpen.value = false }
async function add(preset: ServicePreset) {
  if (adding.value) return
  adding.value = true; addError.value = ''
  try {
    const service = newModelService(preset)
    const names = new Set(modelServices.services.map(item => item.name))
    for (let suffix = 2; names.has(service.name); suffix++) service.name = `${preset.name} ${suffix}`
    await saveModelService(service)
    selectedId.value = service.id; error.value = ''
    focusNewService = preset.region === 'custom'; pickerOpen.value = false
  } catch (reason) { addError.value = reason instanceof Error ? reason.message : String(reason) }
  finally { adding.value = false }
}
async function onPickerClosed(event: Event) {
  event.preventDefault()
  await nextTick()
  if (focusNewService !== undefined) {
    serviceList.value?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' })
    editor.value?.focusConfiguration(focusNewService); focusNewService = undefined
  } else addButton.value?.focus()
}
async function primary(choice: ModelSelection) {
  try { await setPrimaryModel(choice.mode === 'custom' ? choice.model : null); error.value = '' }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
async function remove() {
  const service = selected.value
  if (!service || !await flush()) return
  const affected: string[] = []
  if (modelServices.primary?.serviceId === service.id) affected.push('主模型及继承主模型的功能')
  const choice = commandSuggestions.modelSelection
  if (choice.mode === 'custom' && choice.model?.serviceId === service.id) affected.push('智能命令提示')
  if (!await confirmDialog('删除模型服务', `删除「${service.name}」、已添加模型及 API Key？${affected.length ? `\n当前用于：${affected.join('、')}。删除后需重新选择模型。` : ''}`, { danger: true, confirmLabel: '删除' })) return
  try { await deleteModelService(service.id); selectedId.value = modelServices.services[0]?.id ?? ''; error.value = '' }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
}
defineExpose({ flush })
</script>
<template>
  <SettingsPage title="模型服务" class="model-services-settings">
    <ModelPicker :model-value="{ mode: 'custom', model: modelServices.primary }" :allow-inherit="false" label="主模型" @update:model-value="primary" />
    <p class="settings-description">各 AI 功能默认继承主模型，也可以在功能设置中独立选择。</p>
    <p v-if="error" role="alert" class="model-error">{{ error }}</p>
    <div class="model-service-layout">
      <aside class="model-service-list" aria-label="模型服务列表">
        <div class="model-service-list-heading"><h3>已配置服务</h3><span>{{ modelServices.services.length }}</span></div>
        <div ref="serviceList" class="model-service-items workbench-selection-container" role="group" aria-label="已配置模型服务">
          <p v-if="!modelServices.services.length" class="model-service-list-empty">暂无服务</p>
          <button v-for="service in modelServices.services" :key="service.id" type="button" class="settings-nav-item workbench-list-item" :class="{ selected: selectedId === service.id }" :aria-pressed="selectedId === service.id" @click="select(service.id)">{{ service.name }}</button>
        </div>
        <div class="model-service-list-footer"><button ref="addButton" type="button" class="settings-reset-all model-service-add" @click="openPicker"><span class="codicon codicon-add" aria-hidden="true" />添加服务</button></div>
      </aside>
      <div v-if="selected" class="model-service-detail"><div class="model-service-heading"><h3>{{ selected.name }}</h3><button type="button" class="settings-icon-button" aria-label="删除模型服务" @click="remove"><span class="codicon codicon-trash" aria-hidden="true" /></button></div><ModelServiceEditor :key="selected.id" ref="editor" :service="selected" /></div>
      <div v-else class="model-service-empty"><span class="codicon codicon-cloud" aria-hidden="true" /><h3>添加第一个模型服务</h3><p class="settings-description">点击「添加服务」选择平台，再填写 API Key 并添加模型。</p></div>
    </div>
    <ModelServicePicker :open="pickerOpen" :busy="adding" :error="addError" @close="closePicker" @select="add" @close-auto-focus="onPickerClosed" />
  </SettingsPage>
</template>
