export interface RecommendationSettings {
  cloud: boolean
  automatic: boolean
  remoteContext: boolean
  shareHistory: boolean
  baseUrl: string
  model: string
}

export const defaultRecommendationSettings: RecommendationSettings = {
  cloud: false, automatic: true, remoteContext: true, shareHistory: false,
  baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash',
}

export function validateRecommendationSettings(settings: RecommendationSettings): void {
  let url: URL
  try { url = new URL(settings.baseUrl) } catch { throw new Error('请输入有效的 API 地址') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址须为不含凭据、查询参数的 HTTP 或 HTTPS 地址')
  if (!settings.model.trim()) throw new Error('请输入模型名称')
}
