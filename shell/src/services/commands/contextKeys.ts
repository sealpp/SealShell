import { ref } from 'vue'
import type { CommandContext } from '../context'
import type { Condition } from './types'

export type ContextValue = boolean | number | string | null | undefined
export type ContextSnapshot = Readonly<Record<string, ContextValue>>

export const ContextKeys = {
  area: 'area',
  view: 'view',
  activeTabId: 'activeTabId',
  activeTabExists: 'activeTabExists',
  tabExists: 'tabExists',
  hasSelection: 'hasSelection',
  isOnline: 'isOnline',
  canPaste: 'canPaste',
  tabEncoding: 'tabEncoding',
  selectedCount: 'selectedCount',
  sidebarOpen: 'sidebarOpen',
  bottomPanelOpen: 'bottomPanelOpen',
  bottomPanelCategory: 'bottomPanelCategory',
  focusedDock: 'focusedDock',
  modalOpen: 'modalOpen',
} as const

const keyValuePattern = /^[A-Za-z_$][\w$.-]*$/

class WhenParser {
  private index = 0

  constructor(
    private readonly source: string,
    private readonly values: ContextSnapshot,
  ) {}

  parse(): boolean {
    const result = this.parseOr()
    this.skipWhitespace()
    if (this.index !== this.source.length) {
      throw new Error(`unexpected token at ${this.index}`)
    }
    return result
  }

  private parseOr(): boolean {
    let value = this.parseAnd()
    while (this.consume('||')) {
      const right = this.parseAnd()
      value = value || right
    }
    return value
  }

  private parseAnd(): boolean {
    let value = this.parseUnary()
    while (this.consume('&&')) {
      const right = this.parseUnary()
      value = value && right
    }
    return value
  }

  private parseUnary(): boolean {
    if (this.consume('!')) return !this.parseUnary()
    if (this.consume('(')) {
      const value = this.parseOr()
      this.expect(')')
      return value
    }

    const left = this.parseValue()
    const operator = this.parseOperator()
    if (!operator) return Boolean(left)
    const right = this.parseValue()
    return compareValues(left, right, operator)
  }

  private parseValue(): ContextValue {
    this.skipWhitespace()
    const char = this.source[this.index]
    if (char === "'" || char === '"') return this.parseString(char)

    const start = this.index
    while (this.index < this.source.length && !/[\s()!<>=&|]/.test(this.source[this.index])) {
      this.index++
    }
    const token = this.source.slice(start, this.index)
    if (!token) throw new Error(`expected value at ${this.index}`)
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (token === 'undefined') return undefined
    if (/^-?\d+(?:\.\d+)?$/.test(token)) return Number(token)
    if (!keyValuePattern.test(token)) throw new Error(`invalid value ${token}`)
    return this.values[token]
  }

  private parseString(quote: string): string {
    this.index++
    let value = ''
    while (this.index < this.source.length) {
      const char = this.source[this.index++]
      if (char === quote) return value
      if (char === '\\' && this.index < this.source.length) {
        value += this.source[this.index++]
      } else {
        value += char
      }
    }
    throw new Error('unterminated string')
  }

  private parseOperator(): string | null {
    this.skipWhitespace()
    for (const operator of ['!==', '===', '>=', '<=', '==', '!=', '>', '<']) {
      if (this.consume(operator)) return operator
    }
    return null
  }

  private consume(value: string): boolean {
    this.skipWhitespace()
    if (this.source.startsWith(value, this.index)) {
      this.index += value.length
      return true
    }
    return false
  }

  private expect(value: string): void {
    if (!this.consume(value)) throw new Error(`expected ${value} at ${this.index}`)
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index])) this.index++
  }
}

function compareValues(left: ContextValue, right: ContextValue, operator: string): boolean {
  switch (operator) {
    case '==':
    case '===':
      return left === right
    case '!=':
    case '!==':
      return left !== right
    case '>':
      return typeof left === 'number' && typeof right === 'number' && left > right
    case '>=':
      return typeof left === 'number' && typeof right === 'number' && left >= right
    case '<':
      return typeof left === 'number' && typeof right === 'number' && left < right
    case '<=':
      return typeof left === 'number' && typeof right === 'number' && left <= right
    default:
      return false
  }
}

export function evaluateWhen(condition: Condition | undefined, ctx: CommandContext, values: ContextSnapshot): boolean {
  if (!condition) return true
  if (typeof condition === 'function') return condition(ctx)
  if (!condition.trim()) return true
  try {
    return new WhenParser(condition, values).parse()
  } catch (error) {
    console.warn(`[ContextKeyService] invalid when expression: ${condition}`, error)
    return false
  }
}

export class ContextKeyService {
  private readonly revision = ref(0)
  private readonly values = new Map<string, ContextValue>()

  setContext(key: string, value: ContextValue): void {
    if (this.values.get(key) === value && this.values.has(key)) return
    if (value === undefined) this.values.delete(key)
    else this.values.set(key, value)
    this.revision.value++
  }

  getContextKeyValue(key: string): ContextValue {
    return this.values.get(key)
  }

  getSnapshot(invocation?: CommandContext): ContextSnapshot {
    // Reading revision makes Vue computed consumers reactive to context changes.
    void this.revision.value
    const snapshot: Record<string, ContextValue> = Object.fromEntries(this.values)
    if (invocation) Object.assign(snapshot, contextValues(invocation))
    return snapshot
  }

  evaluate(condition: Condition | undefined, invocation: CommandContext): boolean {
    return evaluateWhen(condition, invocation, this.getSnapshot(invocation))
  }
}

function contextValues(ctx: CommandContext): Record<string, ContextValue> {
  const values: Record<string, ContextValue> = {
    [ContextKeys.area]: ctx.area,
  }
  if (ctx.tabId !== undefined) {
    values[ContextKeys.activeTabId] = ctx.tabId
    values[ContextKeys.tabExists] = Boolean(ctx.tabId)
  }
  if (ctx.hasSelection !== undefined) values[ContextKeys.hasSelection] = ctx.hasSelection
  if (ctx.isOnline !== undefined) values[ContextKeys.isOnline] = ctx.isOnline
  if (ctx.canPaste !== undefined) values[ContextKeys.canPaste] = ctx.canPaste
  if (ctx.tabEncoding !== undefined) values[ContextKeys.tabEncoding] = ctx.tabEncoding
  if (ctx.selectedCount !== undefined) values[ContextKeys.selectedCount] = ctx.selectedCount
  return values
}

export const contextKeyService = new ContextKeyService()

export function syncAppContext(values: Record<string, ContextValue>): void {
  for (const [key, value] of Object.entries(values)) contextKeyService.setContext(key, value)
}
