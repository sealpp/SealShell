import { requestAI } from '../ai-http'
import { apiEndpoint, generatedText, generationBody } from './protocol'
import { modelCredentialId, type DiscoveredModel, type ModelService, type ResolvedModel } from './types'

export async function discoverModels(service: ModelService, signal: AbortSignal, apiKey?: string): Promise<DiscoveredModel[]> {
  const models = new Map<string, DiscoveredModel>(), cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const raw = await requestAI(apiEndpoint(service.baseUrl, service.protocol, 'models'), null, apiKey ?? '', signal, {
      method: 'GET', protocol: service.protocol, proxy: service.proxy, timeoutMs: 15000, diagnostic: true,
      credentialId: apiKey === undefined ? modelCredentialId(service.id) : undefined,
      query: service.protocol === 'anthropic' ? { limit: '1000', ...(cursor ? { after_id: cursor } : {}) } : undefined,
    })
    let data: any
    try { data = JSON.parse(raw) } catch { throw new Error('模型列表不是 JSON，请核对 API 路径和协议') }
    if (!Array.isArray(data.data)) throw new Error('接口未返回模型列表；可手动添加模型并执行模型检测')
    for (const entry of data.data) {
      if (typeof entry.id !== 'string' || !entry.id.trim()) continue
      models.set(entry.id, { id: entry.id, name: entry.display_name || entry.name || entry.id,
        contextWindow: entry.context_length, maxOutputTokens: entry.top_provider?.max_completion_tokens })
    }
    cursor = data.has_more ? data.last_id || data.data.at(-1)?.id : undefined
    if (cursor && (cursors.has(cursor) || cursors.size >= 100)) throw new Error('模型列表分页异常，请重试或手动添加模型')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id))
}

export async function generateModelText(resolved: ResolvedModel, system: string, prompt: string, signal: AbortSignal, options: { json?: boolean; apiKey?: string; diagnostic?: boolean } = {}): Promise<string> {
  const raw = await requestAI(apiEndpoint(resolved.service.baseUrl, resolved.protocol, 'generate'), generationBody(resolved, system, prompt, options.json), options.apiKey ?? '', signal, {
    protocol: resolved.protocol, proxy: resolved.service.proxy, timeoutMs: resolved.model.parameters.timeoutSeconds * 1000,
    diagnostic: options.diagnostic,
    credentialId: options.apiKey === undefined ? modelCredentialId(resolved.service.id) : undefined,
  })
  return generatedText(raw, resolved.protocol)
}
export async function checkModel(resolved: ResolvedModel, signal: AbortSignal, apiKey?: string): Promise<number> {
  const started = performance.now()
  await generateModelText(resolved, 'Reply briefly.', 'Reply with OK.', signal, { apiKey, diagnostic: true })
  return Math.round(performance.now() - started)
}
