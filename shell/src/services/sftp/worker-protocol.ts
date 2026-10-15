import type { SftpRequest, SftpResponse } from './types'

export function isSftpRequest(value: unknown): value is SftpRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<SftpRequest>
  return request.version === 1 && typeof request.id === 'string' && typeof request.type === 'string'
}

export function responseError(id: string, code: string, message: string): SftpResponse {
  return { version: 1, id, ok: false, error: { code, message } }
}

export function transferablesForRequest(request: SftpRequest): Transferable[] {
  return request.type === 'write' || request.type === 'writeHandle' ? [request.payload] : []
}

export function transferablesForResponse(response: SftpResponse): Transferable[] {
  return response.ok && response.type === 'read' ? [response.result] : []
}

export function transferablesForEvent(event: { type: string; publicKey?: ArrayBuffer }): Transferable[] {
  return event.type === 'hostKey' && event.publicKey ? [event.publicKey] : []
}
