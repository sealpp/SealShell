import { store } from '../stores/app'
import { droppedFilePaths } from '../native/fileDrop'
import { getSshSession } from './ssh'
import { enqueueUpload } from './sftp/transfer-runtime'

export interface TerminalUploadTarget {
  tabId: string
  sessionId: string
  directory: string
  destination: string
}

export function terminalUploadTarget(tabId: string): TerminalUploadTarget {
  const tab = store.tabs.find(tab => tab.id === tabId && tab.kind === 'terminal')
  if (!tab || tab.state !== 'online') throw new Error('终端未连接，无法上传')
  const connection = getSshSession(tab.sessionId)
  if (!connection) throw new Error('终端连接已失效，请重新连接')
  if (!tab.cwd?.startsWith('/') || /[\x00-\x1f\x7f]/.test(tab.cwd)) throw new Error('无法获取当前终端目录，未上传任何文件')
  const address = connection.host.includes(':') ? `[${connection.host}]` : connection.host
  return {
    tabId, sessionId: tab.sessionId, directory: tab.cwd,
    destination: `${connection.username}@${address}${connection.port === 22 ? '' : `:${connection.port}`}:${tab.cwd}`,
  }
}

export async function uploadTerminalFiles(target: TerminalUploadTarget, files: File[]): Promise<void> {
  const paths = await droppedFilePaths(files)
  const tab = store.tabs.find(tab => tab.id === target.tabId)
  if (!tab || tab.sessionId !== target.sessionId || tab.state !== 'online') throw new Error('来源终端已关闭或重连，未开始上传')
  await enqueueUpload(`上传 ${paths.length} 项 → ${target.destination}`, {
    sessionId: target.sessionId, directory: target.directory, paths,
  })
}

export function isFileDrop(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes('Files')
}

export function preventFileNavigation(target: Pick<Document, 'addEventListener' | 'removeEventListener'>): () => void {
  const prevent = (event: Event) => { if (isFileDrop(event as DragEvent)) event.preventDefault() }
  target.addEventListener('dragover', prevent)
  target.addEventListener('drop', prevent)
  return () => { target.removeEventListener('dragover', prevent); target.removeEventListener('drop', prevent) }
}
