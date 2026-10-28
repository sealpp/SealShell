import { expect, it, vi } from 'vitest'
import { createRecommender } from './recommender'
import { defaultRecommendationSettings } from './settings'
import { pathSuggestions, nearbyPathProbe, parseDirectoryFacts } from './context'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const facts = { cwd: '/work/home', directories: ['/work/home/demo', '/work/data'], files: [], scripts: [], tools: [] }
const settings = { ...defaultRecommendationSettings, cloud: true }
const request = { query: 'cd abdemo', cwd: facts.cwd, sessionId: 'one', history: [{ command: 'cd /archive/abdemo', uses: 100, lastUsed: 1 }] }

it('discovers a nearby exact target before publishing, ignores history and isolates session facts', async () => {
  const context = vi.fn(async () => facts)
  const discover = vi.fn(async (session: string, cwd: string) => ({ ...facts, cwd, directories: session === 'one' ? ['/work/data/abdemo'] : [] }))
  const generate = vi.fn(), key = vi.fn(), publish = vi.fn()
  const run = createRecommender(key, { context, discover, generate, key })
  await run(request, settings, new AbortController().signal, publish)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish.mock.calls[0][0]).toMatchObject([{ command: "cd -- '/work/data/abdemo'", source: 'directory' }])
  await run(request, settings, new AbortController().signal, vi.fn())
  expect(discover).toHaveBeenCalledTimes(1)
  publish.mockClear()
  await run({ ...request, sessionId: 'two' }, settings, new AbortController().signal, publish)
  expect(discover).toHaveBeenCalledTimes(2)
  expect(publish.mock.calls[0][0]).toEqual([])
  expect(generate).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled()
})

it('keeps a current exact operand and an explicit parent out of nearby discovery', async () => {
  const discover = vi.fn(), context = vi.fn(async () => ({ ...facts, directories: [...facts.directories, '/work/home/abdemo'] }))
  const run = createRecommender(vi.fn(), { context, discover, generate: vi.fn(), key: vi.fn() })
  for (const query of ['cd abdemo', 'cd ./abdemo']) {
    const publish = vi.fn()
    await run({ ...request, query }, settings, new AbortController().signal, publish)
    expect(publish.mock.calls[0][0][0].command).toBe("cd -- '/work/home/abdemo'")
  }
  expect(discover).not.toHaveBeenCalled()
})

it('does not turn two missing characters in a short name into a different directory', () => {
  expect(pathSuggestions('cd abdemo', facts)).toEqual([])
  expect(pathSuggestions('cd dmeo', facts)[0]?.command).toBe("cd -- '/work/home/demo'")
})

it('discards late discovery after cancellation and reports an incomplete lookup', async () => {
  let release!: (value: typeof facts) => void
  const discover = vi.fn(() => new Promise<typeof facts>(resolve => { release = resolve }))
  const run = createRecommender(vi.fn(), { context: vi.fn(async () => facts), discover, generate: vi.fn(), key: vi.fn() })
  const abort = new AbortController(), publish = vi.fn()
  const pending = run(request, settings, abort.signal, publish)
  await vi.waitFor(() => expect(discover).toHaveBeenCalled())
  abort.abort(); release({ ...facts, directories: ['/work/data/abdemo'] })
  await expect(pending).rejects.toThrow()
  expect(publish).not.toHaveBeenCalled()
  discover.mockRejectedValueOnce(new Error('unavailable'))
  expect(await run(request, settings, new AbortController().signal, vi.fn())).toBe('附近路径查找暂不可用')
})

const gitExec = process.platform === 'win32' ? execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim() : ''
const bash = process.env.SEAL_E2E_BASH ?? (gitExec ? resolve(gitExec, '../../../bin/bash.exe') : '/bin/bash')
it.skipIf(!existsSync(bash))('uses real bounded shell lookups, prioritizing exact names and quoting literal prefixes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'seal-nearby-'))
  try {
    const cwd = join(fixture, 'home'), peer = join(fixture, 'data')
    mkdirSync(cwd); mkdirSync(peer); mkdirSync(join(peer, 'abdemo'))
    mkdirSync(join(peer, "odd'$(touch sentinel)"))
    mkdirSync(join(peer, 'hidden', 'abdemo'), { recursive: true })
    for (let i = 0; i < 70; i++) mkdirSync(join(cwd, `abdemo-${i}`))
    const path = (value: string) => value.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    const read = (fragment: string) => {
      const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'uname() { printf Linux; };\n' + nearbyPathProbe(path(cwd), [path(cwd), path(peer)], fragment)],
        { cwd: fixture, encoding: 'utf8', timeout: 10000, windowsHide: true })
      expect(result.status, result.stderr).toBe(0)
      return parseDirectoryFacts(result.stdout)
    }
    const found = read('abdemo')
    expect(found.directories[0]).toBe(path(peer) + '/abdemo')
    expect(found.directories).toHaveLength(64)
    expect(found.limited).toBe(true)
    expect(found.directories).not.toContain(path(peer) + '/hidden/abdemo')
    expect(read("odd'$(touch sentinel)").directories).toEqual([path(peer) + "/odd'$(touch sentinel)"])
    expect(existsSync(join(fixture, 'sentinel'))).toBe(false)
    expect(() => nearbyPathProbe(path(cwd), ['/unrelated/deep/root'], 'abdemo')).toThrow('范围')
  } finally { rmSync(fixture, { recursive: true, force: true }) }
})
