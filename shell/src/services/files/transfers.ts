import { store, type FileTab } from '../../stores/app'
import { choiceDialog, promptDialog } from '../dialogs'
import { statIfExists, type FileBackend } from './types'
import { copyEntry } from '../sftp/operations'
import { enqueueTransfer } from '../sftp/transfer-runtime'
import { assertNotCancelled, commitTemporary, temporarySibling, TransferCancelledError, TransferOrphanError, type TransferResult } from '../sftp/transfer'
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
  const sourceTab = store.tabs.find((tab) => tab.id === sourceId && tab.kind === 'file') as FileTab | undefined
  const targetTab = store.tabs.find((tab) => tab.id === targetId && tab.kind === 'file') as FileTab | undefined
  if (!sourceTab || !targetTab || !paths.length) return
  const sourceFactory = getFileBackend(sourceId)?.fork
  const targetFactory = getFileBackend(targetId)?.fork
  if (!sourceFactory || !targetFactory) throw new Error('文件会话不可用，请重新打开窗口')
  const targetDirectory = directory ?? targetTab.file.cwd
  // Clipboard paths remain valid after the source pane navigates elsewhere.
  const clipboard = store.sftpClipboard?.sourceTabId === sourceId ? store.sftpClipboard : undefined
  const entries = paths.map((path) => ({ path, kind: sourceTab.file.entries.find((entry) => entry.path === path)?.kind ?? clipboard?.entries.find((entry) => entry.path === path)?.kind }))
  const move = mode === 'cut' && sourceTab.sessionId === targetTab.sessionId
  const task = enqueueTransfer(`${move ? '移动' : '复制'} ${entries.length} 项 → ${fileTabLabel(targetTab)}${mode === 'cut' && !move ? '（保留源文件）' : ''}`, async (signal, progress) => {
    let source: FileBackend | undefined
    let target: FileBackend | undefined
    try {
      assertNotCancelled(signal)
      source = await sourceFactory(signal)
      target = await targetFactory(signal)
      let result: TransferResult = { sourcePath: paths[0], targetPath: targetDirectory, bytes: 0, atomic: false, metadataApplied: false }
      const overwriteAll = new Set<string>()
      const skipAll = new Set<string>()
      for (let index = 0; index < entries.length; index++) {
        assertNotCancelled(signal)
        const metadata = await source.stat(entries[index].path)
        const item = { ...metadata, kind: entries[index].kind ?? metadata.kind }
        let destination = target.paths.join(targetDirectory, item.name)
        const sameNamespace = source.namespace === target.namespace
        if (sameNamespace && source.paths.equal(item.path, destination)) {
          if (move) continue
          let suffix = 1
          do { destination = target.paths.join(targetDirectory, `${item.name}-copy${suffix > 1 ? `-${suffix}` : ''}`); suffix++ }
          while (await statIfExists(target, destination))
        }
        if (sameNamespace && item.kind === 'directory'
          && (source.paths.descendant(destination, item.path) || source.paths.descendant(item.path, destination))) throw new Error('不能向自身、子目录或祖先目录复制/移动目录')
        let existing = await statIfExists(target, destination)
        while (existing) {
          if (existing.kind !== item.kind) throw new Error(`文件类型冲突：${destination}`)
          if (skipAll.has(item.kind)) break
          if (overwriteAll.has(item.kind)) break
          const choice = await choiceDialog('目标已存在', `${destination}\n${item.kind === 'directory' ? '替换整个目录，目标中源目录没有的文件也会永久删除。' : '替换会覆盖目标文件。'}`, [
            { value: 'replace', label: item.kind === 'directory' ? '整目录替换' : '覆盖' },
            { value: 'skip', label: '跳过' },
            { value: 'rename', label: '重命名副本' },
          ], '将选择应用于本批剩余同类型重名项目')
          assertNotCancelled(signal)
          if (!choice) return result
          if (choice.value === 'replace') { if (choice.checked) overwriteAll.add(item.kind); break }
          if (choice.value === 'skip') { if (choice.checked) skipAll.add(item.kind); destination = ''; break }
          const name = await promptDialog('重命名副本', item.name)
          if (name === null) { destination = ''; break }
          destination = target.paths.join(targetDirectory, name)
          if (sameNamespace && source.paths.equal(item.path, destination)) throw new Error('不能覆盖源文件自身')
          existing = await statIfExists(target, destination)
        }
        if (!destination || (existing && skipAll.has(item.kind))) continue
        if (sameNamespace && item.kind === 'directory'
          && (source.paths.descendant(destination, item.path) || source.paths.descendant(item.path, destination))) throw new Error('不能向子目录或祖先目录复制/移动目录')
        if (move) {
          if (existing) {
            const staging = temporarySibling(target, destination)
            await target.rename(item.path, staging)
            try { result = { ...result, ...await commitTemporary(target, staging, destination) } }
            catch (error) { await target.rename(staging, item.path); throw error }
          } else result = { ...result, ...await target.rename(item.path, destination) }
        } else {
          const results = await copyEntry(source, target, item.path, destination, signal,
            (bytes, total) => progress(index + (total ? bytes / total : 0), entries.length), item)
          result = results[results.length - 1] ?? result
        }
        progress(index + 1, entries.length)
      }
      return result
    } catch (error) {
      if (signal.aborted && !(error instanceof TransferOrphanError)) {
        throw error instanceof TransferCancelledError ? error : new TransferCancelledError()
      }
      throw error
    } finally {
      await Promise.allSettled([source?.disconnect(), target?.disconnect()])
      await Promise.allSettled([refreshFileTab(sourceId), refreshFileTab(targetId)])
    }
  })
  await task.promise
}
