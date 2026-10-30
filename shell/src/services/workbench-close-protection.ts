import { store } from '../stores/app'
import { transferRuntime } from './sftp/transfer-runtime'
import { closeProtection } from './close-protection'
import { attachBrowserCloseProtection } from './browser-close-protection'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { isDesktop, nativeCall } from '../native/bridge'
import { confirmDialog } from './dialogs'

export function startWorkbenchCloseProtection(target: Pick<Window, 'addEventListener' | 'removeEventListener'>): () => void {
  const unregister = [
    closeProtection.register('connections', () => store.tabs.some(tab => tab.state === 'connecting' || tab.state === 'online')),
    closeProtection.register('unsaved-editors', () => store.tabs.some(tab => tab.kind === 'editor' && tab.editor?.dirty)),
    closeProtection.register('transfers', () => transferRuntime.tasks.some(task => task.state === 'queued' || task.state === 'running')),
  ]
  let disposed = false
  let detach = () => {}
  if (isDesktop()) {
    let closing = false
    void getCurrentWindow().onCloseRequested(async event => {
      event.preventDefault()
      if (closing) return
      closing = true
      try {
        if (closeProtection.blocked.value && !await confirmDialog('关闭 SealShell', '活动连接和传输将断开，未保存的编辑将丢失。确定退出？', { confirmLabel: '退出', danger: true })) return
        await nativeCall('runtime_close')
        await getCurrentWindow().destroy()
      } finally { closing = false }
    }).then(unlisten => { if (disposed) unlisten(); else detach = unlisten })
  } else { detach = attachBrowserCloseProtection(closeProtection, target) }
  return () => {
    disposed = true
    detach()
    unregister.forEach(release => release())
  }
}
