import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachTerminalAccessibilityInput } from './terminalAccessibilityInput'

class Input {
  private text = ''
  private listeners = new Map<string, Set<(event: Event) => void>>()
  get value() { return this.text }
  set value(value: string) { this.text = value }
  addEventListener(type: string, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: string, listener: (event: Event) => void) {
    this.listeners.get(type)?.delete(listener)
  }
  emit(type: string, fields: Record<string, unknown> = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, isTrusted: true, ...fields } as unknown as Event)
  }
  // Browser accessibility/native edits bypass JavaScript property setters.
  accessibilityWrite(text: string, fields: Record<string, unknown> = {}) {
    this.text = text
    this.emit('input', fields)
    this.emit('change')
  }
}

function fixture() {
  const textarea = new Input()
  const input = vi.fn()
  const attached = attachTerminalAccessibilityInput({ textarea: textarea as unknown as HTMLTextAreaElement, input })
  return { textarea, input, attached }
}

afterEach(() => { vi.useRealTimers() })

describe('temporary accessibility terminal input', () => {
  it('delivers a generic accessibility input once and clears the consumed buffer', () => {
    const { textarea, input } = fixture()
    textarea.accessibilityWrite('echo hello')
    expect(input.mock.calls).toEqual([['echo hello', true]])
    expect(textarea.value).toBe('')
  })

  it('does not forward normal keyboard, paste or IME input events a second time', () => {
    const { textarea, input } = fixture()
    for (const inputType of ['insertText', 'insertFromPaste', 'insertCompositionText', 'deleteContentBackward']) {
      textarea.accessibilityWrite('existing', { inputType, data: null })
    }
    expect(input).not.toHaveBeenCalled()
  })

  it('ignores synthetic generic events', () => {
    const { textarea, input } = fixture()
    textarea.accessibilityWrite('synthetic', { isTrusted: false })
    expect(input).not.toHaveBeenCalled()
  })

  it('forwards consecutive accessibility appends without replaying earlier text', () => {
    const { textarea, input } = fixture()
    textarea.accessibilityWrite('first')
    textarea.accessibilityWrite('second')
    expect(input.mock.calls).toEqual([['first', true], ['second', true]])
  })

  it('removes text already represented by native input from an accessibility append', () => {
    const { textarea, input } = fixture()
    textarea.accessibilityWrite('already typed', { inputType: 'insertText', data: 'already typed' })
    textarea.accessibilityWrite('already typed suffix')
    expect(input.mock.calls).toEqual([[' suffix', true]])
  })

  it('tracks xterm paste, selection-copy and Enter writes to its buffer', () => {
    const { textarea, input } = fixture()
    textarea.value = 'copied selection'
    textarea.accessibilityWrite('copied selectionnew text')
    textarea.value = ''
    textarea.accessibilityWrite('after Enter')
    expect(input.mock.calls).toEqual([['new text', true], ['after Enter', true]])
  })

  it('leaves composition to xterm until its asynchronous commit completes', () => {
    vi.useFakeTimers()
    const { textarea, input } = fixture()
    textarea.emit('compositionstart')
    textarea.accessibilityWrite('拼')
    textarea.emit('compositionend')
    textarea.accessibilityWrite('拼音')
    expect(input).not.toHaveBeenCalled()
    vi.runAllTimers()
    textarea.accessibilityWrite('拼音 next')
    expect(input.mock.calls).toEqual([[' next', true]])
  })

  it('preserves Unicode as one input payload', () => {
    const { textarea, input } = fixture()
    textarea.accessibilityWrite('中文🙂')
    expect(input.mock.calls).toEqual([['中文🙂', true]])
  })

  it('removes listeners, pending composition work and the property wrapper on disposal', () => {
    vi.useFakeTimers()
    const { textarea, input, attached } = fixture()
    textarea.emit('compositionend')
    attached.dispose()
    vi.runAllTimers()
    textarea.accessibilityWrite('after disposal')
    expect(input).not.toHaveBeenCalled()
    expect(Object.prototype.hasOwnProperty.call(textarea, 'value')).toBe(false)
    expect(textarea.value).toBe('after disposal')
  })
})
