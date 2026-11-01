import { describe, expect, it } from 'vitest'
import { apiEndpoint, generatedText, generationBody } from './protocol'
import { defaultModelParameters, type ModelProtocol, type ResolvedModel } from './types'
const resolved = (protocol: ModelProtocol): ResolvedModel => ({
  protocol, service: { id: 'service', name: 'test', preset: 'openai', baseUrl: 'https://example.test/v1', protocol, proxy: { mode: 'direct' }, models: [] },
  model: { id: 'test-model', name: 'test', protocol: 'inherit', parameters: defaultModelParameters() },
})
describe('provider wire formats', () => {
  it.each([
    ['https://api.example', 'openai-chat', 'https://api.example/v1/chat/completions'],
    ['https://api.example/v1/chat/completions/', 'openai-responses', 'https://api.example/v1/responses'],
    ['https://api.example/anthropic/v1/messages', 'anthropic', 'https://api.example/anthropic/v1/messages'],
    ['http://127.0.0.1:9999/api/v3/', 'openai-chat', 'http://127.0.0.1:9999/api/v3/chat/completions'],
  ])('normalizes root, base and full API URLs: %s', (url, protocol, expected) => {
    expect(apiEndpoint(url, protocol as ModelProtocol, 'generate')).toBe(expected)
    expect(apiEndpoint(url, protocol as ModelProtocol, 'models')).toBe(expected.replace(/(?:chat\/completions|responses|messages)$/, 'models'))
  })
  it.each(['https://user:password@example.test/v1', 'https://example.test/v1?api_key=secret', 'ftp://example.test', 'not a URL'])('rejects ambiguous credential-bearing endpoints: %s', url => {
    expect(() => apiEndpoint(url, 'openai-chat', 'models')).toThrow()
  })
  it('uses each protocol fields and extracts text across reasoning and multiple text blocks', () => {
    expect(generationBody(resolved('openai-chat'), 'JSON only', 'hello', true)).toEqual({ model: 'test-model', stream: false, max_completion_tokens: 2048, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'JSON only' }, { role: 'user', content: 'hello' }] })
    expect(generationBody(resolved('openai-responses'), 'JSON only', 'hello', true)).toEqual({ model: 'test-model', stream: false, instructions: 'JSON only', input: 'hello', max_output_tokens: 2048, store: false, text: { format: { type: 'json_object' } } })
    const anthropic = resolved('anthropic'); anthropic.model.parameters.thinking = 'on'; anthropic.model.parameters.temperature = 0.2
    expect(generationBody(anthropic, 'system', 'hello')).toEqual({ model: 'test-model', stream: false, system: 'system', messages: [{ role: 'user', content: 'hello' }], max_tokens: 2048, thinking: { type: 'enabled', budget_tokens: 1024 } })
    expect(generatedText(JSON.stringify({ content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'OK' }] }), 'anthropic')).toBe('OK')
    expect(generatedText(JSON.stringify({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'one' }, { type: 'output_text', text: 'two' }] }] }), 'openai-responses')).toBe('onetwo')
    expect(() => generatedText('<html>login</html>', 'openai-chat')).toThrow('JSON')
    expect(() => generatedText('{"content":[{"type":"thinking","thinking":"only reasoning"}]}', 'anthropic')).toThrow('未返回文本')
  })
  it('rejects an invalid budget and respects vendor thinking controls', () => {
    const value = resolved('openai-chat'); value.service.preset = 'dashscope'; value.model.parameters.thinking = 'off'
    expect(generationBody(value, 'system', 'hello')).toHaveProperty('enable_thinking', false)
    value.model.parameters.contextWindow = 1024
    expect(() => generationBody(value, 'system', 'hello')).toThrow('最大输出')
    value.model.parameters.maxOutputTokens = 10
    expect(() => generationBody(value, 'system', '中'.repeat(1100))).toThrow('上下文预算')
  })
})
