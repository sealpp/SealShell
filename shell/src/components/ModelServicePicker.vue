<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UiDialog from './UiDialog.vue'
import { servicePresets, type ServicePreset } from '../services/modelServices/presets'

const props = defineProps<{ open: boolean; busy: boolean; error: string }>()
const emit = defineEmits<{ close: []; select: [preset: ServicePreset]; closeAutoFocus: [event: Event] }>()
const search = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const custom = servicePresets.find(preset => preset.region === 'custom')!
const groups = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return [{ region: 'cn', label: '国内平台' }, { region: 'global', label: '国外平台' }].map(group => ({
    ...group,
    presets: servicePresets.filter(preset => preset.region === group.region && `${preset.name} ${preset.id} ${preset.baseUrl}`.toLocaleLowerCase().includes(query)),
  })).filter(group => group.presets.length)
})
watch(() => props.open, open => { if (open) search.value = '' })
function focusSearch(event: Event) { event.preventDefault(); searchInput.value?.focus() }
function host(preset: ServicePreset) { return new URL(preset.baseUrl).host }
</script>

<template>
  <UiDialog :open="open" title="添加模型服务" description="选择平台后填写 API Key，或自定义 API 地址和协议。" width="600px" content-class="model-service-picker" :show-close="!busy" @close="emit('close')" @open-auto-focus="focusSearch" @close-auto-focus="emit('closeAutoFocus', $event)">
    <label class="settings-field model-preset-search">搜索平台<input ref="searchInput" v-model="search" type="search" placeholder="平台名称或 API 地址" :disabled="busy"></label>
    <p v-if="error" role="alert" class="model-error">{{ error }}</p>
    <p v-if="busy" role="status" class="settings-description">正在添加服务…</p>
    <div class="model-preset-groups" :aria-busy="busy">
      <section v-for="group in groups" :key="group.region" :aria-label="group.label">
        <h3>{{ group.label }}</h3>
        <div class="model-preset-grid">
          <button v-for="preset in group.presets" :key="preset.id" type="button" class="model-preset-option" :aria-label="`添加 ${preset.name}`" :disabled="busy" @click="emit('select', preset)">
            <span><strong>{{ preset.name }}</strong><small>{{ host(preset) }}</small></span>
            <span class="codicon codicon-add" aria-hidden="true" />
          </button>
        </div>
      </section>
      <p v-if="!groups.length" class="settings-description" role="status">没有匹配的平台，可以使用下方的自定义服务。</p>
    </div>
    <button type="button" class="model-preset-option model-preset-custom" aria-label="添加自定义服务" :disabled="busy" @click="emit('select', custom)">
      <span><strong>自定义服务</strong><small>填写 API 地址，选择 OpenAI 或 Anthropic 协议</small></span>
      <span class="codicon codicon-add" aria-hidden="true" />
    </button>
    <template #actions><button type="button" class="workbench-dialog-button" :disabled="busy" @click="emit('close')">取消</button></template>
  </UiDialog>
</template>
