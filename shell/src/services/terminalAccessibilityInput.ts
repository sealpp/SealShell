import type { Terminal } from '@xterm/xterm'

// Temporary compatibility for accessibility value writes that publish a generic
// input event without the payload xterm needs. Attach after terminal.open().
export function attachTerminalAccessibilityInput(terminal: Pick<Terminal, 'textarea' | 'input'>) {
  const textarea = terminal.textarea!
  const ownValue = Object.getOwnPropertyDescriptor(textarea, 'value')
  const value = ownValue ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')!
  let previous = textarea.value
  let composing = false
  let compositionEnd: ReturnType<typeof setTimeout> | undefined

  // xterm also writes this buffer for paste, selection copying and Enter.
  // Remember those writes so an accessibility append forwards only new text.
  Object.defineProperty(textarea, 'value', {
    configurable: true,
    enumerable: value.enumerable,
    get: () => value.get!.call(textarea),
    set: (text: string) => {
      value.set!.call(textarea, text)
      previous = value.get!.call(textarea)
    },
  })

  const onInput = (event: Event) => {
    const current = textarea.value
    const before = previous
    previous = current
    if (!event.isTrusted || 'data' in event || 'inputType' in event || composing || !current) return
    const inserted = current.startsWith(before) ? current.slice(before.length) : current
    if (!inserted) return
    textarea.value = ''
    terminal.input(inserted, true)
  }
  const onCompositionStart = () => {
    clearTimeout(compositionEnd)
    composing = true
  }
  const onCompositionEnd = () => {
    // xterm commits composition in a timer; let that finish before accepting
    // an accessibility write as a new input operation.
    compositionEnd = setTimeout(() => {
      composing = false
      previous = textarea.value
    }, 0)
  }
  textarea.addEventListener('input', onInput, true)
  textarea.addEventListener('compositionstart', onCompositionStart)
  textarea.addEventListener('compositionend', onCompositionEnd)

  return {
    dispose() {
      clearTimeout(compositionEnd)
      textarea.removeEventListener('input', onInput, true)
      textarea.removeEventListener('compositionstart', onCompositionStart)
      textarea.removeEventListener('compositionend', onCompositionEnd)
      if (ownValue) Object.defineProperty(textarea, 'value', ownValue)
      else Reflect.deleteProperty(textarea, 'value')
    },
  }
}
