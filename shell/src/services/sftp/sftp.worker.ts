import { createLibssh2SftpBackend } from './libssh2-backend'
import { isSftpRequest, responseError, transferablesForEvent, transferablesForResponse } from './worker-protocol'
import type { SftpBackend, SftpRequest, SftpResponse } from './types'
import type { FileReader, FileWriter } from '../files/types'

const scope = globalThis as unknown as { onmessage?: (event: MessageEvent) => void; postMessage?: (message: unknown, transfer?: Transferable[]) => void }
let hostKeyWaiter: { resolve: (accepted: boolean) => void } | undefined
let backend: SftpBackend = createLibssh2SftpBackend(async (publicKey) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey.slice().buffer as ArrayBuffer))
  let binary = ''
  for (let offset = 0; offset < digest.length; offset += 0x8000) binary += String.fromCharCode(...digest.subarray(offset, offset + 0x8000))
  const fingerprint = `SHA256:${btoa(binary).replace(/=+$/g, '')}`
  const payload = publicKey.slice().buffer
  scope.postMessage?.({ version: 1, type: 'hostKey', publicKey: payload, fingerprint }, transferablesForEvent({ type: 'hostKey', publicKey: payload }))
  return new Promise<boolean>((resolve) => { hostKeyWaiter = { resolve } })
})
const handles = new Map<string, FileReader | FileWriter>()
let operations = Promise.resolve()

export function installSftpWorkerBackend(next: SftpBackend): void {
  backend = next
}

async function handle(request: SftpRequest): Promise<SftpResponse> {
  try {
    switch (request.type) {
      case 'connect': await backend.connect(request.options); return { version: 1, id: request.id, ok: true, type: 'connected' }
      case 'disconnect':
        try { await backend.disconnect() } finally { handles.clear() }
        return { version: 1, id: request.id, ok: true, type: 'disconnected' }
      case 'list': return { version: 1, id: request.id, ok: true, type: 'list', result: await backend.list(request.path, request.cursor) }
      case 'stat': return { version: 1, id: request.id, ok: true, type: 'stat', result: await backend.stat(request.path) }
      case 'read': return { version: 1, id: request.id, ok: true, type: 'read', result: await backend.read(request.path, request.offset, request.length) }
      case 'write': await backend.write(request.path, request.payload, request.offset); return { version: 1, id: request.id, ok: true, type: 'write' }
      case 'openReader':
      case 'openWriter': {
        const open: ((path: string) => Promise<FileReader | FileWriter>) | undefined = request.type === 'openReader' ? backend.openReader : backend.openWriter
        if (!open) throw new Error('SFTP backend does not support file handles')
        handles.set(request.id, await open.call(backend, request.path))
        return { version: 1, id: request.id, ok: true, type: 'opened', result: request.id }
      }
      case 'readHandle': {
        const file = handles.get(request.handle)
        if (!file || !('read' in file)) throw new Error('SFTP reader is closed')
        return { version: 1, id: request.id, ok: true, type: 'read', result: await file.read(request.offset, request.length) }
      }
      case 'writeHandle': {
        const file = handles.get(request.handle)
        if (!file || !('write' in file)) throw new Error('SFTP writer is closed')
        await file.write(request.offset, request.payload)
        return { version: 1, id: request.id, ok: true, type: 'write' }
      }
      case 'closeHandle': {
        const file = handles.get(request.handle)
        if (file) {
          try { await file.close() } finally { handles.delete(request.handle) }
        }
        return { version: 1, id: request.id, ok: true, type: 'closed' }
      }
      case 'mkdir': await backend.mkdir(request.path); return { version: 1, id: request.id, ok: true, type: 'mkdir' }
      case 'remove': await backend.remove(request.path, request.recursive); return { version: 1, id: request.id, ok: true, type: 'remove' }
      case 'rename': return { version: 1, id: request.id, ok: true, type: 'rename', result: await backend.rename(request.source, request.target, request.overwrite) }
      case 'chmod': await backend.chmod?.(request.path, request.mode); return { version: 1, id: request.id, ok: true, type: 'chmod' }
      case 'utimes': await backend.utimes?.(request.path, request.modifiedAt); return { version: 1, id: request.id, ok: true, type: 'utimes' }
      case 'readlink': return { version: 1, id: request.id, ok: true, type: 'readlink', result: await backend.readlink?.(request.path) ?? '' }
      case 'symlink': await backend.symlink?.(request.target, request.path); return { version: 1, id: request.id, ok: true, type: 'symlink' }
    }
  } catch (error) {
    return responseError(request.id, error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : 'SFTP_ERROR', error instanceof Error ? error.message : String(error))
  }
}

if (typeof scope.postMessage === 'function') {
  scope.onmessage = (event) => {
    if (event.data?.type === 'hostKeyDecision') {
      hostKeyWaiter?.resolve(Boolean(event.data.accepted))
      hostKeyWaiter = undefined
      return
    }
    if (!isSftpRequest(event.data)) return
    const request = event.data
    // libssh2's nonblocking operation state belongs to the session. Finish one
    // operation before starting another, including file closes and disconnect.
    operations = operations.then(async () => {
      const response = await handle(request)
      scope.postMessage?.(response, transferablesForResponse(response))
    })
  }
}
