import { store } from '../stores/app'
import { transferRuntime } from './sftp/transfer-runtime'
import { closeProtection } from './close-protection'
import { attachBrowserCloseProtection } from './browser-close-protection'

export function startWorkbenchCloseProtection(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  const unregister = [
    closeProtection.register('connections', () => store.tabs.some(tab => tab.state === 'connecting' || tab.state === 'online')),
    closeProtection.register('unsaved-editors', () => store.tabs.some(tab => tab.kind === 'editor' && tab.editor?.dirty)),
    closeProtection.register('transfers', () => transferRuntime.tasks.some(task => task.state === 'queued' || task.state === 'running')),
  ]
  const detach = attachBrowserCloseProtection(closeProtection, target)
  return () => {
    detach()
    unregister.forEach(release => release())
  }
}
