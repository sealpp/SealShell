import type { IDisposable, Terminal } from '@xterm/xterm'
import { TerminalCommandLine } from './commandLine'
import { canRememberCommand, COMMAND_SUGGESTION_LIMIT, findCommandSuggestions, type CommandSuggestion, type CommandSuggestionProvider, type CommandUse, type RecommendationActivity } from './model'

export interface TerminalSuggestionView {
  prefix: string
  candidates: readonly CommandSuggestion[]
  row: number
  column: number
  loading?: boolean
  activity?: RecommendationActivity
  status?: string
  pending?: number
  enhanced?: boolean
}

interface SuggestionOptions {
  enabled(): boolean
  active(): boolean
  providers(): readonly CommandSuggestionProvider[]
  context?(): { key: string; cwd?: string }
  automatic?(): boolean
  enhancementEnabled?(query: string): boolean
  enhance?(query: string, signal: AbortSignal, publish: (items: CommandSuggestion[]) => void, progress: (activity: RecommendationActivity) => void): Promise<string>
  onCommand(command: string, use?: CommandUse): void
  onAccept?(command: string, use: CommandUse): void
  onChange(view: TerminalSuggestionView | undefined): void
  focusList(edge: 'first' | 'last'): void
  listContains(target: EventTarget | null): boolean
}

export function attachCommandSuggestions(terminal: Terminal, options: SuggestionOptions) {
  let submittedUse: CommandUse = {}
  const tracker = new TerminalCommandLine(terminal, command => {
    if (options.enabled()) options.onCommand(command, submittedUse)
  })
  const element = terminal.element!
  let view: TerminalSuggestionView | undefined
  let pendingOutput = false, composing = false, locked = false
  let dismissedPrefix: string | undefined
  let contextKey = '', linePrefix: string | undefined
  let pool: CommandSuggestion[] = []
  let abort: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  function cancel(): void { clearTimeout(timer); abort?.abort(); abort = undefined }
  function show(next?: TerminalSuggestionView): void {
    const restoreFocus = !next && options.listContains(document.activeElement)
    view = next
    options.onChange(next)
    if (restoreFocus) terminal.focus()
  }
  function resetQuery(): void {
    cancel(); linePrefix = undefined; pool = []; locked = false
  }
  function context() { return options.context?.() ?? { key: '' } }
  function usable(): boolean {
    return !disposed && options.enabled() && options.active() && !pendingOutput && !composing && !terminal.hasSelection()
      && (element.contains(document.activeElement) || options.listContains(document.activeElement))
  }
  function publish(items: readonly CommandSuggestion[]): void {
    const all = new Map(pool.map(item => [item.command, item]))
    for (const item of items) if (canRememberCommand(item.command) && item.command !== linePrefix) all.set(item.command, item)
    pool = [...all.values()].sort((a, b) => b.priority - a.priority || b.uses - a.uses || b.lastUsed - a.lastUsed)
    if (!view) return
    const existing = new Set(view.candidates.map(item => item.command))
    const extra = pool.filter(item => !existing.has(item.command))
    const candidates = locked ? view.candidates : [...view.candidates, ...extra.slice(0, COMMAND_SUGGESTION_LIMIT - view.candidates.length)]
    const visible = new Set(candidates.map(item => item.command))
    show({ ...view, candidates, pending: pool.filter(item => !visible.has(item.command)).length })
  }
  function schedule(): void {
    cancel()
    if (!options.enhance || !(options.automatic?.() ?? true)) return
    const query = linePrefix ?? ''
    if (!canRememberCommand(query) || options.enhancementEnabled?.(query) === false) return
    const request = new AbortController()
    abort = request
    const requestKey = contextKey
    const requestPrefix = linePrefix
    timer = setTimeout(async () => {
      if (!usable() || request.signal.aborted) return
      if (view) show({ ...view, loading: true, activity: undefined, status: '' })
      const valid = () => !request.signal.aborted && usable() && context().key === requestKey && tracker.snapshot()?.command === requestPrefix
      try {
        const status = await options.enhance!(query, request.signal, items => { if (valid()) publish(items) }, activity => {
          if (valid() && view) show({ ...view, activity })
        })
        if (valid() && view) show({ ...view, loading: false, activity: undefined, status })
      } catch {
        if (valid() && view) show({ ...view, loading: false, activity: undefined, status: '推荐暂不可用' })
      }
    }, 650)
  }
  function refresh(): void {
    if (!usable()) { resetQuery(); show(); return }
    const line = tracker.snapshot()
    if (!line || line.command === dismissedPrefix || (line.command && !canRememberCommand(line.command))) {
      resetQuery(); show(); return
    }
    const nextKey = context().key
    if (linePrefix === line.command && contextKey === nextKey && view) return
    resetQuery()
    linePrefix = line.command; contextKey = nextKey
    const query = line.command
    pool = findCommandSuggestions(query, options.providers())
    const enhanced = !!options.enhance && options.enhancementEnabled?.(query) !== false && (options.automatic?.() ?? true)
    const shouldShow = pool.length || (query && enhanced)
    show(shouldShow ? { prefix: line.command, candidates: pool, row: line.row, column: Math.min(line.column, terminal.cols - 1), enhanced } : undefined)
    schedule()
  }
  function dismiss(): void {
    dismissedPrefix = linePrefix
    resetQuery(); show()
  }
  function accept(command: string): void {
    const line = tracker.snapshot()
    if (!usable() || !line || line.command !== view?.prefix || context().key !== contextKey
      || !view?.candidates.some(candidate => candidate.command === command)) { dismiss(); return }
    const use: CommandUse = { kind: 'accepted', cwd: context().cwd }
    const input = command.startsWith(line.command) ? command.slice(line.command.length) : '\x15' + command
    dismiss()
    terminal.focus()
    terminal.input(input, true)
    tracker.expectReplacement(command)
    dismissedPrefix = command
    options.onAccept?.(command, use)
  }
  function applyPending(): void {
    if (!view) return
    locked = false
    show({ ...view, candidates: pool.slice(0, COMMAND_SUGGESTION_LIMIT), pending: 0 })
    options.focusList('first')
  }
  function beforeOutput(): void { pendingOutput = true; show() }
  function forwardKey(event: KeyboardEvent): void {
    event.stopPropagation()
    terminal.focus()
    const forwarded = new KeyboardEvent('keydown', event)
    terminal.textarea?.dispatchEvent(forwarded)
    if (forwarded.defaultPrevented) event.preventDefault()
  }
  const subscriptions: IDisposable[] = [
    terminal.onData(data => {
      if (data === '\r') submittedUse = { cwd: context().cwd }
      dismissedPrefix = undefined
      resetQuery()
      tracker.input(data); pendingOutput = true; show()
    }),
    terminal.onWriteParsed(() => { pendingOutput = false; tracker.update(); refresh() }),
    terminal.onScroll(refresh), terminal.onSelectionChange(refresh),
    terminal.onResize(() => { tracker.reset(); tracker.update(); refresh() }),
    terminal.buffer.onBufferChange(() => { tracker.update(); resetQuery(); show() }),
  ]
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.isComposing || composing) return true
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !['ArrowDown', 'ArrowUp', 'Escape'].includes(event.key)) return true
    if (!view) return true
    refresh()
    if (!view) return true
    if (event.key === 'Escape') dismiss()
    else if (view.candidates.length) { locked = true; options.focusList(event.key === 'ArrowUp' ? 'last' : 'first') }
    else return true
    event.preventDefault(); return false
  })
  const focus = () => refresh()
  const blur = () => queueMicrotask(refresh)
  const compositionStart = () => { composing = true; resetQuery(); show() }
  const compositionEnd = () => { composing = false; refresh() }
  element.addEventListener('focusin', focus)
  element.addEventListener('focusout', blur)
  element.addEventListener('compositionstart', compositionStart)
  element.addEventListener('compositionend', compositionEnd)
  return {
    refresh, accept, forwardKey, dismiss, beforeOutput, applyPending,
    lock() { if (view?.candidates.length) locked = true },
    reset() { tracker.reset(); resetQuery(); dismissedPrefix = undefined; show() },
    dispose() {
      disposed = true; tracker.reset(); resetQuery()
      subscriptions.forEach(subscription => subscription.dispose())
      terminal.attachCustomKeyEventHandler(() => true)
      element.removeEventListener('focusin', focus); element.removeEventListener('focusout', blur)
      element.removeEventListener('compositionstart', compositionStart); element.removeEventListener('compositionend', compositionEnd)
      show()
    },
  }
}
