import { modelServices, newModelService, newServiceModel, saveModelService, setPrimaryModel } from '../src/services/modelServices/catalog'
import { servicePresets } from '../src/services/modelServices/presets'
import { commandSuggestions, saveSuggestionPreferences } from '../src/services/terminalSuggestions/runtime'
import type { ModelProtocol } from '../src/services/modelServices/types'

export async function configureModelFixture(baseUrl: string, modelId = 'test-model', apiKey = 'synthetic-key', protocol: ModelProtocol = 'openai-chat', automatic = true) {
  const service = newModelService(servicePresets.find(item => item.id === 'custom')!)
  service.name = 'Fixture model service'; service.baseUrl = baseUrl; service.protocol = protocol
  service.models.push(newServiceModel(service, { id: modelId, name: modelId }))
  await saveModelService(service, apiKey)
  await setPrimaryModel({ serviceId: service.id, modelId })
  await saveSuggestionPreferences(commandSuggestions.enabled, commandSuggestions.rememberHistory, { cloud: true, automatic, remoteContext: false, shareHistory: false }, { mode: 'inherit' })
  return modelServices.primary
}
