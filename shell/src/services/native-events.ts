import { nativeCall, nativeEvents } from '../native/bridge'
import { requestHostKeyApproval } from './hostKey'

let initialized: Promise<void> | undefined
const pending = new Map<string, AbortController>()
let prompts: Promise<unknown> = Promise.resolve()

export function initializeNativeEvents(): Promise<void> {
  return initialized ??= nativeEvents(event => {
    if (event.type === 'sessionClosed' && event.id) { pending.get(event.id)?.abort(); pending.delete(event.id); return }
    if (event.type !== 'hostKey' || !event.id) return
    const id = event.id
    const controller = new AbortController()
    pending.set(id, controller)
    prompts = prompts.catch(() => {}).then(async () => {
      let accepted = false
      try { accepted = await requestHostKeyApproval({ host: event.host, port: event.port, fingerprint: event.fingerprint }, controller.signal) }
      finally {
        pending.delete(id)
        await nativeCall('host_key_decision', { requestId: event.requestId, accepted })
      }
    }).catch(() => {})
  }).then(() => undefined)
}
