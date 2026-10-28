import { preservesPathIntent } from './paths'

export interface CommandHistoryEntry {
  command: string
  uses: number
  lastUsed: number
  accepted?: number
  contexts?: { cwd: string; uses: number; lastUsed: number }[]
}

export interface CommandUse {
  cwd?: string
  kind?: 'accepted' | 'submitted'
}

export interface CommandSuggestion {
  command: string
  source: string
  priority: number
  uses: number
  lastUsed: number
}

export type RecommendationActivity = 'context' | 'ai'

export interface CommandSuggestionProvider {
  suggestions(prefix: string): readonly CommandSuggestion[]
}

export const COMMAND_HISTORY_LIMIT = 200
export const COMMAND_LENGTH_LIMIT = 2048
export const COMMAND_SUGGESTION_LIMIT = 8

export function canRememberCommand(command: string): boolean {
  return command.length >= 1 && command.length <= COMMAND_LENGTH_LIMIT
    && !/^\s/.test(command) && !/[\x00-\x1f\x7f]/.test(command)
}

export function rememberCommand(entries: readonly CommandHistoryEntry[], command: string, now: number, use: CommandUse = {}): CommandHistoryEntry[] {
  if (!canRememberCommand(command)) return [...entries]
  command = command.trimEnd()
  if (!canRememberCommand(command)) return [...entries]
  const previous = entries.find(entry => entry.command === command)
  const entry: CommandHistoryEntry = { ...previous, command, uses: (previous?.uses ?? 0) + (use.kind === 'accepted' ? 0 : 1), lastUsed: now }
  if (use.kind === 'accepted') entry.accepted = (previous?.accepted ?? 0) + 1
  if (use.cwd && use.kind !== 'accepted') {
    const contexts = previous?.contexts ?? []
    entry.contexts = [{ cwd: use.cwd, uses: (contexts.find(item => item.cwd === use.cwd)?.uses ?? 0) + 1, lastUsed: now },
      ...contexts.filter(item => item.cwd !== use.cwd)].slice(0, 12)
  }
  return [
    entry,
    ...entries.filter(entry => entry.command !== command),
  ].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, COMMAND_HISTORY_LIMIT)
}

export function matchesQuery(text: string, query: string): boolean {
  return query.toLocaleLowerCase().trim().split(/\s+/).every(token => text.toLocaleLowerCase().includes(token))
}

export function historyProvider(entries: readonly CommandHistoryEntry[], cwd?: string): CommandSuggestionProvider {
  return {
    suggestions: query => entries.filter(entry => matchesQuery(entry.command, query))
      .map(entry => ({ ...entry, source: 'history', priority: entry.contexts?.some(item => item.cwd === cwd) ? 3 : 1 })),
  }
}

function compare(a: CommandSuggestion, b: CommandSuggestion): number {
  return b.priority - a.priority || b.uses - a.uses || b.lastUsed - a.lastUsed
    || a.command.length - b.command.length || a.command.localeCompare(b.command)
}

export function findCommandSuggestions(prefix: string, providers: readonly CommandSuggestionProvider[]): CommandSuggestion[] {
  if (!canRememberCommand(prefix)) return []
  const candidates = new Map<string, CommandSuggestion>()
  for (const provider of providers) {
    for (const candidate of provider.suggestions(prefix)) {
      if (!canRememberCommand(candidate.command) || candidate.command === prefix || !preservesPathIntent(prefix, candidate.command)) continue
      const previous = candidates.get(candidate.command)
      if (!previous || compare(candidate, previous) < 0) candidates.set(candidate.command, candidate)
    }
  }
  return [...candidates.values()].sort(compare).slice(0, COMMAND_SUGGESTION_LIMIT)
}
