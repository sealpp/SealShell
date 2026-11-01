import type { ModelProtocol, ResolvedModel } from './types'

export function apiEndpoint(baseUrl: string, protocol: ModelProtocol, operation: 'models' | 'generate'): string {
  let url: URL
  try { url = new URL(baseUrl.trim()) } catch { throw new Error('请输入有效的 API 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API 地址须为不含凭据和查询参数的 HTTP 或 HTTPS 地址')
  }
  let path = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|responses|messages|models)$/, '')
  if (!path) path = '/v1'
  const suffix = operation === 'models' ? 'models' : protocol === 'anthropic' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions'
  url.pathname = `${path}/${suffix}`
  return url.toString()
}

export function validateParameters(resolved: ResolvedModel): void {
  const p = resolved.model.parameters
  for (const [label, value, min, max] of [
    ['上下文预算', p.contextWindow, 1024, 10_000_000], ['最大输出', p.maxOutputTokens, 1, 1_000_000], ['超时时间', p.timeoutSeconds, 1, 180],
  ] as const) if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label}须为 ${min}–${max} 的整数`)
  if (p.maxOutputTokens >= p.contextWindow) throw new Error('最大输出须小于上下文预算')
  const maxTemperature = resolved.protocol === 'anthropic' ? 1 : 2
  if (p.temperature !== null && (!Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > maxTemperature)) throw new Error(`温度须为 0–${maxTemperature}，留空使用服务默认值`)
  if (resolved.protocol === 'anthropic' && p.thinking === 'on' && p.maxOutputTokens <= 1024) throw new Error('Anthropic 开启思考时，最大输出须大于 1024')
}

export function generationBody(resolved: ResolvedModel, system: string, prompt: string, json = false): Record<string, any> {
  validateParameters(resolved)
  const { model, service, protocol } = resolved, p = model.parameters
  // This is a conservative local budget, not a claim about a vendor's tokenizer.
  const budget = p.contextWindow - p.maxOutputTokens
  if ([...system + prompt].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 1 : 0.34), 0) > budget) throw new Error('输入超过配置的上下文预算，请增加预算或减少上下文')
  const body: Record<string, any> = { model: model.id, stream: false }
  if (protocol === 'anthropic') {
    Object.assign(body, { system, messages: [{ role: 'user', content: prompt }], max_tokens: p.maxOutputTokens })
    if (p.thinking !== 'auto') body.thinking = p.thinking === 'on' ? { type: 'enabled', budget_tokens: 1024 } : { type: 'disabled' }
    if (p.temperature !== null && p.thinking !== 'on') body.temperature = p.temperature
  } else if (protocol === 'openai-responses') {
    Object.assign(body, { instructions: system, input: prompt, max_output_tokens: p.maxOutputTokens, store: false })
    if (json) body.text = { format: { type: 'json_object' } }
    if (p.temperature !== null) body.temperature = p.temperature
    if (p.reasoningEffort !== 'auto') body.reasoning = { effort: p.reasoningEffort }
    else if (p.thinking !== 'auto') body.reasoning = { effort: p.thinking === 'off' ? 'none' : 'medium' }
  } else {
    Object.assign(body, { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], [service.preset === 'openai' ? 'max_completion_tokens' : 'max_tokens']: p.maxOutputTokens })
    if (json && ['openai', 'deepseek', 'dashscope', 'siliconflow', 'moonshot'].includes(service.preset)) body.response_format = { type: 'json_object' }
    if (p.temperature !== null) body.temperature = p.temperature
    if (p.reasoningEffort !== 'auto') body.reasoning_effort = p.reasoningEffort
    if (p.thinking !== 'auto') {
      if (service.preset === 'dashscope') body.enable_thinking = p.thinking === 'on'
      else if (['deepseek', 'moonshot'].includes(service.preset)) body.thinking = { type: p.thinking === 'on' ? 'enabled' : 'disabled' }
      else if (p.reasoningEffort === 'auto') body.reasoning_effort = p.thinking === 'off' ? 'none' : 'medium'
    }
  }
  return body
}

export function generatedText(raw: string, protocol: ModelProtocol): string {
  let data: any
  try { data = JSON.parse(raw) } catch { throw new Error('服务未返回有效 JSON，请核对 API 地址和协议') }
  if (data.error) throw new Error('模型返回错误，请通过模型检测检查配置')
  let text: string | undefined
  if (protocol === 'anthropic') text = data.content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('')
  else if (protocol === 'openai-responses') text = data.output?.filter((part: any) => part.type === 'message').flatMap((part: any) => part.content ?? []).filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('')
  else {
    const content = data.choices?.[0]?.message?.content
    text = typeof content === 'string' ? content : content?.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('')
  }
  if (!text?.trim()) throw new Error('模型未返回文本，请核对所选模型与输出上限')
  return text
}
