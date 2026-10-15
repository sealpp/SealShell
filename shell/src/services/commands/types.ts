import type { Component } from 'vue'
import type { CommandContext } from '../context'

export type CommandLabel = string | ((ctx: CommandContext) => string)
export type CommandPredicate = (ctx: CommandContext) => boolean
export type CommandHandler = (ctx: CommandContext, ...args: unknown[]) => void | Promise<void>
export type WhenClause = string
export type Condition = WhenClause | CommandPredicate
export type CommandCategory = 'terminal' | 'workbench'

export interface KeyStroke {
  key: string
  modifiers?: readonly ('ctrl' | 'shift' | 'alt' | 'meta' | 'mod')[]
}

export interface KeybindingRule {
  key: string | KeyStroke
  when?: WhenClause
  weight?: number
  args?: unknown
}

export interface MenuContribution {
  menuId: string
  commandId?: string
  submenuId?: string
  title?: CommandLabel
  icon?: Component
  when?: Condition
  enablement?: Condition
  group?: string
  order?: number
  separator?: boolean
}

export interface SubmenuContribution {
  id: string
  title: CommandLabel
  parentMenuId: string
  when?: Condition
  group?: string
  order?: number
}

export interface ActionDescriptor {
  id: string
  title: CommandLabel
  description: string
  category: CommandCategory
  icon?: Component
  when?: Condition
  enablement?: Condition
  checked?: WhenClause | CommandPredicate
  run: CommandHandler
  menus?: readonly MenuContribution[]
  keybindings?: readonly KeybindingRule[]
}

export interface LegacyCommand {
  id: string
  label: CommandLabel
  shortcut?: string
  icon?: Component
  when?: CommandPredicate
  enabled?: CommandPredicate
  checked?: CommandPredicate
  execute: CommandHandler
}

export type Command = ActionDescriptor | LegacyCommand

export interface MenuCommandEntry {
  kind: 'command'
  commandId: string
  label?: CommandLabel
  shortcut?: string
  icon?: Component
  when?: CommandPredicate
  disabled?: CommandPredicate
  checked?: CommandPredicate
}

export interface MenuSubmenuEntry {
  kind: 'submenu'
  id: string
  label: CommandLabel
  items: MenuEntry[]
  when?: CommandPredicate
}

export interface MenuSeparatorEntry {
  kind: 'separator'
  id?: string
}

export type MenuEntry = MenuCommandEntry | MenuSubmenuEntry | MenuSeparatorEntry

export interface ResolvedMenuItem {
  id: string
  commandId?: string
  label: string
  shortcut?: string
  icon?: Component
  children?: ResolvedMenuItem[]
  separator?: boolean
  disabled: boolean
  checked: boolean
  action?: () => void | Promise<void>
}

export interface ResolvedKeybinding {
  commandId: string
  stroke: KeyStroke
  label: string
  args?: unknown
  when?: WhenClause
  weight: number
}

export interface KeybindingMatch {
  commandId: string
  args?: unknown
}
