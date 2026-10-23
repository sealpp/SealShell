import type { IDisposable, Terminal } from '@xterm/xterm'
import { TerminalCommandLine } from './commandLine'
import { findCommandSuggestion, type CommandSuggestionProvider } from './model'

export interface TerminalSuggestionView {
  prefix: string
  command: string
  suffix: string
  source: string
  row: number
  column: number
}

interface SuggestionOptions {
  enabled(): boolean
  active(): boolean
  providers(): readonly CommandSuggestionProvider[]
  onCommand(command: string): void
  onChange(view: TerminalSuggestionView | undefined): void
}

export function attachCommandSuggestions(terminal: Terminal, options: SuggestionOptions) {
  const tracker = new TerminalCommandLine(terminal, command => {
    if (options.enabled()) options.onCommand(command)
  })
  const element = terminal.element!
  let view: TerminalSuggestionView | undefined
  let pendingOutput = false
  let composing = false
  let dismissedPrefix: string | undefined

  function show(next?: TerminalSuggestionView): void {
    view = next
    options.onChange(next)
  }

  function refresh(): void {
    if (!options.enabled() || !options.active() || pendingOutput || composing || terminal.hasSelection() || !element.contains(document.activeElement)) {
      show()
      return
    }
    const line = tracker.snapshot()
    if (!line || line.column >= terminal.cols || line.command === dismissedPrefix) { show(); return }
    const suggestion = findCommandSuggestion(line.command, options.providers())
    show(suggestion ? {
      ...line, prefix: line.command, command: suggestion.command,
      suffix: suggestion.command.slice(line.command.length), source: suggestion.source,
    } : undefined)
  }

  function beforeOutput(): void {
    pendingOutput = true
    show()
  }

  const subscriptions: IDisposable[] = [
    terminal.onData(data => {
      dismissedPrefix = undefined
      tracker.input(data)
      pendingOutput = true
      show()
    }),
    terminal.onWriteParsed(() => {
      pendingOutput = false
      tracker.update()
      refresh()
    }),
    terminal.onScroll(refresh),
    terminal.onSelectionChange(refresh),
    terminal.onResize(() => { tracker.reset(); tracker.update(); refresh() }),
    terminal.buffer.onBufferChange(() => { tracker.update(); show() }),
  ]

  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.isComposing || composing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return true
    if (!view) return true
    const previous = view
    refresh()
    if (!view || previous.prefix !== view.prefix || previous.command !== view.command) return true
    if (event.key === 'Escape') {
      dismissedPrefix = view.prefix
      show()
      event.preventDefault()
      return false
    }
    if (event.key !== 'ArrowRight') return true
    const suffix = view.suffix
    show()
    // Use the normal input path so accepting a suggestion cannot execute it.
    terminal.input(suffix, true)
    event.preventDefault()
    return false
  })

  const focus = () => refresh()
  const blur = () => show()
  const compositionStart = () => { composing = true; show() }
  const compositionEnd = () => { composing = false; refresh() }
  element.addEventListener('focusin', focus)
  element.addEventListener('focusout', blur)
  element.addEventListener('compositionstart', compositionStart)
  element.addEventListener('compositionend', compositionEnd)

  return {
    refresh,
    beforeOutput,
    reset() { tracker.reset(); dismissedPrefix = undefined; show() },
    dispose() {
      tracker.reset()
      subscriptions.forEach(subscription => subscription.dispose())
      terminal.attachCustomKeyEventHandler(() => true)
      element.removeEventListener('focusin', focus)
      element.removeEventListener('focusout', blur)
      element.removeEventListener('compositionstart', compositionStart)
      element.removeEventListener('compositionend', compositionEnd)
      show()
    },
  }
}
