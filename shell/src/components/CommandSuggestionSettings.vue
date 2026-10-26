<script setup lang="ts">
import { ref } from 'vue'
import SettingsPage from './SettingsPage.vue'
import AutosaveStatus from './AutosaveStatus.vue'
import { useAutosave } from '../services/autosave'
import { confirmDialog } from '../services/dialogs'
import { clearSuggestionHistory, commandSuggestions, saveSuggestionPreferences } from '../services/terminalSuggestions/runtime'
import { validateRecommendationSettings } from '../services/terminalSuggestions/settings'

const draft = ref({ enabled: commandSuggestions.enabled, rememberHistory: commandSuggestions.rememberHistory,
  recommendations: { ...commandSuggestions.recommendations }, apiKey: undefined as string | undefined })
const clearing = ref(false)
const autosave = useAutosave(() => ({ ...draft.value, recommendations: { ...draft.value.recommendations } }), value => validateRecommendationSettings(value.recommendations),
  value => saveSuggestionPreferences(value.enabled, value.rememberHistory, value.recommendations, value.apiKey))

async function clear(): Promise<void> {
  if (!await confirmDialog('清除命令历史', '将清除当前浏览器中所有连接的本地命令历史，常用命令提示仍可使用。')) return
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
  <SettingsPage class="command-suggestion-settings" title="命令提示" description="在光标附近显示候选列表，点击候选或直接用 ↑↓ 选择。">
    <template #status><AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value || commandSuggestions.error" /></template>
    <label class="settings-toggle"><input v-model="draft.enabled" type="checkbox">启用本地命令提示</label>
    <fieldset class="settings-group">
      <legend class="settings-section-title">云端模型</legend>
      <label class="settings-toggle"><input v-model="draft.recommendations.cloud" type="checkbox">启用云端智能推荐</label>
      <div class="settings-fields-grid">
        <label class="settings-field">API 地址<input v-model="draft.recommendations.baseUrl" type="url" spellcheck="false" placeholder="https://api.deepseek.com"></label>
        <label class="settings-field">模型<input v-model="draft.recommendations.model" spellcheck="false" placeholder="deepseek-flash"></label>
        <label class="settings-field settings-field--wide">API Key<input v-model="draft.apiKey" type="password" autocomplete="new-password" placeholder="未修改则保留已保存的 Key"></label>
      </div>
      <p class="settings-description">开启后，输入和当前目录及已启用的探测结果会发送到此服务商；历史上传单独控制。Key 加密保存在当前浏览器，修改自动保存。</p>
    </fieldset>
    <details class="settings-help">
      <summary>操作说明</summary>
      <p class="settings-description">直接在终端输入，例如 python main 或 cd myproject。本地候选立即匹配，输入停顿后补充已启用的目录和云端建议。历史支持关键词检索，并优先当前目录。</p>
      <p class="settings-description">用 ↑↓ 或点击选中后只填入完整命令，再由你按 Enter 执行。未选中候选时，Enter 仍提交当前终端输入。Escape 关闭列表后可用 ↑↓ 查看远端历史，Tab 和左右方向键保持远端行为。</p>
      <p class="settings-description">完整替换使用 Bash/zsh 默认 Emacs 行编辑的 Ctrl+U；自定义键位或 vi 模式请核对填入结果。晚到结果不会重排已有候选，选择期间通过“新建议”手动刷新。</p>
      <p class="settings-description">云端接口须兼容 Chat Completions JSON 输出并允许浏览器跨域访问。清空已编辑的 Key 输入框可移除它。</p>
    </details>
    <label class="settings-toggle"><input v-model="draft.rememberHistory" type="checkbox">记住当前浏览器的命令历史</label>
    <p class="settings-description">每个连接保存最近 200 条命令及其目录、采纳与提交次数。提交不代表执行成功，采纳不代表已经执行。默认仅存本机；命令参数也会保留，可在命令前加空格跳过记录与推荐。</p>
    <p class="settings-description">关闭历史后停止记录与检索，目录和云端来源由各自开关控制；已有历史保留到手动清除。密码输入、多行粘贴、全屏程序和无法识别的提示符暂停提示。</p>
    <button type="button" class="settings-reset-all" :disabled="clearing" @click="clear">清除命令历史</button>
    <label class="settings-toggle"><input v-model="draft.recommendations.remoteContext" type="checkbox">按需探测 Linux 目录</label>
    <p class="settings-description">使用独立 SSH 连接读取当前及同级目录名称、可用工具和 package.json 的脚本名称，缓存 30 秒。不安装远端插件，不执行模型生成的探测命令，不读取环境变量、源代码或 .env；目录和文件名称也可能包含私人信息。</p>
    <label class="settings-toggle"><input v-model="draft.recommendations.automatic" type="checkbox">输入停顿后自动补充推荐</label>
    <label class="settings-toggle"><input v-model="draft.recommendations.shareHistory" type="checkbox">向云端提供相关历史命令</label>
    <p class="settings-description">最多发送 12 条相关历史及其目录；包含命令参数。关闭后仍可在本地检索历史。</p>
  </SettingsPage>
</template>
