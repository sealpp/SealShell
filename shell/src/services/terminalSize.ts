import { watch } from 'vue'
import { store, type TerminalSize } from '../stores/app'

export function publishTerminalSize(tabIds: string[], size: TerminalSize): void {
  for (const id of tabIds) {
    const tab = store.tabs.find(tab => tab.id === id && tab.kind === 'terminal')
    if (tab && (tab.viewportSize?.columns !== size.columns || tab.viewportSize.rows !== size.rows)) {
      tab.viewportSize = { ...size }
    }
  }
}

export async function waitForTerminalSize(tabId: string, sessionId: string): Promise<TerminalSize | undefined> {
  const currentSize = () => {
    const tab = store.tabs.find(tab => tab.id === tabId)
    return tab?.sessionId === sessionId ? tab.viewportSize : null
  }
  const size = currentSize()
  if (size !== undefined) return size ?? undefined

  return new Promise(resolve => {
    const stop = watch(currentSize, size => {
      if (size === undefined) return
      stop()
      resolve(size ?? undefined)
    }, { flush: 'sync' })
  })
}
