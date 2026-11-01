import { nativeCall } from '../native/bridge'
import type { ModelProtocol, ModelProxy } from './modelServices/types'

export interface AIHttpOptions {
  method?: 'GET' | 'POST'
  protocol?: ModelProtocol
  credentialId?: string
  proxy?: ModelProxy
  timeoutMs?: number
  query?: Record<string, string>
  diagnostic?: boolean
}
export async function requestAI(url: string, body: unknown, apiKey: string, signal: AbortSignal, options?: AIHttpOptions): Promise<string> {
  signal.throwIfAborted()
  const id = crypto.randomUUID()
  const abort = () => { void nativeCall('http_cancel', { id }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await nativeCall<string>('http_request', { id, url, body, apiKey, ...options })
    signal.throwIfAborted()
    return response
  } finally { signal.removeEventListener('abort', abort) }
}
