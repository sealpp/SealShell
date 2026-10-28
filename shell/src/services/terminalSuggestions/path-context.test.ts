import { describe, expect, it, vi } from 'vitest'
import { createRecommender } from './recommender'
import { defaultRecommendationSettings as defaults } from './settings'
import type { DirectoryFacts } from './context'

const root: DirectoryFacts = { cwd: '/work', home: '/home/dev', directories: ['/work/codes'], files: [], scripts: [], tools: [] }
const project: DirectoryFacts = { ...root, cwd: '/work/codes', directories: ['/work/codes/demo_linux'], files: ['/work/codes/app.log'] }
const request = { sessionId: 'one', cwd: '/work', query: 'cd demolinux', history: [] }
const settings = { ...defaults, cloud: true }
const noNearby = async (_id: string, cwd: string): Promise<DirectoryFacts> => ({ cwd, directories: [], files: [], scripts: [], tools: [] })

describe('verified path discovery', () => {
  it('discovers an unlisted executable without running it, then completes from filesystem evidence', async () => {
    const context = vi.fn(async (_id: string, directory: string, _signal: AbortSignal, executable?: string) => ({
      ...root, cwd: directory, files: ['/work/app.log'], tools: executable === 'custom-cli' ? ['custom-cli'] : [],
    }))
    const generate = vi.fn(), key = vi.fn()
    const run = createRecommender(key, { discover: noNearby, context, generate, key }), publish = vi.fn()
    await run({ ...request, query: 'custom-cli app.lgo' }, settings, new AbortController().signal, publish)
    expect(context.mock.calls[0][3]).toBe('custom-cli')
    expect(publish.mock.calls[0][0][0].command).toBe("custom-cli '/work/app.log'")
    expect(generate).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled()
    await run({ ...request, query: 'custom-cli app' }, settings, new AbortController().signal, vi.fn())
    expect(context).toHaveBeenCalledTimes(1)
  })
  it('follows a recent listing with one bounded lookup and reuses its facts across commands', async () => {
    const context = vi.fn(async (_id: string, directory: string) => directory === '/work/codes' ? project : root)
    const generate = vi.fn(), key = vi.fn()
    const run = createRecommender(key, { discover: noNearby, context, generate, key })
    run.observeCommand('ls codes/', 'one', '/work')
    const publish = vi.fn()
    await run(request, settings, new AbortController().signal, publish)
    expect(context.mock.calls.map(call => call[1])).toEqual(['/work', '/work/codes'])
    expect(publish.mock.calls[0][0].map((item: { command: string }) => item.command)).toEqual(["cd -- '/work/codes/demo_linux'"])
    publish.mockClear()
    await run({ ...request, query: 'ls demolinux' }, settings, new AbortController().signal, publish)
    expect(publish.mock.calls[0][0][0].command).toBe("ls -- '/work/codes/demo_linux'")
    expect(context).toHaveBeenCalledTimes(2)
    expect(generate).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled()
  })
  it('explicit path parents take precedence over a recent listing and preserve option values', async () => {
    const context = vi.fn(async (_id: string, directory: string) => directory === '/work/logs'
      ? { ...root, cwd: directory, directories: [], files: ['/work/logs/app.log'] } : root)
    const run = createRecommender(async () => '', { discover: noNearby, context, generate: vi.fn(), key: vi.fn() })
    run.observeCommand('ls codes/', 'one', '/work')
    const publish = vi.fn()
    await run({ ...request, query: 'tail -n 20 -f logs/app.lgo' }, settings, new AbortController().signal, publish)
    expect(context.mock.calls.map(call => call[1])).toEqual(['/work', '/work/logs'])
    expect(publish.mock.calls[0][0][0].command).toBe("tail -n 20 -f -- '/work/logs/app.log'")
  })
  it('resolves home from remote facts, not the browser machine', async () => {
    const context = vi.fn(async (_id: string, directory: string) => directory === '/home/dev'
      ? { ...root, cwd: directory, directories: ['/home/dev/projects'] } : root)
    const run = createRecommender(async () => '', { discover: noNearby, context, generate: vi.fn(), key: vi.fn() })
    const publish = vi.fn()
    await run({ ...request, query: 'cd ~/proj' }, settings, new AbortController().signal, publish)
    expect(publish.mock.calls[0][0][0].command).toBe("cd -- '/home/dev/projects'")
  })
  it('does not reuse a recent directory across sessions or cwd, or derive it from shell expressions', async () => {
    const context = vi.fn().mockResolvedValue(root)
    const run = createRecommender(async () => '', { discover: noNearby, context, generate: vi.fn(), key: vi.fn() })
    run.observeCommand('ls codes/', 'one', '/work')
    await run({ ...request, sessionId: 'two' }, settings, new AbortController().signal, vi.fn())
    await run(request, settings, new AbortController().signal, vi.fn())
    run.observeCommand('ls codes/', 'one', '/elsewhere')
    await run(request, settings, new AbortController().signal, vi.fn())
    run.observeCommand('ls $(pwd)', 'one', '/work')
    await run(request, settings, new AbortController().signal, vi.fn())
    expect(context.mock.calls.every(call => call[1] === '/work')).toBe(true)
  })
  it('does not send explicit paths to the model when probing is disabled or input is unsupported', async () => {
    const context = vi.fn(), generate = vi.fn(), key = vi.fn()
    const run = createRecommender(key, { discover: noNearby, context, generate, key })
    await run(request, { ...settings, remoteContext: false }, new AbortController().signal, vi.fn())
    await run({ ...request, query: 'ls *.log' }, settings, new AbortController().signal, vi.fn())
    expect(context).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled()
  })
  it('treats a recent input only as a clue, retaining current facts if it is not a directory', async () => {
    const context = vi.fn().mockResolvedValueOnce(root).mockRejectedValueOnce(new Error('not a directory'))
    const run = createRecommender(async () => '', { discover: noNearby, context, generate: vi.fn(), key: vi.fn() })
    run.observeCommand('ls file.txt', 'one', '/work')
    const publish = vi.fn()
    expect(await run({ ...request, query: 'cd cod' }, settings, new AbortController().signal, publish)).toBe('')
    expect(publish.mock.calls[0][0][0].command).toBe("cd -- '/work/codes'")
  })
  it('discards a cancelled supplemental probe and never publishes its stale paths', async () => {
    let release!: (facts: DirectoryFacts) => void
    const context = vi.fn().mockResolvedValueOnce(root).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const run = createRecommender(async () => '', { discover: noNearby, context, generate: vi.fn(), key: vi.fn() })
    run.observeCommand('ls codes/', 'one', '/work')
    const abort = new AbortController(), publish = vi.fn()
    const result = run(request, settings, abort.signal, publish)
    await vi.waitFor(() => expect(context).toHaveBeenCalledTimes(2))
    abort.abort(); release(project)
    await expect(result).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
})
