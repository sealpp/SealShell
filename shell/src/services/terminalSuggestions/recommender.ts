import { pathSuggestions, probeDirectory, type DirectoryFacts } from './context'
import { generateRecommendations, type RecommendationQuery } from './cloud'
import type { CommandSuggestion, RecommendationActivity } from './model'
import type { RecommendationSettings } from './settings'
import { hasPathCommand, parsePathCommand, resolvePath, searchDirectory } from './paths'

export interface RecommendationRequest extends RecommendationQuery { sessionId: string }
interface RecommendationPorts {
  context: typeof probeDirectory
  generate: typeof generateRecommendations
  key(): Promise<string>
}

/** Per-terminal context cache; cancellation owns only the background connection. */
export function createRecommender(key: () => Promise<string>, ports: RecommendationPorts = { context: probeDirectory, generate: generateRecommendations, key }) {
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
    setSession(request.sessionId)
    const pathCommand = hasPathCommand(request.query), input = parsePathCommand(request.query)
    if (pathCommand && (!input || !settings.remoteContext || !request.cwd)) return ''
    const abort = new AbortController()
    const cancel = () => abort.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const deadline = setTimeout(() => abort.abort(new Error('推荐超时，请重试')), 8000)
    let facts: DirectoryFacts | undefined
    let contextError = false
    async function read(directory: string): Promise<DirectoryFacts> {
      const key = `${request.sessionId}\0${directory}`, hit = cache.get(key)
      if (hit && Date.now() - hit.time < 30_000) return hit.facts
      progress?.('context')
      const result = await ports.context(request.sessionId, directory, abort.signal)
      abort.signal.throwIfAborted()
      cache.set(key, { time: Date.now(), facts: result })
      if (cache.size > 6) cache.delete(cache.keys().next().value!)
      return result
    }
    try {
      if (settings.remoteContext && request.cwd) {
        try { facts = await read(request.cwd) }
        catch { contextError = true; abort.signal.throwIfAborted() }
        if (facts && input) {
          const explicit = searchDirectory(input, request.cwd, facts.home)
          const directory = explicit ?? (recent?.sessionId === request.sessionId && recent.cwd === request.cwd ? recent.directory : undefined)
          if (directory && directory !== request.cwd) {
            try {
              const extra = await read(directory)
              facts = { ...facts, directories: [...new Set([...facts.directories, extra.cwd, ...extra.directories])],
                files: [...new Set([...facts.files, ...extra.files])] }
            } catch { if (explicit) contextError = true; abort.signal.throwIfAborted() }
          }
        }
        if (facts) publish(pathSuggestions(request.query, facts))
      }
      if (settings.cloud && !pathCommand) {
        const apiKey = await ports.key()
        abort.signal.throwIfAborted()
        progress?.('ai')
        const candidates = await ports.generate(request, facts, settings, apiKey, abort.signal)
        abort.signal.throwIfAborted()
        publish(candidates)
      }
      return contextError ? '目录读取暂不可用' : ''
    } catch (error) {
      if (signal.aborted) throw error
      if (abort.signal.aborted) return '推荐超时，请重试'
      return error instanceof Error && !/fetch|network|load failed/i.test(error.message) ? error.message : '云端暂不可用，请检查网络及 API 配置'
    } finally { clearTimeout(deadline); signal.removeEventListener('abort', cancel) }
  }
  return Object.assign(run, { observeCommand })
}
