import { afterEach, expect, it, vi } from 'vitest'
import { createRecommender } from './recommender'
import { generateRecommendations } from './cloud'
import { requestAI } from '../ai-http'
vi.mock('../ai-http', () => ({ requestAI: vi.fn() }))
import { defaultRecommendationSettings } from './settings'
import { recentRecommendationTraces } from './diagnostics'
import { findCommandSuggestions } from './model'

const facts = { cwd: '/work', directories: ['/work/codes'], files: ['/work/app.log'], tools: [], scripts: [] }
const settings = { ...defaultRecommendationSettings, cloud: true }
const request = { query: 'cd demolinux', cwd: '/work', sessionId: 'ai-flow', history: [] }
const response = (commands: string[]) => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: commands.map(command => ({ command })) }) } }] })
const create = () => {
  const context = vi.fn(async () => facts)
  const discover = vi.fn(async (_session: string, _cwd: string, _roots: string[], _fragment: string | undefined) => ({ ...facts, directories: ['/work/codes/demo_linux', '/work/codes/frontend'] }))
  return { context, discover, run: createRecommender(async () => 'synthetic-key', { context, discover, generate: generateRecommendations, key: async () => 'synthetic-key' }) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it.each(['http://127.0.0.1:11434/v1', 'https://model.example/v1'])('requests the configured API endpoint: %s', async baseUrl => {
  const fetch = vi.fn(async () => response(['mkdir build']))
  vi.mocked(requestAI).mockImplementation(fetch)
  const signal = new AbortController().signal
  const suggestions = await generateRecommendations({ query: 'mkdir build', cwd: '/work', history: [] }, facts,
    { ...settings, baseUrl }, 'synthetic-key', signal)
  expect(fetch).toHaveBeenCalledWith(`${baseUrl}/chat/completions`, expect.objectContaining({ model: settings.model }), 'synthetic-key', signal)
  expect(suggestions).toMatchObject([{ command: "mkdir '/work/build'", source: 'ai' }])
})

it('sends unfiltered nearby facts to the model without prior ls and validates the generated target', async () => {
  const fetch = vi.fn(async (_url: unknown, _body?: unknown) => response(['ls /work/codes/demo_linux', 'cd codes/demo_linux', 'cd /unverified']))
  vi.mocked(requestAI).mockImplementation(fetch)
  const { run, discover } = create(), publish = vi.fn()
  expect(await run(request, settings, new AbortController().signal, publish)).toBe('')
  expect(discover.mock.calls[0]?.[3]).toBeUndefined()
  expect(fetch).toHaveBeenCalledTimes(1)
  const payload = fetch.mock.calls[0]?.[1] as { messages: Array<{ content: string }> }
  expect(JSON.parse(payload.messages[1].content).facts.directories).toContain('/work/codes/demo_linux')
  expect(publish.mock.calls[0][0]).toMatchObject([{ command: "cd '/work/codes/demo_linux'", source: 'ai' }])
  const trace = recentRecommendationTraces().at(-1)!
  expect(trace).toMatchObject({ route: 'ai', modelCalled: true, sources: ['ai'], fallback: false, outcome: 'complete' })
  expect(JSON.stringify(trace)).not.toMatch(/demolinux|\/work|synthetic-key/)
})

it.each([
  ['cd 前端', 'cd /work/codes/frontend'],
  ['ls --group-directories-first demo', 'ls --group-directories-first /work/codes/demo_linux'],
  ['custom-cli --mode inspect project', 'custom-cli --mode inspect /work/codes/frontend'],
  ['查看项目目录', 'ls /work/codes/frontend'],
  ['mkdir build', 'mkdir build'],
])('does not require a local completion profile for AI: %s', async (query, command) => {
  const fetch = vi.fn(async () => response([command])); vi.mocked(requestAI).mockImplementation(fetch)
  const publish = vi.fn()
  await create().run({ ...request, query }, settings, new AbortController().signal, publish)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(findCommandSuggestions(query, [{ suggestions: () => publish.mock.calls[0][0] }])).toHaveLength(1)
})

it('still requests AI with context disabled, missing cwd, or a failed probe', async () => {
  const fetch = vi.fn(async () => response([])); vi.mocked(requestAI).mockImplementation(fetch)
  const { run, context } = create()
  await run(request, { ...settings, remoteContext: false }, new AbortController().signal, vi.fn())
  await run({ ...request, cwd: undefined }, settings, new AbortController().signal, vi.fn())
  context.mockRejectedValueOnce(new Error('unavailable'))
  await run(request, settings, new AbortController().signal, vi.fn())
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(recentRecommendationTraces().slice(-3).map(item => item.context)).toEqual(['disabled', 'missing-cwd', 'failed'])
})

it('uses local paths only with AI disabled or a failed request, not after deliberate model abstention', async () => {
  const fetch = vi.fn(async () => response([])); vi.mocked(requestAI).mockImplementation(fetch)
  const { run } = create(), publish = vi.fn()
  await run({ ...request, query: 'cat app' }, { ...settings, cloud: false }, new AbortController().signal, publish)
  expect(fetch).not.toHaveBeenCalled()
  expect(publish.mock.calls[0][0][0].source).toBe('directory')
  publish.mockClear()
  expect(await run({ ...request, query: 'cat app' }, settings, new AbortController().signal, publish)).toContain('AI 暂未')
  expect(publish.mock.calls[0][0]).toEqual([])
  publish.mockClear(); fetch.mockRejectedValueOnce(new Error('云端推荐失败（HTTP 503）'))
  expect(await run({ ...request, query: 'cat app' }, settings, new AbortController().signal, publish)).toContain('已提供本地目录建议')
  expect(publish.mock.calls[0][0][0].source).toBe('directory')
  expect(recentRecommendationTraces().at(-1)).toMatchObject({ modelCalled: true, fallback: true, outcome: 'failed' })
})

it('does not let an exhausted context budget consume the separate model deadline', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => response([])); vi.mocked(requestAI).mockImplementation(fetch)
  const context = vi.fn((_id: string, _cwd: string, signal: AbortSignal) => new Promise<typeof facts>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
  const run = createRecommender(async () => 'synthetic-key', { context, discover: vi.fn(), generate: generateRecommendations, key: async () => 'synthetic-key' })
  const pending = run(request, settings, new AbortController().signal, vi.fn())
  await vi.advanceTimersByTimeAsync(6001)
  expect(await pending).toContain('AI 暂未')
  expect(fetch).toHaveBeenCalledTimes(1)
})
