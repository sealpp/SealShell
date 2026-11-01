<script setup lang="ts">
import { computed } from 'vue'
import { modelServices, modelReferenceLabel } from '../services/modelServices/catalog'
import type { ModelReference, ModelSelection } from '../services/modelServices/types'
const props = withDefaults(defineProps<{ modelValue: ModelSelection; allowInherit?: boolean; label?: string }>(), { allowInherit: true, label: '模型' })
const emit = defineEmits<{ 'update:modelValue': [value: ModelSelection] }>()
const encode = (model: ModelReference | null) => model ? JSON.stringify(model) : ''
const value = computed(() => props.modelValue.mode === 'inherit' ? 'inherit' : encode(props.modelValue.model))
const missing = computed(() => {
  const choice = props.modelValue
  return choice.mode === 'custom' && choice.model && !modelServices.services.some(service => service.id === choice.model?.serviceId && service.models.some(model => model.id === choice.model?.modelId))
})
function change(event: Event) {
  const selected = (event.target as HTMLSelectElement).value
  emit('update:modelValue', selected === 'inherit' ? { mode: 'inherit' } : { mode: 'custom', model: selected ? JSON.parse(selected) : null })
}
</script>
<template>
  <label class="settings-field">{{ label }}
    <select :aria-label="label" :value="value" @change="change">
      <option v-if="allowInherit" value="inherit">继承主模型 · {{ modelReferenceLabel(modelServices.primary) }}</option>
      <option value="">请选择模型</option>
      <option v-if="missing" :value="value" disabled>模型已删除，请重新选择</option>
      <optgroup v-for="service in modelServices.services.filter(item => item.models.length)" :key="service.id" :label="service.name">
        <option v-for="model in service.models" :key="model.id" :value="encode({ serviceId: service.id, modelId: model.id })">{{ model.name || model.id }} · {{ model.id }}</option>
      </optgroup>
    </select>
  </label>
</template>
