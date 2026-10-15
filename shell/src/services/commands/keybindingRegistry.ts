import { ref } from 'vue'
import type { CommandContext } from '../context'
import { contextKeyService, type ContextKeyService } from './contextKeys'
import type { KeybindingMatch, KeybindingRule, KeyStroke, ResolvedKeybinding } from './types'

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

function normalizeKey(key: string): string {
  const normalized = key.trim()
  if (normalized === '`') return 'Backquote'
  if (/^[a-z]$/i.test(normalized)) return `Key${normalized.toUpperCase()}`
  if (/^\d$/.test(normalized)) return `Digit${normalized}`
  const aliases: Record<string, string> = {
    Esc: 'Escape',
    Return: 'Enter',
    Spacebar: 'Space',
    Del: 'Delete',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
  }
  return aliases[normalized] ?? normalized
}

export function parseKeyStroke(value: string | KeyStroke): KeyStroke {
  if (typeof value !== 'string') {
    return { key: normalizeKey(value.key), modifiers: [...(value.modifiers ?? [])] }
  }
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  const key = parts.pop()
  if (!key) throw new Error(`invalid keybinding: ${value}`)
  const modifiers = parts.map((part) => {
    switch (part.toLowerCase()) {
      case 'ctrl':
      case 'control':
        return 'ctrl' as const
      case 'shift':
        return 'shift' as const
      case 'alt':
      case 'option':
        return 'alt' as const
      case 'meta':
      case 'cmd':
      case 'command':
        return 'meta' as const
      case 'mod':
        return 'mod' as const
      default:
        throw new Error(`invalid modifier ${part}`)
    }
  })
  return { key: normalizeKey(key), modifiers }
}

export function keyStrokeFromKeyboardEvent(event: KeyboardEvent): KeyStroke | null {
  if (event.isComposing || event.repeat) return null
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null
  const modifiers: Array<'ctrl' | 'shift' | 'alt' | 'meta'> = []
  if (event.ctrlKey) modifiers.push('ctrl')
  if (event.shiftKey) modifiers.push('shift')
  if (event.altKey) modifiers.push('alt')
  if (event.metaKey) modifiers.push('meta')
  if (!event.code) return null
  return { key: normalizeKey(event.code), modifiers }
}

function effectiveModifier(modifier: 'ctrl' | 'shift' | 'alt' | 'meta' | 'mod'): 'ctrl' | 'shift' | 'alt' | 'meta' {
  if (modifier === 'mod') return isMac ? 'meta' : 'ctrl'
  return modifier
}

function modifierSet(stroke: KeyStroke): Set<string> {
  const result = new Set<string>()
  for (const modifier of stroke.modifiers ?? []) {
    result.add(effectiveModifier(modifier))
  }
  return result
}

function matchesStroke(event: KeyboardEvent, stroke: KeyStroke): boolean {
  const expected = modifierSet(stroke)
  const actual = new Set<string>()
  if (event.ctrlKey) actual.add('ctrl')
  if (event.shiftKey) actual.add('shift')
  if (event.altKey) actual.add('alt')
  if (event.metaKey) actual.add('meta')
  return event.code === stroke.key && expected.size === actual.size && [...expected].every((modifier) => actual.has(modifier))
}

function keyLabel(key: string): string {
  if (key === 'Backquote') return '`'
  if (key.startsWith('Key')) return key.slice(3)
  if (key.startsWith('Digit')) return key.slice(5)
  if (key === 'ArrowLeft') return 'Left'
  if (key === 'ArrowRight') return 'Right'
  if (key === 'ArrowUp') return 'Up'
  if (key === 'ArrowDown') return 'Down'
  return key
}

export function formatKeyStroke(value: string | KeyStroke): string {
  const stroke = parseKeyStroke(value)
  const modifiers = [...new Set(stroke.modifiers ?? [])].map((modifier) => {
    switch (modifier) {
      case 'mod': return isMac ? 'Cmd' : 'Ctrl'
      case 'meta': return 'Cmd'
      case 'ctrl': return 'Ctrl'
      case 'shift': return 'Shift'
      case 'alt': return isMac ? 'Option' : 'Alt'
    }
  })
  return [...modifiers, keyLabel(stroke.key)].join('+')
}

interface StoredBinding {
  commandId: string
  stroke: KeyStroke
  when?: string
  weight: number
  args?: unknown
  sequence: number
}

export class KeybindingRegistry {
  private readonly defaults: StoredBinding[] = []
  private sequence = 0
  private readonly revision = ref(0)

  register(commandId: string, rule: KeybindingRule): () => void {
    let stroke: KeyStroke
    try {
      stroke = parseKeyStroke(rule.key)
    } catch (error) {
      console.warn(`[KeybindingRegistry] invalid binding for ${commandId}`, error)
      return () => undefined
    }
    const stored: StoredBinding = {
      commandId,
      stroke,
      when: rule.when,
      weight: rule.weight ?? 0,
      args: rule.args,
      sequence: this.sequence++,
    }
    this.defaults.push(stored)
    this.touch()
    return () => {
      const index = this.defaults.indexOf(stored)
      if (index !== -1) {
        this.defaults.splice(index, 1)
        this.touch()
      }
    }
  }

  getBindings(commandId: string, ctx?: CommandContext): ResolvedKeybinding[] {
    void this.revision.value
    return this.effectiveBindings(commandId)
      .filter((binding) => !ctx || !binding.when || contextKeyService.evaluate(binding.when, ctx))
      .sort((left, right) => right.weight - left.weight || right.sequence - left.sequence)
      .map((binding) => ({
        commandId: binding.commandId,
        stroke: binding.stroke,
        label: formatKeyStroke(binding.stroke),
        args: binding.args,
        when: binding.when,
        weight: binding.weight,
      }))
  }

  getLabel(commandId: string, ctx?: CommandContext): string | undefined {
    return this.getBindings(commandId, ctx)[0]?.label
  }

  resolve(event: KeyboardEvent, ctx: CommandContext, contexts: ContextKeyService = contextKeyService): KeybindingMatch | null {
    const candidates = this.effectiveBindings()
      .filter((binding) => matchesStroke(event, binding.stroke))
      .filter((binding) => !binding.when || contexts.evaluate(binding.when, ctx))
      .sort((left, right) => right.weight - left.weight || right.sequence - left.sequence)
    const match = candidates[0]
    if (!match) return null
    return { commandId: match.commandId, args: match.args }
  }

  private effectiveBindings(commandId?: string): StoredBinding[] {
    const result = this.defaults
    return commandId ? result.filter((binding) => binding.commandId === commandId) : result
  }

  private touch(): void {
    this.revision.value++
  }

}

export const keybindingRegistry = new KeybindingRegistry()
