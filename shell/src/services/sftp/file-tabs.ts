import { shallowReactive } from 'vue'
import { randomId } from '../../utils/id'
import { setBottomPanelActiveTab, store, type FileTab, type HostProfile } from '../../stores/app'
import { listDirectory } from './operations'
import { createSftpClipboardPayload } from './clipboard'
import { connectFileEndpoint } from '../files/connect'
import { NativeFileBackend } from '../files/native-backend'
import { posixPaths } from '../files/path'
import type { FileBackend, FileEndpoint } from '../files/types'
import { readMeta, saveMeta } from '../storage'
import { transferFileEntries } from '../files/transfers'
import { getSshSession } from '../ssh'
import { copyConnection, type RemoteConnection } from '../proxy/types'

const sessions = shallowReactive(new Map<string, FileBackend>())
const listings = new Map<string, number>()

export function getFileBackend(tabId: string): FileBackend | undefined { return sessions.get(tabId) }
export function registerFileSession(tabId: string, backend: FileBackend): void { sessions.set(tabId, backend) }

export function fileTabLabel(tab: FileTab): string {
  const owner = tab.endpoint.kind === 'local' ? '本地' : store.hosts.find((host) => host.id === tab.hostId)?.name || 'SFTP'
  return `${owner}: ${tab.file.cwd}`
}

function newFileTab(endpoint: FileEndpoint, initialPath: string, splitBeside?: string, source?: RemoteConnection): FileTab {
  const tab: FileTab = {
    id: randomId(), kind: 'file', endpoint,
    proxySource: source?.proxySource,
    ...(endpoint.kind === 'sftp' ? { hostId: endpoint.hostId } : {}),
    fileSplitBeside: splitBeside,
    label: endpoint.kind === 'local' ? '本地' : 'SFTP',
    state: 'connecting', error: '', sessionId: randomId(), terminalId: '', encoding: 'utf-8', cwd: initialPath,
    file: { cwd: initialPath, defaultPath: initialPath, history: [initialPath], historyIndex: 0, entries: [], selectedPaths: [], sortKey: null, sortDirection: 'asc', showHidden: false, loading: true, error: '' },
  }
  store.tabs.push(tab)
  setBottomPanelActiveTab(tab.id, 'files')
  store.bottomPanelOpen = true
  store.view = 'shell'
  void startFileTab(tab.id, source)
  return tab
}

export function createFileTab(host: HostProfile, sourceTabId: string, initialPath = '/'): FileTab {
  const tab = store.tabs.find(item => item.id === sourceTabId)
  const source = tab ? getSshSession(tab.sessionId) : undefined
  return newFileTab({ kind: 'sftp', hostId: host.id }, posixPaths.normalize(initialPath), undefined, source ? copyConnection(source) : undefined)
}
export function createLocalFileTab(split = false): FileTab {
  return newFileTab({ kind: 'local' }, '', split ? store.activeFileTabId || undefined : undefined)
}

async function startFileTab(tabId: string, source?: RemoteConnection): Promise<void> {
  const tab = store.tabs.find((item) => item.id === tabId) as FileTab | undefined
  if (!tab) return
  let backend: FileBackend | undefined
  try {
    backend = await connectFileEndpoint(tab.endpoint, source)
    if (!store.tabs.some((item) => item.id === tabId)) { await backend.disconnect(); return }
    sessions.set(tabId, backend)
    let initialPath = tab.file.cwd
    let fallbackNotice = ''
    if (backend instanceof NativeFileBackend && !backend.connection) {
      tab.file.roots = backend.info.roots
      const recent = await readMeta<{ key: string; path: string }>('localDirectory')
      initialPath = recent?.path ?? backend.info.home
      tab.file.defaultPath = backend.info.home
      try { if ((await backend.stat(initialPath, true)).kind !== 'directory') throw new Error('不是目录') }
      catch (error) { fallbackNotice = `无法打开最近目录 ${initialPath}，已回到主目录：${error instanceof Error ? error.message : String(error)}`; initialPath = backend.info.home }
    } else {
      try { if ((await backend.stat(initialPath, true)).kind !== 'directory') throw new Error('不是目录') }
      catch (error) {
        fallbackNotice = `无法打开终端目录 ${initialPath}，已回到根目录：${error instanceof Error ? error.message : String(error)}`
        initialPath = '/'
        tab.file.defaultPath = '/'
      }
    }
    tab.file.cwd = initialPath
    tab.cwd = initialPath
    tab.file.history = [initialPath]
    tab.state = 'online'
    await refreshFileTab(tabId)
    if (fallbackNotice) tab.file.error = fallbackNotice
  } catch (error) {
    await backend?.disconnect()
    sessions.delete(tabId)
    tab.state = 'error'
    tab.error = error instanceof Error ? error.message : String(error)
    tab.file.error = tab.error
    tab.file.loading = false
  }
}

export async function refreshFileTab(tabId: string): Promise<void> {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as FileTab | undefined
  const backend = sessions.get(tabId)
  if (!tab || !backend) return
  const generation = (listings.get(tabId) ?? 0) + 1
  listings.set(tabId, generation)
  const path = tab.file.cwd
  tab.file.loading = true
  tab.file.error = ''
  try {
    // Read live options after listing, including header changes made while awaiting pages.
    const entries = await listDirectory(backend, path, tab.file)
    if (listings.get(tabId) !== generation) return
    tab.file.entries = entries
    tab.label = fileTabLabel(tab)
    if (tab.endpoint.kind === 'local') await saveMeta({ key: 'localDirectory', path })
  } catch (error) {
    if (listings.get(tabId) === generation) tab.file.error = error instanceof Error ? error.message : String(error)
  } finally { if (listings.get(tabId) === generation) tab.file.loading = false }
}

export async function navigateFileTab(tabId: string, path: string, pushHistory = true): Promise<void> {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as FileTab | undefined
  const backend = sessions.get(tabId)
  if (!tab || !backend) return
  try {
    const next = backend.paths.normalize(path, tab.file.cwd)
    if ((await backend.stat(next, true)).kind !== 'directory') throw new Error('目标不是目录')
    if (pushHistory) {
      tab.file.history = tab.file.history.slice(0, tab.file.historyIndex + 1).concat(next)
      tab.file.historyIndex = tab.file.history.length - 1
    }
    tab.file.cwd = next
    tab.cwd = next
    tab.file.selectedPaths = []
    await refreshFileTab(tabId)
  } catch (error) { tab.file.error = error instanceof Error ? error.message : String(error) }
}
export async function navigateParentFileTab(tabId: string): Promise<void> {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as FileTab | undefined
  const backend = sessions.get(tabId)
  if (tab && backend) await navigateFileTab(tabId, backend.paths.parent(tab.file.cwd))
}
export async function closeFileTabSession(tabId: string): Promise<void> {
  const backend = sessions.get(tabId)
  sessions.delete(tabId)
  listings.delete(tabId)
  await backend?.disconnect().catch(() => undefined)
}
export async function goBackFileTab(tabId: string): Promise<void> {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as FileTab | undefined
  if (!tab || tab.file.historyIndex <= 0) return
  await navigateFileTab(tabId, tab.file.history[--tab.file.historyIndex], false)
}
export async function goForwardFileTab(tabId: string): Promise<void> {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as FileTab | undefined
  if (!tab || tab.file.historyIndex >= tab.file.history.length - 1) return
  await navigateFileTab(tabId, tab.file.history[++tab.file.historyIndex], false)
}
export function copySelectedFileEntries(tabId: string, mode: 'copy' | 'cut'): void {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as FileTab | undefined
  if (!tab) return
  const entries = tab.file.entries.filter((entry) => tab.file.selectedPaths.includes(entry.path))
  store.sftpClipboard = createSftpClipboardPayload(mode, tab.id, tab.sessionId, entries)
}
export async function pasteFileTab(tabId: string): Promise<void> {
  const clipboard = store.sftpClipboard
  if (!clipboard) return
  await transferFileEntries(clipboard.sourceTabId, tabId, clipboard.entries.map((entry) => entry.path), undefined, clipboard.mode)
  if (store.sftpClipboard === clipboard) store.sftpClipboard = null
}
export async function deleteFileEntries(tabId: string, paths: string[]): Promise<void> {
  const backend = sessions.get(tabId)
  const tab = store.tabs.find((item) => item.id === tabId) as FileTab | undefined
  if (!backend || !tab) return
  for (const path of paths) {
    const kind = tab.file.entries.find((item) => item.path === path)?.kind
    await backend.remove(path, kind === 'directory')
  }
  tab.file.selectedPaths = []
  await refreshFileTab(tabId)
}
export async function renameFileEntry(tabId: string, path: string, name: string): Promise<void> {
  const backend = sessions.get(tabId)
  if (!backend) throw new Error('文件会话不可用')
  await backend.rename(path, backend.paths.join(backend.paths.parent(path), name))
  await refreshFileTab(tabId)
}
export async function createDirectory(tabId: string, name: string): Promise<void> {
  const backend = sessions.get(tabId)
  const tab = store.tabs.find((item) => item.id === tabId) as FileTab | undefined
  if (!backend || !tab) return
  await backend.mkdir(backend.paths.join(tab.file.cwd, name))
  await refreshFileTab(tabId)
}
