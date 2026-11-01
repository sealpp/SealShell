import { reactive } from 'vue'
import { readMeta, readCredential, saveModelCatalog } from '../storage'
import { encryptCredentialRecord } from '../vault'
import { apiEndpoint, validateParameters } from './protocol'
import { defaultModelParameters, modelCredentialId, type ModelCatalog, type ModelService, type ModelReference, type ModelSelection, type ResolvedModel, type DiscoveredModel, type ServiceModel } from './types'
import type { ServicePreset } from './presets'

export const modelServices = reactive<ModelCatalog>({ key: 'modelServices', services: [], primary: null })
let writing: Promise<unknown> = Promise.resolve()
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = writing.then(operation)
  writing = next.catch(() => {})
  return next
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export async function loadModelServices(): Promise<void> {
  const saved = await readMeta<ModelCatalog>('modelServices')
  if (saved) Object.assign(modelServices, saved)
}
export function newModelService(preset: ServicePreset): ModelService {
  return { id: crypto.randomUUID(), preset: preset.id, name: preset.name, baseUrl: preset.baseUrl, protocol: preset.protocol, proxy: { mode: 'direct' }, models: [] }
}
export function newServiceModel(service: ModelService, discovered: DiscoveredModel): ServiceModel {
  const parameters = defaultModelParameters()
  if (discovered.contextWindow) parameters.contextWindow = discovered.contextWindow
  if (discovered.maxOutputTokens) parameters.maxOutputTokens = Math.min(parameters.maxOutputTokens, discovered.maxOutputTokens)
  if (['deepseek', 'dashscope', 'moonshot'].includes(service.preset)) parameters.thinking = 'off'
  return { id: discovered.id.trim(), name: discovered.name.trim() || discovered.id.trim(), protocol: 'inherit', parameters }
}
export function validateService(service: ModelService): void {
  if (!service.name.trim()) throw new Error('请输入服务名称')
  if (service.baseUrl.trim()) apiEndpoint(service.baseUrl, service.protocol, 'models')
  const ids = new Set<string>()
  for (const model of service.models) {
    if (!model.id.trim()) throw new Error('请输入模型 ID')
    if (ids.has(model.id.trim())) throw new Error(`模型 ID 重复：${model.id}`)
    ids.add(model.id.trim())
    validateParameters({ service, model, protocol: model.protocol === 'inherit' ? service.protocol : model.protocol })
  }
  if (service.proxy.mode === 'saved' && !service.proxy.id) throw new Error('请选择代理服务器')
}
export function saveModelService(service: ModelService, apiKey?: string): Promise<void> {
  const value = copy(service)
  value.name = value.name.trim(); value.baseUrl = value.baseUrl.trim()
  validateService(value)
  return serialize(async () => {
    const items = copy(modelServices.services).filter(item => item.id !== value.id)
    items.push(value)
    const credential = apiKey === undefined ? undefined : apiKey.trim() ? await encryptCredentialRecord(modelCredentialId(value.id), { apiKey: apiKey.trim() }) : null
    const catalog = { key: 'modelServices' as const, services: items, primary: copy(modelServices.primary) }
    await saveModelCatalog(catalog, modelCredentialId(value.id), credential)
    Object.assign(modelServices, catalog)
  })
}
export function deleteModelService(id: string): Promise<void> {
  return serialize(async () => {
    const catalog = { key: 'modelServices' as const, services: copy(modelServices.services).filter(item => item.id !== id), primary: copy(modelServices.primary) }
    await saveModelCatalog(catalog, modelCredentialId(id), null)
    Object.assign(modelServices, catalog)
  })
}
export function setPrimaryModel(primary: ModelReference | null): Promise<void> {
  return serialize(async () => {
    const catalog = { key: 'modelServices' as const, services: copy(modelServices.services), primary: copy(primary) }
    await saveModelCatalog(catalog)
    Object.assign(modelServices, catalog)
  })
}
export const hasModelServiceKey = async (id: string): Promise<boolean> => !!await readCredential(modelCredentialId(id))
export function resolveModel(selection: ModelSelection = { mode: 'inherit' }): ResolvedModel {
  const reference = selection.mode === 'inherit' ? modelServices.primary : selection.model
  if (!reference) throw new Error(selection.mode === 'inherit' ? '请先在模型服务中设置主模型' : '请选择模型')
  const service = modelServices.services.find(item => item.id === reference.serviceId)
  const model = service?.models.find(item => item.id === reference.modelId)
  if (!service || !model) throw new Error('所选模型或服务已删除，请重新选择')
  return copy({ service, model, protocol: model.protocol === 'inherit' ? service.protocol : model.protocol })
}
export function modelReferenceLabel(reference: ModelReference | null): string {
  if (!reference) return '未配置'
  const service = modelServices.services.find(item => item.id === reference.serviceId)
  const model = service?.models.find(item => item.id === reference.modelId)
  return service && model ? `${service.name} / ${model.name || model.id}` : '模型已删除，请重新选择'
}
