import { reactive } from 'vue'
import { clearCommandHistory, readCommandHistory, readMeta, recordCommandHistory, saveMeta } from '../storage'
import { canRememberCommand, type CommandHistoryEntry, type CommandUse } from './model'
import { loadCredentialRecord, saveCredentialRecord } from '../vault'
import { defaultRecommendationSettings, validateRecommendationSettings, type RecommendationSettings } from './settings'

interface SuggestionPreferences {
  key: 'commandSuggestions'
  enabled: boolean
  rememberHistory: boolean
  recommendations?: RecommendationSettings
}

export const commandSuggestions = reactive({
  enabled: true,
  rememberHistory: true,
  history: {} as Record<string, CommandHistoryEntry[]>,
  error: '',
  recommendations: { ...defaultRecommendationSettings },
  revision: 0,
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
    commandSuggestions.recommendations = { ...defaultRecommendationSettings, ...preferences.recommendations }
  }
}

export async function saveSuggestionPreferences(enabled: boolean, rememberHistory: boolean, recommendations = commandSuggestions.recommendations, apiKey?: string): Promise<void> {
  validateRecommendationSettings(recommendations)
  if (apiKey !== undefined) await saveCredentialRecord('command-recommendations', { apiKey: apiKey.trim() })
  await saveMeta<SuggestionPreferences>({ key: 'commandSuggestions', enabled, rememberHistory, recommendations: { ...recommendations } })
  commandSuggestions.enabled = enabled
  commandSuggestions.rememberHistory = rememberHistory
  commandSuggestions.recommendations = { ...recommendations }
  commandSuggestions.revision++
}

export async function loadRecommendationKey(): Promise<string> {
  return (await loadCredentialRecord('command-recommendations'))?.apiKey ?? ''
}

export function loadSuggestionHistory(hostId: string): Promise<void> {
  let pending = loading.get(hostId)
  if (!pending) {
    pending = readCommandHistory(hostId).then(items => { commandSuggestions.history[hostId] = items })
    loading.set(hostId, pending)
  }
  return pending
}

export function rememberSuggestionCommand(hostId: string, command: string, use: CommandUse = {}): Promise<void> {
  return queueHistoryWrite(async () => {
    if (!commandSuggestions.enabled || !commandSuggestions.rememberHistory || !canRememberCommand(command)) return
    await loadSuggestionHistory(hostId)
    commandSuggestions.history[hostId] = await recordCommandHistory(hostId, command, use)
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
