import { beforeEach, expect, it, vi } from 'vitest'
import { installNativeAdapter } from '../../native/bridge'
import { deleteModelService, loadModelServices, modelServices, newModelService, newServiceModel, resolveModel, saveModelService, setPrimaryModel } from './catalog'
import { servicePresets } from './presets'
let records: Record<string, Record<string, any>>
beforeEach(() => {
  records = {}
  Object.assign(modelServices, { services: [], primary: null })
  installNativeAdapter({ subscribe: async () => () => {}, async call(operation, args: any) {
    if (operation === 'store_get') return records[args.collection]?.[args.key] ?? null
    if (operation === 'credential_protect') return { id: args.id, ciphertext: `protected:${JSON.stringify(args.value)}` } as any
    if (operation === 'store_write') { for (const change of args.changes) { const items = records[change.collection] ??= {}; if (change.value == null) delete items[change.key]; else items[change.key] = structuredClone(change.value) }; return true as any }
    throw new Error(`Unexpected operation ${operation}`)
  } })
})
it('persists provider keys separately, requires explicit additions, resolves overrides and preserves deleted references', async () => {
  const service = newModelService(servicePresets.find(item => item.id === 'openai')!)
  await saveModelService(service, 'synthetic-key')
  expect(modelServices.services[0].models).toEqual([])
  expect(JSON.stringify(records.meta)).not.toContain('synthetic-key')
  expect(records.credentials[`model-service:${service.id}`].ciphertext).toBe('protected:{"apiKey":"synthetic-key"}')
  service.models.push(newServiceModel(service, { id: 'alpha', name: 'Alpha' }), newServiceModel(service, { id: 'beta', name: 'Beta' }))
  service.models[1].protocol = 'anthropic'
  await saveModelService(service)
  await setPrimaryModel({ serviceId: service.id, modelId: 'alpha' })
  expect(resolveModel().protocol).toBe('openai-responses')
  expect(resolveModel({ mode: 'custom', model: { serviceId: service.id, modelId: 'beta' } }).protocol).toBe('anthropic')
  const snapshot = resolveModel()
  modelServices.services = []; modelServices.primary = null
  await loadModelServices()
  expect(resolveModel().model.id).toBe('alpha')
  await deleteModelService(service.id)
  expect(() => resolveModel()).toThrow('已删除')
  expect(snapshot.model.id).toBe('alpha')
  expect(records.credentials[`model-service:${service.id}`]).toBeUndefined()
})
it('keeps the saved catalog and key intact if an atomic write fails', async () => {
  const service = newModelService(servicePresets[0]); await saveModelService(service, 'first-key')
  const snapshot = JSON.stringify(records)
  const adapter = { subscribe: async () => () => {}, call: vi.fn(async (op: string) => { if (op === 'credential_protect') return { id: 'x', ciphertext: 'new-key' } as any; throw new Error('disk full') }) }
  installNativeAdapter(adapter)
  service.name = 'unsaved'
  await expect(saveModelService(service, 'second-key')).rejects.toThrow('disk full')
  expect(modelServices.services[0].name).toBe('DeepSeek')
  expect(JSON.stringify(records)).toBe(snapshot)
})
