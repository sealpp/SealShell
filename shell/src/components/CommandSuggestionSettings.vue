<script setup lang="ts">
import { ref } from 'vue'
import { useAutosave } from '../services/autosave'
import { confirmDialog } from '../services/dialogs'
import { clearSuggestionHistory, commandSuggestions, saveSuggestionPreferences } from '../services/terminalSuggestions/runtime'

const draft = ref({ enabled: commandSuggestions.enabled, rememberHistory: commandSuggestions.rememberHistory })
const clearing = ref(false)
const autosave = useAutosave(() => ({ ...draft.value }), () => {}, value => saveSuggestionPreferences(value.enabled, value.rememberHistory))

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
  <main class="settings-main command-suggestion-settings">
    <div class="settings-heading"><div><h2>命令提示</h2><p>在光标附近显示候选列表，点击候选或直接用 ↑↓ 选择。</p></div></div>
    <p v-if="autosave.error.value || commandSuggestions.error" class="error" role="alert">{{ autosave.error.value || commandSuggestions.error }}</p>
    <p v-else class="settings-save-status" role="status">{{ autosave.status.value }}</p>
    <label><input v-model="draft.enabled" type="checkbox">启用本地命令提示</label>
    <p>输入首个字符后，从常用命令和本地历史中匹配。用 ↑↓ 选中后，Enter 只补入文字；未选中时，Enter 执行当前输入。Escape 关闭列表后可用 ↑↓ 查看远端历史。Tab 和左右方向键保持远端行为，继续输入或退格可编辑命令。</p>
    <label><input v-model="draft.rememberHistory" type="checkbox">记住当前浏览器的命令历史</label>
    <p>每个保存的连接保留最近 200 条不同命令，优先提示使用频率高的命令。历史仅保存在本机浏览器；命令参数也会保留，可在命令前加空格跳过记录。</p>
    <p>关闭历史后停止记录并仅使用常用命令提示；已有历史保留到手动清除。密码输入、多行粘贴、全屏程序和无法识别的提示符暂停提示。</p>
    <button type="button" class="settings-reset-all" :disabled="clearing" @click="clear">清除命令历史</button>
  </main>
</template>

<style scoped>
.command-suggestion-settings label { display: flex; align-items: center; gap: 8px; margin-top: 24px; }
.command-suggestion-settings input { margin: 0; }
.command-suggestion-settings p { max-width: 720px; line-height: 1.7; color: var(--workbench-text-muted); }
.command-suggestion-settings .error { color: var(--workbench-error); }
</style>
