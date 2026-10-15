import { watch } from 'vue'
import type { CloseProtection } from './close-protection'

export function attachBrowserCloseProtection(protection: CloseProtection, target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!protection.blocked.value) return
    // This is only a veto. Leaving can still be cancelled by the user.
    event.preventDefault()
    event.returnValue = 'true'
  }
  const stop = watch(protection.blocked, (blocked) => {
    if (blocked) target.addEventListener('beforeunload', beforeUnload)
    else target.removeEventListener('beforeunload', beforeUnload)
  }, { immediate: true, flush: 'sync' })

  return () => {
    stop()
    target.removeEventListener('beforeunload', beforeUnload)
  }
}
