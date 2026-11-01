<script setup lang="ts">
import { ref } from 'vue'
import { useAutosave } from '../services/autosave'
import { confirmDialog } from '../services/dialogs'
import { commandSuggestions, clearSuggestionHistory, saveSuggestionPreferences } from '../services/terminalSuggestions/runtime'
import SettingsPage from './SettingsPage.vue'
import SettingsSwitch from './SettingsSwitch.vue'
import AutosaveStatus from './AutosaveStatus.vue'
const draft = ref({ enabled: commandSuggestions.enabled, rememberHistory: commandSuggestions.rememberHistory })
const error = ref(''), clearing = ref(false)
const autosave = useAutosave(() => ({ ...draft.value }), () => {}, value => saveSuggestionPreferences(value.enabled, value.rememberHistory))
async function clear() {
  if (!await confirmDialog('清除命令历史', '清除所有连接在本机保存的命令历史？')) return
  clearing.value = true
  try { await clearSuggestionHistory(); error.value = '' }
  catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason) }
  finally { clearing.value = false }
}
defineExpose({ flush: autosave.flush })
</script>
<template>
  <SettingsPage title="历史命令提示"><template #status><AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value || error" /></template>
    <SettingsSwitch v-model="draft.enabled" label="历史命令提示" description="匹配当前连接的本地历史，与 AI 建议独立。" />
    <SettingsSwitch v-model="draft.rememberHistory" label="记录命令历史" description="每个连接保留最近 200 条。关闭后停止记录，已有历史仍可用于提示。" />
    <button type="button" class="settings-reset-all" :disabled="clearing" @click="clear">清除命令历史</button>
    <details class="settings-help"><summary>使用说明</summary><ul class="settings-notes"><li>历史仅存本机，包含命令参数；命令前加空格可跳过记录与推荐。</li><li>关闭历史提示不删除历史，也不关闭 AI 建议。</li><li>候选只填入命令，由你再次回车执行。Esc 关闭候选框，恢复远端历史键；Tab 和左右键保留远端行为。</li></ul></details>
  </SettingsPage>
</template>
