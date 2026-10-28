import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { cloudPayload, generateRecommendations } from './cloud'
import { createRecommender } from './recommender'
import { directoryProbe, parseDirectoryFacts, pathSuggestions } from './context'
import { defaultRecommendationSettings as defaults } from './settings'

const request = { sessionId: 'session-a', query: 'python main.py', cwd: '/work', history: [] }
const facts = { cwd: '/work', directories: ['/work/项目 a'], files: ['/work/main.py'], scripts: ['dev'], tools: ['python3'] }
const candidate = { command: 'python3 main.py', source: 'ai', priority: 2, uses: 0, lastUsed: 0 }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('cloud boundary', () => {
  it('limits history and excludes it by default, never serializing script bodies', () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ command: `echo ${i}`, uses: 1, lastUsed: i }))
    history.push({ command: 'export API_KEY=private-value', uses: 100, lastUsed: 99 })
    const query = { ...request, history }
    expect(JSON.parse(cloudPayload(query, facts, defaults).messages[1].content).history).toEqual([])
    const payload = JSON.parse(cloudPayload(query, facts, { ...defaults, shareHistory: true }).messages[1].content)
    expect(payload.history).toHaveLength(12)
    expect(JSON.stringify(payload)).not.toContain('private-value')
  })
  it('sends authenticated compatible JSON and rejects controls, duplicates and oversized answers', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [candidate, candidate, { command: 'echo hi\rshutdown' }] }) } }] })))
    vi.stubGlobal('fetch', fetch)
    expect(await generateRecommendations(request, facts, defaults, 'synthetic-key', new AbortController().signal)).toEqual([candidate])
    const [url, options] = fetch.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(options.headers.Authorization).toBe('Bearer synthetic-key')
    expect(options.redirect).toBe('error')
    expect(options.body).not.toContain('synthetic-key')
    fetch.mockResolvedValue(new Response('x'.repeat(65537)))
    await expect(generateRecommendations(request, facts, defaults, 'synthetic-key', new AbortController().signal)).rejects.toThrow('过大')
  })
  it('keeps provider error bodies and obvious secrets out of requests and UI errors', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private request echoed', { status: 401 }))
    vi.stubGlobal('fetch', fetch)
    await expect(generateRecommendations(request, undefined, defaults, 'fake', new AbortController().signal)).rejects.toThrow('HTTP 401')
    await expect(generateRecommendations({ ...request, query: 'export TOKEN=private-value' }, undefined, defaults, 'fake', new AbortController().signal)).rejects.toThrow('凭据')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('recommendation composition', () => {
  it('quotes verified paths, including Unicode and whitespace, for non-prefix completion', () => {
    expect(pathSuggestions('cd 项目', facts)[0].command).toBe("cd -- '/work/项目 a'")
    expect(pathSuggestions('cat main', facts)[0].command).toBe("cat -- '/work/main.py'")
    expect(pathSuggestions('rm main', facts)[0].command).toBe("rm '/work/main.py'")
  })
  it('caches context by session and cwd and routes explicit paths without cloud generation', async () => {
    const context = vi.fn().mockResolvedValue(facts)
    const generate = vi.fn().mockRejectedValue(new Error('云端推荐失败（HTTP 503）'))
    const run = createRecommender(async () => 'fake', { discover: vi.fn(async (_id, cwd) => ({ cwd, directories: [], files: [], scripts: [], tools: [] })), context, generate, key: async () => 'fake' })
    const publish = vi.fn()
    const progress = vi.fn()
    const settings = { ...defaults, cloud: true }
    expect(await run({ ...request, query: 'cd 项目' }, settings, new AbortController().signal, publish, progress)).toBe('')
    expect(progress.mock.calls).toEqual([['context']])
    expect(generate).not.toHaveBeenCalled()
    expect(publish.mock.calls[0][0][0].command).toContain('项目 a')
    progress.mockClear()
    expect(await run(request, settings, new AbortController().signal, publish, progress)).toContain('503')
    expect(progress.mock.calls).toEqual([['context'], ['ai']])
    expect(context).toHaveBeenCalledTimes(2)
    await run({ ...request, sessionId: 'b' }, settings, new AbortController().signal, publish)
    await run({ ...request, cwd: '/elsewhere' }, settings, new AbortController().signal, publish)
    expect(context).toHaveBeenCalledTimes(4)
  })
  it('cancels timed out work and ignores a late provider that disregards cancellation', async () => {
    vi.useFakeTimers()
    let resolve!: (items: typeof candidate[]) => void
    let providerSignal!: AbortSignal
    const run = createRecommender(async () => 'fake', { discover: vi.fn(), context: vi.fn().mockResolvedValue(facts), key: async () => 'fake',
      generate: (_request, _facts, _settings, _key, signal) => { providerSignal = signal; return new Promise(done => { resolve = done }) } })
    const publish = vi.fn()
    const result = run(request, { ...defaults, cloud: true, remoteContext: false }, new AbortController().signal, publish)
    await vi.advanceTimersByTimeAsync(8001)
    expect(providerSignal.aborted).toBe(true)
    resolve([candidate])
    expect(await result).toContain('超时')
    expect(publish).not.toHaveBeenCalled()
  })
})

const gitExecPath = process.platform === 'win32' ? execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim() : ''
const bash = process.env.SEAL_E2E_BASH ?? (gitExecPath ? resolve(gitExecPath, '../../../bin/bash.exe') : '/bin/bash')
it.skipIf(!existsSync(bash))('executes the bounded probe in a real shell with literal hostile directory names', () => {
  const root = mkdtempSync(join(tmpdir(), 'seal-recommendations-'))
  try {
    const cwd = join(root, "中文 a'b;$(touch sentinel)")
    mkdirSync(cwd); mkdirSync(join(cwd, 'project one'))
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { dev: 'PRIVATE-BODY' }, token: 'PRIVATE-TOKEN' }))
    writeFileSync(join(cwd, '.env'), 'SECRET=PRIVATE-ENV')
    const path = cwd.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'uname() { printf Linux; };\n' + directoryProbe(path)], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(result.status, result.stderr).toBe(0)
    const parsed = parseDirectoryFacts(result.stdout)
    expect(parsed.cwd).toBe(path)
    expect(parsed.directories).toContain(path + '/project one')
    expect(parsed.scripts).toEqual(['dev'])
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE')
    expect(result.stdout).not.toContain('PRIVATE-ENV')
    expect(existsSync(join(root, 'sentinel'))).toBe(false)
    expect(() => parseDirectoryFacts(result.stdout.slice(0, 20))).toThrow('未完成')
    const lookup = spawnSync(bash, ['--noprofile', '--norc', '-c', 'uname() { printf Linux; };\n' + directoryProbe(path, 'wc')], { encoding: 'utf8', timeout: 10000, windowsHide: true })
    expect(lookup.status, lookup.stderr).toBe(0)
    expect(parseDirectoryFacts(lookup.stdout).tools).toContain('wc')
    expect(() => directoryProbe(path, 'wc; touch sentinel')).toThrow('命令名称')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
