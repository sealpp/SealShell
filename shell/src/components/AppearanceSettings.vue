<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { IconRotate } from '../ui/icons'
import '@xterm/xterm/css/xterm.css'
import { store, type TerminalPreferences } from '../stores/app'
import { confirmDialog } from '../services/dialogs'
import { useAutosave } from '../services/autosave'
import SettingsPage from './SettingsPage.vue'
import AutosaveStatus from './AutosaveStatus.vue'
import { DEFAULT_TERMINAL_PREFERENCES, defaultTerminalPreferences, getTerminalFontFamily, getTerminalTheme, saveTerminalPreferences, terminalFontOptions, terminalThemeNames, terminalWeightOptions } from '../services/terminalPreferences'

const previewEl = ref<HTMLDivElement | null>(null)
const draft = ref<TerminalPreferences>({ ...store.terminalPreferences })
let preview: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
function validate(value: TerminalPreferences): void {
  if (!Number.isInteger(value.fontSize) || value.fontSize < 8 || value.fontSize > 32) throw new Error('字号必须为 8–32 的整数')
  if (!Number.isFinite(value.lineHeight) || value.lineHeight < 1 || value.lineHeight > 2) throw new Error('行高必须为 1–2')
}
const autosave = useAutosave(() => ({ ...draft.value }), validate, saveTerminalPreferences)

function resetField(field: keyof Pick<TerminalPreferences, 'theme' | 'fontFamily' | 'fontSize' | 'lineHeight' | 'fontWeight' | 'fontWeightBold'>): void {
  draft.value[field] = DEFAULT_TERMINAL_PREFERENCES[field] as never
}
async function resetAll(): Promise<void> {
  if (await confirmDialog('恢复默认设置', '将立即恢复并保存本页所有终端外观设置。')) draft.value = defaultTerminalPreferences()
}
function applyPreview(): void {
  if (!preview) return
  const p = draft.value
  try { validate(p) } catch { return }
  preview.options.fontFamily = getTerminalFontFamily(p.fontFamily)
  preview.options.fontSize = p.fontSize
  preview.options.lineHeight = p.lineHeight
  preview.options.fontWeight = p.fontWeight
  preview.options.fontWeightBold = p.fontWeightBold
  preview.options.theme = getTerminalTheme(p.theme)
  previewEl.value?.style.setProperty('--terminal-background', getTerminalTheme(p.theme).background ?? '#0d0d0d')
  fitAddon?.fit()
}
defineExpose({ flush: autosave.flush })

onMounted(async () => {
  await nextTick()
  if (!previewEl.value) return
  const p = draft.value
  preview = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: getTerminalFontFamily(p.fontFamily), fontSize: p.fontSize, lineHeight: p.lineHeight, fontWeight: p.fontWeight, fontWeightBold: p.fontWeightBold, theme: getTerminalTheme(p.theme) })
  fitAddon = new FitAddon()
  preview.loadAddon(fitAddon)
  preview.open(previewEl.value)
  preview.write('\x1b[1;36mSealShell terminal preview\x1b[0m\r\n')
  preview.write('\x1b[32m$\x1b[0m printf "\x1b[31m彩色文本\x1b[0m 你好，世界 👋\\n"\r\n')
  preview.write('\x1b[33m普通  中等  半粗  粗体\x1b[0m\r\n')
  preview.write('Unicode: λ → ✓  |  ANSI: \x1b[1;35mbold magenta\x1b[0m\r\n')
  applyPreview()
  resizeObserver = new ResizeObserver(() => fitAddon?.fit())
  resizeObserver.observe(previewEl.value)
})
watch(draft, applyPreview, { deep: true })
onBeforeUnmount(() => { resizeObserver?.disconnect(); preview?.dispose(); preview = null })
</script>

<template>
      <SettingsPage title="外观">
        <template #actions><button type="button" class="settings-reset-all" @click="resetAll">恢复默认</button></template>
        <template #status><AutosaveStatus :state="autosave.state.value" :status="autosave.status.value" :error="autosave.error.value" /></template>
        <div ref="previewEl" class="terminal-preview" aria-label="终端外观预览" />
        <h3 class="settings-section-title">文本</h3>
        <div class="settings-form">
          <div class="settings-row"><span><strong>配色方案</strong></span><span class="settings-control"><button type="button" :class="['settings-reset', { 'settings-reset--hidden': draft.theme === DEFAULT_TERMINAL_PREFERENCES.theme }]" :disabled="draft.theme === DEFAULT_TERMINAL_PREFERENCES.theme" title="恢复默认配色" aria-label="恢复默认配色" @click="resetField('theme')"><IconRotate :size="16" /></button><select v-model="draft.theme" aria-label="配色方案"><option v-for="name in terminalThemeNames" :key="name" :value="name">{{ name }}</option></select></span></div>
          <div class="settings-row"><span><strong>字体</strong></span><span class="settings-control"><button type="button" :class="['settings-reset', { 'settings-reset--hidden': draft.fontFamily === DEFAULT_TERMINAL_PREFERENCES.fontFamily }]" :disabled="draft.fontFamily === DEFAULT_TERMINAL_PREFERENCES.fontFamily" title="恢复默认字体" aria-label="恢复默认字体" @click="resetField('fontFamily')"><IconRotate :size="16" /></button><select v-model="draft.fontFamily" aria-label="字体"><option v-for="font in terminalFontOptions" :key="font.value" :value="font.value">{{ font.label }}</option></select></span></div>
          <div class="settings-row"><span><strong>字号</strong></span><span class="settings-control"><button type="button" :class="['settings-reset', { 'settings-reset--hidden': draft.fontSize === DEFAULT_TERMINAL_PREFERENCES.fontSize }]" :disabled="draft.fontSize === DEFAULT_TERMINAL_PREFERENCES.fontSize" title="恢复默认字号" aria-label="恢复默认字号" @click="resetField('fontSize')"><IconRotate :size="16" /></button><input v-model.number="draft.fontSize" type="number" min="8" max="32" step="1" aria-label="字号" aria-description="像素"><span class="settings-unit" aria-hidden="true">px</span></span></div>
          <div class="settings-row"><span><strong>行高</strong></span><span class="settings-control"><button type="button" :class="['settings-reset', { 'settings-reset--hidden': draft.lineHeight === DEFAULT_TERMINAL_PREFERENCES.lineHeight }]" :disabled="draft.lineHeight === DEFAULT_TERMINAL_PREFERENCES.lineHeight" title="恢复默认行高" aria-label="恢复默认行高" @click="resetField('lineHeight')"><IconRotate :size="16" /></button><input v-model.number="draft.lineHeight" type="number" min="1" max="2" step="0.05" aria-label="行高" aria-description="字号的倍数"><span class="settings-unit" aria-hidden="true">×</span></span></div>
          <div class="settings-row"><span><strong>字体粗细</strong></span><span class="settings-control"><button type="button" :class="['settings-reset', { 'settings-reset--hidden': draft.fontWeight === DEFAULT_TERMINAL_PREFERENCES.fontWeight }]" :disabled="draft.fontWeight === DEFAULT_TERMINAL_PREFERENCES.fontWeight" title="恢复默认字体粗细" aria-label="恢复默认字体粗细" @click="resetField('fontWeight')"><IconRotate :size="16" /></button><select v-model.number="draft.fontWeight" aria-label="字体粗细"><option v-for="weight in terminalWeightOptions" :key="weight.value" :value="weight.value">{{ weight.label }}</option></select></span></div>
          <div class="settings-row"><span><strong>粗体字体粗细</strong></span><span class="settings-control"><button type="button" :class="['settings-reset', { 'settings-reset--hidden': draft.fontWeightBold === DEFAULT_TERMINAL_PREFERENCES.fontWeightBold }]" :disabled="draft.fontWeightBold === DEFAULT_TERMINAL_PREFERENCES.fontWeightBold" title="恢复默认粗体字体粗细" aria-label="恢复默认粗体字体粗细" @click="resetField('fontWeightBold')"><IconRotate :size="16" /></button><select v-model.number="draft.fontWeightBold" aria-label="粗体字体粗细"><option v-for="weight in terminalWeightOptions" :key="weight.value" :value="weight.value">{{ weight.label }}</option></select></span></div>
        </div>
      </SettingsPage>
</template>
