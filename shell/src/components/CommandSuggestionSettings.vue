<script setup lang="ts">
import { ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import AutosaveStatus from './AutosaveStatus.vue'
import ModelPicker from './ModelPicker.vue'
import { useAutosave } from '../services/autosave'
import { commandSuggestions, saveSuggestionPreferences } from '../services/terminalSuggestions/runtime'
import { modelReferenceLabel, modelServices } from '../services/modelServices/catalog'
const draft = ref({ recommendations: { ...commandSuggestions.recommendations }, modelSelection: JSON.parse(JSON.stringify(commandSuggestions.modelSelection)) })
const error = ref('')
const autosave = useAutosave(() => JSON.parse(JSON.stringify(draft.value)), () => {}, value => saveSuggestionPreferences(commandSuggestions.enabled, commandSuggestions.rememberHistory, value.recommendations, value.modelSelection))
defineExpose({ flush: autosave.flush })
</script>
<template>
  <SettingsPage class="command-suggestion-settings" title="智能命令提示">
    <template #status><AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value || error" /></template>
    <SettingsSwitch v-model="draft.recommendations.cloud" label="智能命令提示" description="将输入与所选上下文发送至模型服务；关闭或失败时，本地历史提示照常工作。" />
    <ModelPicker v-model="draft.modelSelection" />
    <p class="settings-description">当前模型：{{ modelReferenceLabel(draft.modelSelection.mode === 'inherit' ? modelServices.primary : draft.modelSelection.model) }}</p>
    <fieldset class="settings-group settings-preferences"><legend class="settings-section-title">上下文</legend>
      <SettingsSwitch v-model="draft.recommendations.remoteContext" label="向 AI 提供目录上下文" :disabled="!draft.recommendations.cloud" description="请求时读取相关目录、工具和脚本信息。" />
      <SettingsSwitch v-model="draft.recommendations.shareHistory" label="向 AI 提供历史" :disabled="!draft.recommendations.cloud" description="最多 12 条相关命令，包含参数。" />
    </fieldset>
    <details class="settings-help"><summary>使用与隐私说明</summary><ul class="settings-notes"><li>输入停顿后请求模型。候选只填入命令，由你再次回车执行。</li><li>AI 接收输入及已开启的上下文；历史上传单独控制，API Key 加密保存在本机。</li><li>目录上下文只包含路径、工具和脚本信息，不包含文件正文。关闭智能提示或目录上下文后停止使用目录上下文。</li><li>模型服务与代理配置在“模型服务”中维护。本地历史提示可以单独开启或关闭。</li></ul></details>
  </SettingsPage>
</template>
