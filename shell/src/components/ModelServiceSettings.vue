<script setup lang="ts">
import { computed, ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import ModelPicker from './ModelPicker.vue'
import ModelServiceEditor from './ModelServiceEditor.vue'
import { servicePresets } from '../services/modelServices/presets'
import { deleteModelService, modelServices, newModelService, saveModelService, setPrimaryModel } from '../services/modelServices/catalog'
import { confirmDialog } from '../services/dialogs'
import { commandSuggestions } from '../services/terminalSuggestions/runtime'
import type { ModelSelection } from '../services/modelServices/types'
const selectedId = ref(modelServices.services[0]?.id ?? ''), presetId = ref('deepseek'), error = ref('')
const editor = ref<InstanceType<typeof ModelServiceEditor> | null>(null)
const selected = computed(() => modelServices.services.find(item => item.id === selectedId.value))
async function flush(): Promise<boolean> { return await editor.value?.flush() ?? true }
async function select(id: string) { if (await flush()) selectedId.value = id }
async function add() {
  if (!await flush()) return
  try { const service = newModelService(servicePresets.find(item => item.id === presetId.value)!); await saveModelService(service); selectedId.value = service.id; error.value = '' }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
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
    <div class="model-add-service"><label class="settings-field">平台预设<select v-model="presetId"><optgroup label="国内平台"><option v-for="preset in servicePresets.filter(item => item.region === 'cn')" :key="preset.id" :value="preset.id">{{ preset.name }}</option></optgroup><optgroup label="国外平台"><option v-for="preset in servicePresets.filter(item => item.region === 'global')" :key="preset.id" :value="preset.id">{{ preset.name }}</option></optgroup><option value="custom">自定义服务</option></select></label><button type="button" class="settings-reset-all" @click="add">添加服务</button></div>
    <p v-if="error" role="alert" class="model-error">{{ error }}</p>
    <p v-if="!modelServices.services.length" class="settings-description">从平台预设添加服务，然后填写 API Key 并添加模型。</p>
    <div v-else class="model-service-layout">
      <div class="model-service-list workbench-selection-container" aria-label="已配置模型服务"><button v-for="service in modelServices.services" :key="service.id" type="button" class="settings-nav-item workbench-list-item" :class="{ selected: selectedId === service.id }" :aria-pressed="selectedId === service.id" @click="select(service.id)">{{ service.name }}</button></div>
      <div class="model-service-detail"><div class="model-service-heading"><h3>{{ selected?.name }}</h3><button type="button" class="settings-icon-button" aria-label="删除模型服务" @click="remove"><span class="codicon codicon-trash" aria-hidden="true" /></button></div><ModelServiceEditor v-if="selected" :key="selected.id" ref="editor" :service="selected" /></div>
    </div>
  </SettingsPage>
</template>
