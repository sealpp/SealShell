import { reactive } from 'vue'
import { clearCommandHistory, readCommandHistory, readMeta, recordCommandHistory, saveMeta } from '../storage'
import { canRememberCommand, type CommandHistoryEntry } from './model'

interface SuggestionPreferences {
  key: 'commandSuggestions'
  enabled: boolean
  rememberHistory: boolean
}

export const commandSuggestions = reactive({
  enabled: true,
  rememberHistory: true,
  history: {} as Record<string, CommandHistoryEntry[]>,
  error: '',
})

const loading = new Map<string, Promise<void>>()
let historyWrites = Promise.resolve()

function queueHistoryWrite(operation: () => Promise<void>): Promise<void> {
  const result = historyWrites.then(operation)
  // A failed write is reported to its caller; later user operations can retry.
  historyWrites = result.catch(() => {})
  return result
}

export async function loadSuggestionPreferences(): Promise<void> {
  const preferences = await readMeta<SuggestionPreferences>('commandSuggestions')
  if (preferences) {
    commandSuggestions.enabled = preferences.enabled
    commandSuggestions.rememberHistory = preferences.rememberHistory
  }
}

export async function saveSuggestionPreferences(enabled: boolean, rememberHistory: boolean): Promise<void> {
  await saveMeta<SuggestionPreferences>({ key: 'commandSuggestions', enabled, rememberHistory })
  commandSuggestions.enabled = enabled
  commandSuggestions.rememberHistory = rememberHistory
}

export function loadSuggestionHistory(hostId: string): Promise<void> {
  let pending = loading.get(hostId)
  if (!pending) {
    pending = readCommandHistory(hostId).then(items => { commandSuggestions.history[hostId] = items })
    loading.set(hostId, pending)
  }
  return pending
}

export function rememberSuggestionCommand(hostId: string, command: string): Promise<void> {
  return queueHistoryWrite(async () => {
    if (!commandSuggestions.enabled || !commandSuggestions.rememberHistory || !canRememberCommand(command)) return
    await loadSuggestionHistory(hostId)
    commandSuggestions.history[hostId] = await recordCommandHistory(hostId, command)
  })
}

export function clearSuggestionHistory(): Promise<void> {
  return queueHistoryWrite(async () => {
    // Finish initial reads so a delayed load cannot restore cleared entries.
    await Promise.all(loading.values())
    await clearCommandHistory()
    for (const hostId of Object.keys(commandSuggestions.history)) commandSuggestions.history[hostId] = []
  })
}
