import { store, type FileTab } from '../../stores/app'
import { choiceDialog } from '../dialogs'
import { enqueueTransfer } from '../sftp/transfer-runtime'
import { fileTabLabel, getFileBackend, refreshFileTab } from '../sftp/file-tabs'

export function transferTargets(sourceId: string): FileTab[] {
  const candidates = store.tabs.filter((tab): tab is FileTab => tab.kind === 'file' && tab.id !== sourceId && tab.state === 'online')
  const visible = candidates.filter((tab) => store.visibleFileTabIds.includes(tab.id))
  return visible.length ? visible : candidates
}

export function transferActionLabel(sourceId: string): string {
  const source = store.tabs.find((tab) => tab.id === sourceId)
  const targets = transferTargets(sourceId)
  const action = source?.endpoint?.kind === 'local' ? '上传 / 复制到' : '下载 / 复制到'
  return targets.length === 1 ? `${action} ${fileTabLabel(targets[0])}` : `${action}…`
}

export async function transferToOtherPane(sourceId: string, paths: string[]): Promise<void> {
  const targets = transferTargets(sourceId)
  let target = targets[0]
  if (!target) return
  if (targets.length > 1) {
    const choice = await choiceDialog('选择传输目标', '复制到所选窗口的当前目录', targets.map((tab) => ({ value: tab.id, label: fileTabLabel(tab) })))
    if (!choice) return
    target = targets.find((tab) => tab.id === choice.value)!
  }
  await transferFileEntries(sourceId, target.id, paths)
}

export async function transferFileEntries(sourceId: string, targetId: string, paths: string[], directory?: string, mode: 'copy' | 'cut' = 'copy'): Promise<void> {
  const sourceTab = store.tabs.find(tab => tab.id === sourceId && tab.kind === 'file') as FileTab | undefined
  const targetTab = store.tabs.find(tab => tab.id === targetId && tab.kind === 'file') as FileTab | undefined
  if (!sourceTab || !targetTab || !paths.length) return
  const source = getFileBackend(sourceId), target = getFileBackend(targetId)
  if (!source?.nativeId || !target?.nativeId) throw new Error('文件会话不可用，请重新打开窗口')
  const move = mode === 'cut' && sourceTab.sessionId === targetTab.sessionId
  try {
    await enqueueTransfer(`${move ? '移动' : '复制'} ${paths.length} 项 → ${fileTabLabel(targetTab)}${mode === 'cut' && !move ? '（保留源文件）' : ''}`, {
      sourceId: source.nativeId, targetId: target.nativeId, paths, directory: directory ?? targetTab.file.cwd, moveFiles: move,
    })
  } finally { await Promise.allSettled([refreshFileTab(sourceId), refreshFileTab(targetId)]) }
}
