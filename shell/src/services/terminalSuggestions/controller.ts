import type { IDisposable, Terminal } from '@xterm/xterm'
import { TerminalCommandLine } from './commandLine'
import { findCommandSuggestions, type CommandSuggestion, type CommandSuggestionProvider } from './model'

export interface TerminalSuggestionView {
  prefix: string
  candidates: readonly CommandSuggestion[]
  row: number
  column: number
}

interface SuggestionOptions {
  enabled(): boolean
  active(): boolean
  providers(): readonly CommandSuggestionProvider[]
  onCommand(command: string): void
  onChange(view: TerminalSuggestionView | undefined): void
  focusList(edge: 'first' | 'last'): void
  listContains(target: EventTarget | null): boolean
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
    const restoreFocus = !next && options.listContains(document.activeElement)
    view = next
    options.onChange(next)
    if (restoreFocus) terminal.focus()
  }

  function refresh(): void {
    if (!options.enabled() || !options.active() || pendingOutput || composing || terminal.hasSelection()
      || (!element.contains(document.activeElement) && !options.listContains(document.activeElement))) {
      show()
      return
    }
    const line = tracker.snapshot()
    if (!line || line.command === dismissedPrefix) { show(); return }
    const candidates = findCommandSuggestions(line.command, options.providers())
    show(candidates.length ? { prefix: line.command, candidates, row: line.row, column: Math.min(line.column, terminal.cols - 1) } : undefined)
  }

  function dismiss(): void {
    dismissedPrefix = view?.prefix
    show()
  }

  function accept(command: string): void {
    const previous = view
    refresh()
    if (!view || view.prefix !== previous?.prefix || !view.candidates.some(candidate => candidate.command === command)) return
    const suffix = command.slice(view.prefix.length)
    dismiss()
    terminal.focus()
    // Selecting a candidate inserts text through the normal session input path.
    terminal.input(suffix, true)
  }

  function beforeOutput(): void {
    pendingOutput = true
    show()
  }

  function forwardKey(event: KeyboardEvent): void {
    event.stopPropagation()
    terminal.focus()
    // Let xterm encode control keys. For text keys, the browser delivers the
    // following keypress/input to the now-focused terminal textarea.
    const forwarded = new KeyboardEvent('keydown', event)
    terminal.textarea?.dispatchEvent(forwarded)
    if (forwarded.defaultPrevented) event.preventDefault()
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
    if (event.type !== 'keydown' || event.isComposing || composing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return true
    if (!view) return true
    refresh()
    if (!view) return true
    if (event.key === 'Escape') dismiss()
    else options.focusList(event.key === 'ArrowUp' ? 'last' : 'first')
    event.preventDefault()
    return false
  })

  const focus = () => refresh()
  const blur = () => queueMicrotask(refresh)
  const compositionStart = () => { composing = true; show() }
  const compositionEnd = () => { composing = false; refresh() }
  element.addEventListener('focusin', focus)
  element.addEventListener('focusout', blur)
  element.addEventListener('compositionstart', compositionStart)
  element.addEventListener('compositionend', compositionEnd)

  return {
    refresh,
    accept,
    forwardKey,
    dismiss,
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
