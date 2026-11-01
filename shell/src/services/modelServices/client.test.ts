import { afterEach, expect, it, vi } from 'vitest'
import { requestAI } from '../ai-http'
import { discoverModels, generateModelText } from './client'
import { newModelService, newServiceModel } from './catalog'
import { servicePresets } from './presets'
vi.mock('../ai-http', () => ({ requestAI: vi.fn() }))
afterEach(() => { vi.resetAllMocks() })
it('paginates Anthropic with the same explicit route and keeps IDs distinct without adding models', async () => {
  const service = newModelService(servicePresets.find(item => item.id === 'anthropic')!)
  service.proxy = { mode: 'saved', id: 'proxy-test' }
  vi.mocked(requestAI).mockResolvedValueOnce(JSON.stringify({ data: [{ id: 'model-2026', display_name: 'Same name' }], has_more: true, last_id: 'model-2026' })).mockResolvedValueOnce(JSON.stringify({ data: [{ id: 'model-2027', display_name: 'Same name' }], has_more: false }))
  const signal = new AbortController().signal
  expect(await discoverModels(service, signal)).toEqual([{ id: 'model-2026', name: 'Same name' }, { id: 'model-2027', name: 'Same name' }])
  expect(service.models).toEqual([])
  expect(vi.mocked(requestAI).mock.calls[1]).toEqual(['https://api.anthropic.com/v1/models', null, '', signal, { method: 'GET', protocol: 'anthropic', proxy: { mode: 'saved', id: 'proxy-test' }, timeoutMs: 15000, diagnostic: true, credentialId: `model-service:${service.id}`, query: { limit: '1000', after_id: 'model-2026' } }])
})
it('reports listing failures rather than presenting an incomplete cached list', async () => {
  const service = newModelService(servicePresets[0])
  vi.mocked(requestAI).mockResolvedValueOnce('<html>login</html>')
  await expect(discoverModels(service, new AbortController().signal)).rejects.toThrow('不是 JSON')
  vi.mocked(requestAI).mockRejectedValueOnce(new Error('HTTP 401'))
  await expect(discoverModels(service, new AbortController().signal)).rejects.toThrow('401')
})
it('uses a model protocol override for generation and forwards timeout and route unchanged', async () => {
  const service = newModelService(servicePresets[0]), model = newServiceModel(service, { id: 'custom-id', name: 'test' })
  service.proxy = { mode: 'system' }; model.protocol = 'openai-responses'; model.parameters.timeoutSeconds = 90
  vi.mocked(requestAI).mockResolvedValue('{"output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}')
  expect(await generateModelText({ service, model, protocol: model.protocol }, 'system', 'hello', new AbortController().signal)).toBe('OK')
  const call = vi.mocked(requestAI).mock.calls[0]
  expect(call[0]).toBe('https://api.deepseek.com/v1/responses')
  expect(call[1]).toMatchObject({ input: 'hello', instructions: 'system', store: false })
  expect(call[4]).toMatchObject({ proxy: { mode: 'system' }, timeoutMs: 90000, credentialId: `model-service:${service.id}` })
})
