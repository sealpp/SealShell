import { Libssh2Error, Libssh2Session } from './libssh2-runtime'
import type { ProxyConnection } from '../transport/types'

type ConnectRequest = {
  type: 'connect'
  options: { host: string; port: number; username: string; password: string; proxy?: ProxyConnection; columns?: number; rows?: number; knownHostKey?: ArrayBuffer }
}

type Request = ConnectRequest | { type: 'hostKeyDecision'; accepted: boolean } | { type: 'input'; payload: ArrayBuffer } | { type: 'resize'; columns: number; rows: number } | { type: 'exec'; id: string; command: string } | { type: 'close' }

const scope = globalThis as unknown as { onmessage?: (event: MessageEvent<Request>) => void; postMessage?: (value: unknown, transfer?: Transferable[]) => void }
let session: Libssh2Session | undefined
let outputTimer: ReturnType<typeof setInterval> | undefined
let hostKeyDecision: { resolve: (accepted: boolean) => void } | undefined

function post(value: unknown, transfer: Transferable[] = []): void {
  scope.postMessage?.(value, transfer)
}

function bytesToBase64(bytes: Uint8Array): string {
  let result = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) result += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  return btoa(result)
}

async function fingerprint(publicKey: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicKey.slice().buffer as ArrayBuffer))
  return `SHA256:${bytesToBase64(digest).replace(/=+$/g, '')}`
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function emitError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  const explicitCode = error instanceof Error && 'code' in error ? String((error as Error & { code?: unknown }).code) : ''
  const code = explicitCode || (error instanceof Libssh2Error
    ? error.code === -18 ? 'AUTHENTICATION_FAILED' : error.code === -13 ? 'DISCONNECTED' : 'SSH_ERROR'
    : 'SSH_ERROR')
  post({ type: 'error', code, message })
}

scope.onmessage = (event) => {
  const request = event.data
  void (async () => {
    try {
      if (request.type === 'connect') {
        if (session) return
        post({ type: 'state', state: 'connecting' })
        session = new Libssh2Session()
        const known = request.options.knownHostKey ? new Uint8Array(request.options.knownHostKey) : undefined
        await session.connect({
          host: request.options.host,
          port: request.options.port,
          username: request.options.username,
          password: request.options.password,
          proxy: request.options.proxy,
          onHostKey: async (key) => {
            if (known && !equal(known, key)) {
              post({ type: 'error', code: 'HOST_KEY_MISMATCH', message: 'remote host key does not match the saved fingerprint' })
              return false
            }
            if (known) return true
            post({ type: 'hostKey', publicKey: key.slice().buffer, fingerprint: await fingerprint(key) }, [key.slice().buffer])
            const accepted = await new Promise<boolean>((resolve) => { hostKeyDecision = { resolve } })
            return accepted
          },
        })
        await session.openShell(request.options.columns ?? 80, request.options.rows ?? 24)
        outputTimer = setInterval(() => {
          const output = session?.pollShellOutput()
          if (output?.length) post({ type: 'output', payload: output.buffer }, [output.buffer])
        }, 10)
        post({ type: 'state', state: 'online' })
        return
      }
      if (request.type === 'hostKeyDecision') {
        hostKeyDecision?.resolve(request.accepted)
        hostKeyDecision = undefined
        return
      }
      if (!session) throw new Error('SSH session is unavailable')
      if (request.type === 'input') await session.write(new Uint8Array(request.payload))
      else if (request.type === 'resize') await session.resize(request.columns, request.rows)
      else if (request.type === 'exec') {
        const result = await session.exec(request.command)
        post({ type: 'execResult', id: request.id, stdout: result.stdout.buffer, stderr: result.stderr.buffer, exitCode: result.exitCode }, [result.stdout.buffer, result.stderr.buffer])
      } else if (request.type === 'close') {
        if (outputTimer) clearInterval(outputTimer)
        outputTimer = undefined
        await session.close()
        session = undefined
        post({ type: 'closed' })
      }
    } catch (error) {
      emitError(error)
    }
  })()
}
