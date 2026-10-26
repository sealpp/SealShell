import { pathSuggestions, probeDirectory, type DirectoryFacts } from './context'
import { generateRecommendations, type RecommendationQuery } from './cloud'
import type { CommandSuggestion } from './model'
import type { RecommendationSettings } from './settings'

export interface RecommendationRequest extends RecommendationQuery { sessionId: string }
interface RecommendationPorts {
  context: typeof probeDirectory
  generate: typeof generateRecommendations
  key(): Promise<string>
}

/** Per-terminal context cache; cancellation owns only the background connection. */
export function createRecommender(key: () => Promise<string>, ports: RecommendationPorts = { context: probeDirectory, generate: generateRecommendations, key }) {
  let cache: { key: string; time: number; facts: DirectoryFacts } | undefined
  return async (request: RecommendationRequest, settings: RecommendationSettings, signal: AbortSignal,
    publish: (items: CommandSuggestion[]) => void): Promise<string> => {
    const abort = new AbortController()
    const cancel = () => abort.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    const deadline = setTimeout(() => abort.abort(new Error('推荐超时，请重试')), 8000)
    let facts: DirectoryFacts | undefined
    let contextError = false
    try {
      if (settings.remoteContext && request.cwd) {
        const contextKey = `${request.sessionId}\0${request.cwd}`
        if (cache?.key === contextKey && Date.now() - cache.time < 30_000) facts = cache.facts
        else {
          try {
            facts = await ports.context(request.sessionId, request.cwd, abort.signal)
            abort.signal.throwIfAborted()
            cache = { key: contextKey, time: Date.now(), facts }
          } catch { contextError = true; abort.signal.throwIfAborted() }
        }
        if (facts && request.mode === 'command') publish(pathSuggestions(request.query, facts))
      }
      if (settings.cloud) {
        const apiKey = await ports.key()
        abort.signal.throwIfAborted()
        const candidates = await ports.generate(request, facts, settings, apiKey, abort.signal)
        abort.signal.throwIfAborted()
        publish(candidates)
      }
      return contextError ? '目录探测暂不可用，已使用其他来源' : settings.cloud || request.mode === 'command' ? '' : '云端未启用；可在命令提示设置中配置'
    } catch (error) {
      if (signal.aborted) throw error
      if (abort.signal.aborted) return '推荐超时，请重试'
      return error instanceof Error && !/fetch|network|load failed/i.test(error.message) ? error.message : '云端暂不可用，请检查网络及 API 配置'
    } finally { clearTimeout(deadline); signal.removeEventListener('abort', cancel) }
  }
}
