import { reactive, watch } from 'vue'
import { clearCommandHistory, readCommandHistory, readMeta, recordCommandHistory, saveMeta } from '../storage'
import { canRememberCommand, type CommandHistoryEntry, type CommandUse } from './model'
import { modelServices, resolveModel } from '../modelServices/catalog'
import { modelCredentialId, type ModelSelection } from '../modelServices/types'
import { type RecommendationSettings } from './settings'

export type RecommendationPreferences = Pick<RecommendationSettings, 'cloud' | 'automatic' | 'remoteContext' | 'shareHistory'>
const defaultPreferences: RecommendationPreferences = { cloud: false, automatic: true, remoteContext: true, shareHistory: false }

interface SuggestionPreferences {
  key: 'commandSuggestions'
  enabled: boolean
  rememberHistory: boolean
  recommendations: RecommendationPreferences
  modelSelection: ModelSelection
}

export const commandSuggestions = reactive({
  enabled: true,
  rememberHistory: true,
  history: {} as Record<string, CommandHistoryEntry[]>,
  error: '',
  recommendations: { ...defaultPreferences },
  modelSelection: { mode: 'inherit' } as ModelSelection,
  revision: 0,
})

const loading = new Map<string, Promise<void>>()
let historyWrites = Promise.resolve()
watch(() => [modelServices.services, modelServices.primary], () => { commandSuggestions.revision++ }, { deep: true })

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
    const { cloud, automatic, remoteContext, shareHistory } = { ...defaultPreferences, ...preferences.recommendations }
    commandSuggestions.recommendations = { cloud, automatic, remoteContext, shareHistory }
    commandSuggestions.modelSelection = preferences.modelSelection ?? { mode: 'inherit' }
  }
}

export async function saveSuggestionPreferences(enabled: boolean, rememberHistory: boolean, recommendations = commandSuggestions.recommendations, modelSelection = commandSuggestions.modelSelection): Promise<void> {
  const { cloud, automatic, remoteContext, shareHistory } = recommendations
  const value: SuggestionPreferences = { key: 'commandSuggestions', enabled, rememberHistory, recommendations: { cloud, automatic, remoteContext, shareHistory }, modelSelection: JSON.parse(JSON.stringify(modelSelection)) }
  await saveMeta(value)
  commandSuggestions.enabled = enabled
  commandSuggestions.rememberHistory = rememberHistory
  commandSuggestions.recommendations = value.recommendations
  commandSuggestions.modelSelection = value.modelSelection
  commandSuggestions.revision++
}

export function resolveRecommendationSettings(): RecommendationSettings {
  const resolved = resolveModel(commandSuggestions.modelSelection)
  return { ...commandSuggestions.recommendations, baseUrl: resolved.service.baseUrl, model: resolved.model.id,
    preset: resolved.service.preset, protocol: resolved.protocol, parameters: resolved.model.parameters, proxy: resolved.service.proxy,
    credentialId: modelCredentialId(resolved.service.id) }
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
    if (!commandSuggestions.rememberHistory || !canRememberCommand(command)) return
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
