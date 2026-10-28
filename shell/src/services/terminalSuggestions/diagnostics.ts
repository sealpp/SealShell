export interface RecommendationTrace {
  id: number
  sessionId: string
  route: 'ai' | 'local'
  context: 'disabled' | 'missing-cwd' | 'skipped' | 'loading' | 'ready' | 'partial' | 'failed'
  directories: number
  files: number
  modelCalled: boolean
  sources: string[]
  candidates: number
  fallback: boolean
  outcome: 'running' | 'complete' | 'empty' | 'failed' | 'cancelled'
}

let sequence = 0
const recent: RecommendationTrace[] = []

/** Current-page metadata only: no commands, paths, model bodies, credentials or persistence. */
export function beginRecommendationTrace(sessionId: string, cloud: boolean, context: RecommendationTrace['context']): RecommendationTrace {
  const trace: RecommendationTrace = { id: ++sequence, sessionId, route: cloud ? 'ai' : 'local', context,
    directories: 0, files: 0, modelCalled: false, sources: [], candidates: 0, fallback: false, outcome: 'running' }
  recent.push(trace)
  if (recent.length > 20) recent.shift()
  return trace
}

export function recentRecommendationTraces(): RecommendationTrace[] {
  return recent.map(trace => ({ ...trace, sources: [...trace.sources] }))
}
