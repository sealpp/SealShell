<script setup lang="ts">
import { onMounted, ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import AutosaveStatus from './AutosaveStatus.vue'
import { useAutosave } from '../services/autosave'
import { confirmDialog } from '../services/dialogs'
import { clearSuggestionHistory, commandSuggestions, loadRecommendationKey, saveSuggestionPreferences } from '../services/terminalSuggestions/runtime'
import { validateRecommendationSettings } from '../services/terminalSuggestions/settings'

const draft = ref({ enabled: commandSuggestions.enabled, rememberHistory: commandSuggestions.rememberHistory,
  recommendations: { ...commandSuggestions.recommendations }, apiKey: undefined as string | undefined })
const clearing = ref(false)
const hasKey = ref(false)
const autosave = useAutosave(() => ({ ...draft.value, recommendations: { ...draft.value.recommendations } }), value => { if (value.recommendations.cloud) validateRecommendationSettings(value.recommendations) },
  async value => {
    await saveSuggestionPreferences(value.enabled, value.rememberHistory, value.recommendations, value.apiKey)
    if (value.apiKey !== undefined) hasKey.value = !!value.apiKey.trim()
  })

onMounted(async () => {
  try { hasKey.value = !!await loadRecommendationKey() }
  catch (error) { commandSuggestions.error = error instanceof Error ? error.message : String(error) }
})

async function clear(): Promise<void> {
  if (!await confirmDialog('清除命令历史', '清除所有连接在本机保存的命令历史？')) return
  clearing.value = true
  try {
    await clearSuggestionHistory()
    commandSuggestions.error = ''
  } catch (error) {
    commandSuggestions.error = error instanceof Error ? error.message : String(error)
  } finally {
    clearing.value = false
  }
}

defineExpose({ flush: autosave.flush })
</script>

<template>
  <SettingsPage class="command-suggestion-settings" title="命令提示">
    <template #status><AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value || commandSuggestions.error" /></template>
    <SettingsSwitch v-model="draft.enabled" label="命令提示" />
    <fieldset class="settings-group">
      <legend class="settings-section-title">AI</legend>
      <SettingsSwitch v-model="draft.recommendations.cloud" label="AI 推荐" description="将输入与所选上下文发送至模型服务。" />
      <div class="settings-fields-grid">
        <label class="settings-field">API 地址<input v-model="draft.recommendations.baseUrl" type="url" spellcheck="false" placeholder="https://api.deepseek.com"></label>
        <label class="settings-field">模型<input v-model="draft.recommendations.model" spellcheck="false" placeholder="deepseek-flash"></label>
        <div class="settings-field settings-field--wide">
          <label for="recommendation-api-key">API Key</label>
          <span class="settings-secret-control">
            <input id="recommendation-api-key" v-model="draft.apiKey" type="password" autocomplete="new-password" :placeholder="hasKey ? '已保存，输入可更换' : '输入 API Key'">
            <button v-if="hasKey || draft.apiKey" type="button" class="settings-icon-button" aria-label="清除 API Key" title="清除 API Key" @click.prevent="draft.apiKey = ''"><span class="codicon codicon-trash" aria-hidden="true" /></button>
          </span>
        </div>
      </div>
    </fieldset>
    <fieldset class="settings-group settings-preferences">
      <legend class="settings-section-title">建议来源</legend>
      <SettingsSwitch v-model="draft.rememberHistory" label="命令历史" description="每个连接保留最近 200 条。">
        <button type="button" class="settings-icon-button" :disabled="clearing" aria-label="清除命令历史" title="清除命令历史" @click="clear"><span class="codicon codicon-trash" aria-hidden="true" /></button>
      </SettingsSwitch>
      <SettingsSwitch v-model="draft.recommendations.remoteContext" label="向 AI 提供目录上下文" :disabled="!draft.recommendations.cloud" />
      <SettingsSwitch v-model="draft.recommendations.automatic" label="自动请求 AI 建议" :disabled="!draft.recommendations.cloud" />
      <SettingsSwitch v-model="draft.recommendations.shareHistory" label="向 AI 提供历史" :disabled="!draft.recommendations.cloud" description="最多 12 条相关命令，包含参数。" />
    </fieldset>
    <details class="settings-help">
      <summary>使用与隐私说明</summary>
      <dl class="settings-shortcuts">
        <div><dt><kbd>↑</kbd> <kbd>↓</kbd></dt><dd>选择建议</dd></div>
        <div><dt><kbd>Enter</kbd></dt><dd>填入所选命令，再按执行</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>关闭建议，恢复远端历史键</dd></div>
      </dl>
      <ul class="settings-notes">
        <li>Tab、左右键保留远端行为。完整替换适用于 Bash/zsh 默认键位。</li>
        <li>本地提示只匹配并原样显示当前连接的历史命令；没有历史时不生成建议。</li>
        <li>历史仅存本机，包含命令参数；命令前加空格可跳过记录与推荐。</li>
        <li>仅请求 AI 时按设置读取 Linux 目录名、可用工具与脚本名；本地历史提示不读取目录上下文。</li>
        <li>AI 接收输入及已开启的上下文；历史上传单独控制。API Key 加密保存在本机。</li>
        <li>模型接口需兼容 Chat Completions，由桌面运行时发起请求。</li>
      </ul>
    </details>
  </SettingsPage>
</template>
