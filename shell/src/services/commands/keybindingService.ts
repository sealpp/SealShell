import type { CommandContext } from '../context'
import { commandService, type CommandService } from './commandRegistry'
import { contextKeyService, type ContextKeyService } from './contextKeys'
import { keybindingRegistry, type KeybindingRegistry } from './keybindingRegistry'
import type { ResolvedKeybinding } from './types'

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('.shell-terminal')) return false
  if (target.closest('[role="dialog"], .workbench-dialog-content')) return true
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true
  return target.closest('[contenteditable="true"]') !== null
}

export class KeybindingService {
  private detach: (() => void) | undefined

  constructor(
    private readonly registry: KeybindingRegistry = keybindingRegistry,
    private readonly commands: CommandService = commandService,
    private readonly contexts: ContextKeyService = contextKeyService,
  ) {}

  attach(target: Window, contextProvider: () => CommandContext | null): () => void {
    this.detach?.()
    const listener = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || isTextInputTarget(event.target)) return
      const context = contextProvider()
      if (!context) return
      const match = this.registry.resolve(event, context, this.contexts)
      if (!match || !this.commands.isEnabled(match.commandId, context)) return
      event.preventDefault()
      event.stopPropagation()
      void this.commands.execute(match.commandId, context, match.args)
    }
    target.addEventListener('keydown', listener, true)
    const detach = () => target.removeEventListener('keydown', listener, true)
    this.detach = detach
    return detach
  }

  getBindings(commandId: string, context?: CommandContext): ResolvedKeybinding[] {
    return this.registry.getBindings(commandId, context)
  }

  getLabel(commandId: string, context?: CommandContext): string | undefined {
    return this.registry.getLabel(commandId, context)
  }

  dispose(): void {
    this.detach?.()
    this.detach = undefined
  }
}

export const keybindingService = new KeybindingService()
