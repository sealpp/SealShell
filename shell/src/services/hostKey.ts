import { store } from '../stores/app'

export interface HostKeyPromptState {
  host: string
  port: number
  fingerprint: string
}

let pending: ((accepted: boolean) => void) | undefined

export function requestHostKeyApproval(prompt: HostKeyPromptState, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false)
  if (pending) return Promise.reject(new Error('another host key prompt is active'))
  store.hostKeyPrompt = prompt
  return new Promise((resolve) => {
    const cancel = () => respondHostKeyApproval(false)
    signal?.addEventListener('abort', cancel, { once: true })
    pending = (accepted) => {
      signal?.removeEventListener('abort', cancel)
      resolve(accepted)
    }
  })
}

export function respondHostKeyApproval(accepted: boolean): void {
  const resolve = pending
  pending = undefined
  store.hostKeyPrompt = null
  resolve?.(accepted)
}
