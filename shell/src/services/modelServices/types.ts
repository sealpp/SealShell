export type ModelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'
export type ModelProxy = { mode: 'direct' | 'system' } | { mode: 'saved'; id: string }
export interface ModelParameters {
  contextWindow: number
  maxOutputTokens: number
  temperature: number | null
  thinking: 'auto' | 'on' | 'off'
  reasoningEffort: 'auto' | 'low' | 'medium' | 'high'
  timeoutSeconds: number
}
export interface ServiceModel {
  id: string
  name: string
  protocol: ModelProtocol | 'inherit'
  parameters: ModelParameters
}
export interface ModelService {
  id: string
  preset: string
  name: string
  baseUrl: string
  protocol: ModelProtocol
  proxy: ModelProxy
  models: ServiceModel[]
}
export interface ModelReference { serviceId: string; modelId: string }
export type ModelSelection = { mode: 'inherit' } | { mode: 'custom'; model: ModelReference | null }
export interface ModelCatalog { key: 'modelServices'; services: ModelService[]; primary: ModelReference | null }
export interface DiscoveredModel { id: string; name: string; contextWindow?: number; maxOutputTokens?: number }
export interface ResolvedModel { service: ModelService; model: ServiceModel; protocol: ModelProtocol }
export const protocolLabels: Record<ModelProtocol, string> = {
  'openai-chat': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic Messages',
}
export const defaultModelParameters = (): ModelParameters => ({
  contextWindow: 32768, maxOutputTokens: 2048, temperature: null,
  thinking: 'auto', reasoningEffort: 'auto', timeoutSeconds: 45,
})
export const modelCredentialId = (id: string): string => `model-service:${id}`
