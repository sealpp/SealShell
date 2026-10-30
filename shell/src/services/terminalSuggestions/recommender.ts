import { probeDirectory, probeNearbyPaths, type DirectoryFacts } from './context'
import { generateRecommendations, type RecommendationQuery } from './cloud'
import type { CommandSuggestion, RecommendationActivity } from './model'
import type { RecommendationSettings } from './settings'
import { parsePathCommand, resolvePath, searchDirectory, parentPath } from './paths'
import { beginRecommendationTrace } from './diagnostics'

export interface RecommendationRequest extends RecommendationQuery { sessionId: string }
interface RecommendationPorts {
  context: typeof probeDirectory
  discover: typeof probeNearbyPaths
  generate: typeof generateRecommendations
  key(): Promise<string>
}

async function timed<T>(signal: AbortSignal, milliseconds: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController()
  const cancel = () => abort.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const deadline = setTimeout(() => abort.abort(new Error('推荐超时，请重试')), milliseconds)
  try {
    abort.signal.throwIfAborted()
    const value = await operation(abort.signal)
    abort.signal.throwIfAborted()
    return value
  } finally { clearTimeout(deadline); signal.removeEventListener('abort', cancel) }
}

/** Per-terminal facts; AI generation is selected by settings, never by the local path parser. */
export function createRecommender(key: () => Promise<string>, ports: RecommendationPorts = { context: probeDirectory, discover: probeNearbyPaths, generate: generateRecommendations, key }) {
  const cache = new Map<string, { time: number; facts: DirectoryFacts }>()
  let recent: { sessionId: string; cwd: string; directory: string } | undefined
  let sessionId = ''
  function setSession(id: string) {
    if (sessionId !== id) { cache.clear(); recent = undefined; sessionId = id }
  }
  function observeCommand(command: string, id: string, cwd?: string) {
    setSession(id)
    cache.clear()
    const input = parsePathCommand(command)
    if (!cwd || !input?.closed || !['cd', 'ls'].includes(input.verb) || !input.fragment || input.home) return
    const directory = resolvePath(input.fragment, cwd)
    if (directory) recent = { sessionId: id, cwd, directory }
  }
  const run = async (request: RecommendationRequest, settings: RecommendationSettings, signal: AbortSignal,
    publish: (items: CommandSuggestion[]) => void, progress?: (activity: RecommendationActivity) => void): Promise<string> => {
    if (!settings.cloud) return ''
    setSession(request.sessionId)
    const input = parsePathCommand(request.query)
    const trace = beginRecommendationTrace(request.sessionId,
      !settings.remoteContext ? 'disabled' : !request.cwd ? 'missing-cwd' : 'loading')
    let facts: DirectoryFacts | undefined, contextError = false
    const publishResult = (items: CommandSuggestion[]) => {
      signal.throwIfAborted()
      trace.sources = [...new Set(items.map(item => item.source))]; trace.candidates = items.length
      publish(items)
    }
    const merge = (extra: DirectoryFacts) => {
      if (!facts) { facts = extra; return }
      facts = { ...facts, directories: [...new Set([...facts.directories, ...extra.directories])],
        files: [...new Set([...facts.files, ...extra.files])], limited: facts.limited || extra.limited }
    }
    async function cached(key: string, operation: () => Promise<DirectoryFacts>, signal: AbortSignal): Promise<DirectoryFacts> {
      const hit = cache.get(key)
      if (hit && Date.now() - hit.time < 30_000) return hit.facts
      progress?.('context')
      const result = await operation()
      signal.throwIfAborted()
      cache.set(key, { time: Date.now(), facts: result })
      if (cache.size > 6) cache.delete(cache.keys().next().value!)
      return result
    }
    try {
      if (settings.remoteContext && request.cwd) {
        try {
          await timed(signal, 6000, async contextSignal => {
            const cwd = request.cwd!
            const executable = input?.evidence === 'context' ? input.verb : undefined
            const read = (directory: string) => cached(`${request.sessionId}\0${directory}\0${executable ?? ''}`,
              () => ports.context(request.sessionId, directory, contextSignal, executable), contextSignal)
            facts = await read(cwd)
            const explicit = input && searchDirectory(input, cwd, facts.home)
            const directory = explicit ?? (recent?.sessionId === request.sessionId && recent.cwd === cwd ? recent.directory : undefined)
            if (directory && directory !== cwd) {
              try { const extra = await read(directory); merge({ ...extra, directories: [extra.cwd, ...extra.directories] }) }
              catch { if (explicit) contextError = true; contextSignal.throwIfAborted() }
            }
            if (!explicit) {
              const children = facts!.directories.filter(path => parentPath(path) === cwd)
              const peers = facts!.directories.filter(path => path !== cwd && parentPath(path) === parentPath(cwd))
              const roots = [...new Set([...children.slice(0, 6), ...peers.slice(0, 6)])]
              const limited = children.length > 6 || peers.length > 6
              if (roots.length) merge(await cached(`${request.sessionId}\0tree\0${cwd}\0${roots.join('\0')}`,
                () => ports.discover(request.sessionId, cwd, roots, contextSignal), contextSignal))
              if (limited) facts = { ...facts!, limited: true }
            }
          })
          trace.context = contextError || facts?.limited ? 'partial' : 'ready'
        } catch { signal.throwIfAborted(); contextError = true; trace.context = facts ? 'partial' : 'failed' }
      }
      trace.directories = facts?.directories.length ?? 0; trace.files = facts?.files.length ?? 0
      try {
        const candidates = await timed(signal, 8000, async modelSignal => {
          const apiKey = await ports.key()
          modelSignal.throwIfAborted()
          progress?.('ai')
          return ports.generate(request, facts, settings, apiKey, modelSignal, () => { trace.modelCalled = true })
        })
        publishResult(candidates)
        trace.outcome = candidates.length ? 'complete' : 'empty'
        return candidates.length ? '' : 'AI 暂未找到匹配建议'
      } catch (error) {
        signal.throwIfAborted()
        trace.outcome = 'failed'
        return error instanceof Error && !/fetch|network|load failed/i.test(error.message) ? error.message : '云端暂不可用，请检查网络及 API 配置'
      }
    } catch (error) { trace.outcome = 'cancelled'; throw error }
  }
  return Object.assign(run, { observeCommand })
}
