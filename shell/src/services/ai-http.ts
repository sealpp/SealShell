import { nativeCall } from '../native/bridge'

export async function requestAI(url: string, body: unknown, apiKey: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const id = crypto.randomUUID()
  const abort = () => { void nativeCall('http_cancel', { id }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    const response = await nativeCall<string>('http_request', { id, url, body, apiKey })
    signal.throwIfAborted()
    return response
  } finally { signal.removeEventListener('abort', abort) }
}
