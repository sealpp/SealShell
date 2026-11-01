<script setup lang="ts">
import { defaultModelParameters, protocolLabels, type ModelService, type ServiceModel } from '../services/modelServices/types'
const props = defineProps<{ model: ServiceModel; service: ModelService; busy: boolean; result?: string }>()
defineEmits<{ test: []; remove: [] }>()
function temperature(event: Event) { const value = (event.target as HTMLInputElement).value; props.model.parameters.temperature = value === '' ? null : Number(value) }
function reset() { props.model.parameters = defaultModelParameters() }
</script>
<template>
  <div class="model-row">
    <div class="model-row-heading">
      <div><strong>{{ model.name || model.id }}</strong><small>{{ model.id }}</small></div>
      <button type="button" class="settings-reset-all" :disabled="busy" :aria-label="`检测模型 ${model.id}`" @click="$emit('test')">检测</button>
      <button type="button" class="settings-icon-button" :aria-label="`删除模型 ${model.id}`" :disabled="busy" @click="$emit('remove')"><span class="codicon codicon-trash" aria-hidden="true" /></button>
    </div>
    <p v-if="result" class="model-test-result" role="status">{{ result }}</p>
    <details class="settings-help model-advanced">
      <summary>高级配置</summary>
      <div class="settings-fields-grid">
        <label class="settings-field">显示名称<input v-model="model.name" :aria-label="`${model.id} 显示名称`"></label>
        <label class="settings-field">接口协议<select v-model="model.protocol" :aria-label="`${model.id} 接口协议`"><option value="inherit">继承服务 · {{ protocolLabels[service.protocol] }}</option><option v-for="(label, key) in protocolLabels" :key="key" :value="key">{{ label }}</option></select></label>
        <label class="settings-field">上下文预算（tokens）<input v-model.number="model.parameters.contextWindow" type="number" min="1024" max="10000000" step="1024" :aria-label="`${model.id} 上下文预算`"></label>
        <label class="settings-field">最大输出（tokens）<input v-model.number="model.parameters.maxOutputTokens" type="number" min="1" max="1000000" :aria-label="`${model.id} 最大输出`"></label>
        <label class="settings-field">温度<input :value="model.parameters.temperature" type="number" min="0" :max="(model.protocol === 'inherit' ? service.protocol : model.protocol) === 'anthropic' ? 1 : 2" step="0.1" placeholder="服务默认" :aria-label="`${model.id} 温度`" @input="temperature"></label>
        <label class="settings-field">超时（秒）<input v-model.number="model.parameters.timeoutSeconds" type="number" min="1" max="180" :aria-label="`${model.id} 超时`"></label>
        <label class="settings-field">深度思考<select v-model="model.parameters.thinking" :aria-label="`${model.id} 深度思考`"><option value="auto">服务默认</option><option value="off">关闭</option><option value="on">开启</option></select></label>
        <label v-if="(model.protocol === 'inherit' ? service.protocol : model.protocol) !== 'anthropic'" class="settings-field">思考强度<select v-model="model.parameters.reasoningEffort" :aria-label="`${model.id} 思考强度`"><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
      </div>
      <p class="settings-description">上下文预算用于限制本应用的输入；实际容量以模型服务为准。温度留空采用服务默认值。思考选项仅适用于支持该能力的模型。</p>
      <button class="settings-reset-all" type="button" @click="reset">恢复默认参数</button>
    </details>
  </div>
</template>
