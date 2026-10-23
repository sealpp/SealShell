<script setup lang="ts">
import ProxyErrorAction from '../components/ProxyErrorAction.vue'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type CSSProperties } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { store } from '../stores/app'
import {
  resizeTerminal,
  sendTerminalInput,
  setTerminalOutputHandler,
} from '../services/ws'
import CommandContextMenu from '../components/CommandContextMenu.vue'
import { TERMINAL_MENU_ID } from '../services/actions/menuIds'
import type { CommandContext } from '../services/context'
import { getTerminalFontFamily, getTerminalTheme } from '../services/terminalPreferences'
import { encodingDecoder } from '../services/encodings'
import { registerTerminalDirectoryHandlers } from '../services/terminalDirectory'
import TerminalCommandHint from '../components/TerminalCommandHint.vue'
import { attachCommandSuggestions, type TerminalSuggestionView } from '../services/terminalSuggestions/controller'
import { commonCommandProvider } from '../services/terminalSuggestions/catalog'
import { historyProvider } from '../services/terminalSuggestions/model'
import { commandSuggestions, loadSuggestionHistory, rememberSuggestionCommand } from '../services/terminalSuggestions/runtime'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{ tabId: string }>()

const FIT_DEBOUNCE_MS = 100
const BACKEND_RESIZE_DEBOUNCE_MS = 80

const termEl = ref<HTMLDivElement | null>(null)
let terminal: Terminal | null = null
let suggestions: ReturnType<typeof attachCommandSuggestions> | undefined
const suggestion = shallowRef<TerminalSuggestionView>()
const suggestionAppearance = shallowRef<CSSProperties>({})
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let fitTimer: number | null = null
let backendResizeTimer: number | null = null
let pendingBackendResize: { terminalId: string; columns: number; rows: number } | null = null
let decoder = new TextDecoder('utf-8', { fatal: false })
const unwatchState = ref<() => void>()
const unwatchStream = ref<() => void>()
const unwatchActive = ref<() => void>()
const unwatchEncoding = ref<() => void>()
const unwatchPreferences = ref<() => void>()
const unwatchTerminalMount = ref<() => void>()

const tab = computed(() => store.tabs.find((t) => t.id === props.tabId))
const isActive = computed(() => store.activeTerminalTabId === props.tabId)
const encoder = new TextEncoder()

function historyError(error: unknown): void {
  commandSuggestions.error = error instanceof Error ? error.message : String(error)
}

function showSuggestion(value: TerminalSuggestionView | undefined): void {
  suggestion.value = value
  if (!value || !terminal || !termEl.value) return
  const screen = terminal.element?.querySelector('.xterm-screen')
  if (!screen) { suggestion.value = undefined; return }
  const screenRect = screen.getBoundingClientRect()
  const containerRect = termEl.value.getBoundingClientRect()
  const cellWidth = screenRect.width / terminal.cols
  const cellHeight = screenRect.height / terminal.rows
  suggestionAppearance.value = {
    left: `${screenRect.left - containerRect.left + value.column * cellWidth}px`,
    top: `${screenRect.top - containerRect.top + value.row * cellHeight}px`,
    maxWidth: `${Math.max(0, (terminal.cols - value.column) * cellWidth)}px`,
    height: `${cellHeight}px`,
    lineHeight: `${cellHeight}px`,
    fontFamily: terminal.options.fontFamily,
    fontSize: `${terminal.options.fontSize}px`,
    fontWeight: terminal.options.fontWeight,
    letterSpacing: `${terminal.options.letterSpacing}px`,
  }
}

const activeState = computed(() => {
  const t = tab.value
  if (!t) return 'no-tab'
  if (!isActive.value) return 'inactive'
  if (t.state !== 'online') return 'not-online'
  return 'online'
})

watch(() => [commandSuggestions.enabled, commandSuggestions.rememberHistory, commandSuggestions.history[tab.value?.hostId ?? ''], activeState.value], () => suggestions?.refresh())

function fitAndResize() {
  if (!terminal || !fitAddon) return
  fitAddon.fit()
}

function scheduleFit() {
  if (fitTimer !== null) {
    window.clearTimeout(fitTimer)
  }

  fitTimer = window.setTimeout(() => {
    fitTimer = null
    fitAndResize()
  }, FIT_DEBOUNCE_MS)
}

function flushBackendResize() {
  backendResizeTimer = null
  const pending = pendingBackendResize
  pendingBackendResize = null
  if (!pending || !tab.value?.sessionId) return

  resizeTerminal(pending.terminalId, pending.columns, pending.rows)
}

function scheduleBackendResize(columns: number, rows: number) {
  const currentTab = tab.value
  if (!currentTab?.sessionId) return

  pendingBackendResize = {
    terminalId: currentTab.terminalId,
    columns,
    rows,
  }
  if (backendResizeTimer !== null) {
    window.clearTimeout(backendResizeTimer)
  }
  backendResizeTimer = window.setTimeout(flushBackendResize, BACKEND_RESIZE_DEBOUNCE_MS)
}

function resetDecoder(encoding: string) {
  const flushed = decoder.decode()
  if (flushed) terminal?.write(flushed)
  decoder = new TextDecoder(encodingDecoder(encoding), { fatal: false })
}

function writeOutput(data: Uint8Array) {
  if (!terminal) return
  suggestions?.beforeOutput()
  try {
    const text = decoder.decode(data, { stream: true })
    terminal.write(text)
  } catch {
    terminal.write(data)
  }
}

function terminalContext(): CommandContext {
  const currentTab = tab.value
  return {
    area: 'terminal',
    tabId: props.tabId,
    terminal: terminal ?? undefined,
    hasSelection: terminal?.hasSelection() ?? false,
    isOnline: currentTab?.state === 'online',
    canPaste: !!(navigator.clipboard && navigator.clipboard.readText),
    tabEncoding: currentTab?.encoding,
  }
}

function isTerminalScreenTarget(event: MouseEvent): boolean {
  const target = event.target
  return target instanceof Element && target.closest('.xterm-screen') !== null
}

function applyTerminalPreferences() {
  if (!terminal) return
  const preferences = store.terminalPreferences
  terminal.options.fontFamily = getTerminalFontFamily(preferences.fontFamily)
  terminal.options.fontSize = preferences.fontSize
  terminal.options.lineHeight = preferences.lineHeight
  terminal.options.fontWeight = preferences.fontWeight
  terminal.options.fontWeightBold = preferences.fontWeightBold
  terminal.options.theme = getTerminalTheme(preferences.theme)
  scheduleFit()
}

function bindOutput() {
  const sessionId = tab.value?.sessionId
  if (!sessionId || !terminal) return
  setTerminalOutputHandler(sessionId, writeOutput)

  // Ensure the remote PTY receives the initial window size as soon as the
  // output handler is bound; xterm's onResize may not fire by itself.
  fitAddon?.fit()
  const currentTab = tab.value
  if (currentTab && currentTab.sessionId) {
    resizeTerminal(currentTab.terminalId, terminal.cols, terminal.rows)
  }
}

function initTerminal() {
  if (terminal || !termEl.value || !tab.value) return

  const preferences = store.terminalPreferences
  terminal = new Terminal({
    cursorBlink: true,
    rightClickSelectsWord: false,
    fontFamily: getTerminalFontFamily(preferences.fontFamily),
    fontSize: preferences.fontSize,
    lineHeight: preferences.lineHeight,
    fontWeight: preferences.fontWeight,
    fontWeightBold: preferences.fontWeightBold,
    theme: getTerminalTheme(preferences.theme),
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(termEl.value)

  suggestions = attachCommandSuggestions(terminal, {
    enabled: () => commandSuggestions.enabled && tab.value?.state === 'online',
    active: () => isActive.value,
    providers: () => [
      commonCommandProvider,
      historyProvider(commandSuggestions.rememberHistory ? commandSuggestions.history[tab.value?.hostId ?? ''] ?? [] : []),
    ],
    onCommand: command => {
      const hostId = tab.value?.hostId
      if (hostId) void rememberSuggestionCommand(hostId, command).catch(historyError)
    },
    onChange: showSuggestion,
  })
  const hostId = tab.value.hostId
  if (hostId) void loadSuggestionHistory(hostId).catch(historyError)

  registerTerminalDirectoryHandlers(terminal, (directory) => {
    const currentTab = tab.value
    if (currentTab) currentTab.cwd = directory
  })

  terminal.onData((data: string) => {
    if (tab.value?.sessionId) {
      sendTerminalInput(tab.value.sessionId, encoder.encode(data))
    }
  })

  terminal.onResize(({ cols, rows }) => {
    scheduleBackendResize(cols, rows)
  })

  resizeObserver = new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect
    if (rect && rect.width > 0 && rect.height > 0) {
      scheduleFit()
    }
  })
  resizeObserver.observe(termEl.value)

  unwatchState.value = watch(
    () => tab.value?.state,
    (state) => {
      if (state === 'error') {
        suggestions?.reset()
        terminal?.writeln(`\r\n[session error: ${tab.value?.error}]`)
      }
    },
  )

  unwatchActive.value = watch(
    activeState,
    (state) => {
      if (!tab.value) return
      if (state !== 'inactive') {
        scheduleFit()
      }
    },
    { immediate: true },
  )

  unwatchEncoding.value = watch(
    () => tab.value?.encoding,
    (enc, prev) => {
      if (enc && enc !== prev) {
        resetDecoder(enc)
      }
    },
    { immediate: true },
  )

  unwatchPreferences.value = watch(
    () => store.terminalPreferences,
    () => applyTerminalPreferences(),
    { deep: true },
  )

  bindOutput()
}

onMounted(() => {
  unwatchStream.value = watch(
    () => tab.value?.sessionId,
    (sessionId) => {
      if (sessionId) {
        bindOutput()
      }
    },
    { immediate: true },
  )

  unwatchTerminalMount.value = watch(
    [() => tab.value, () => termEl.value],
    () => initTerminal(),
    { flush: 'post', immediate: true },
  )
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (fitTimer !== null) {
    window.clearTimeout(fitTimer)
  }
  if (backendResizeTimer !== null) {
    window.clearTimeout(backendResizeTimer)
  }
  fitTimer = null
  backendResizeTimer = null
  pendingBackendResize = null
  unwatchState.value?.()
  unwatchStream.value?.()
  unwatchActive.value?.()
  unwatchEncoding.value?.()
  unwatchPreferences.value?.()
  unwatchTerminalMount.value?.()
  suggestions?.dispose()
  if (tab.value?.sessionId) {
    setTerminalOutputHandler(tab.value.sessionId, null)
  }
  terminal?.dispose()
  terminal = null
})
</script>

<template>
  <CommandContextMenu
    v-if="tab"
    :menu-id="TERMINAL_MENU_ID"
    :context="terminalContext"
    :can-open="isTerminalScreenTarget"
  >
    <div class="shell-terminal">
      <div v-if="tab.state === 'error' && tab.proxySource" class="connection-error"><span>{{ tab.error }}</span><ProxyErrorAction :source="tab.proxySource" :message="tab.error" /></div>
      <div ref="termEl" class="shell-terminal-content">
        <TerminalCommandHint v-if="suggestion" :suggestion="suggestion" :appearance="suggestionAppearance" />
      </div>
    </div>
  </CommandContextMenu>
</template>

<style scoped>
.shell-terminal {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--terminal-background, #0d0d0d);
}

.shell-terminal-content {
  position: relative;
  min-height: 0;
  flex: 1;
  width: 100%;
  height: 100%;
}

.shell-terminal :deep(.xterm .xterm-viewport) {
  background-color: var(--terminal-background, #0d0d0d);
}
</style>
