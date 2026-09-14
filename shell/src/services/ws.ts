import { randomId } from '../utils/id'
import { store, type FolderProfile, type HostProfile, type ShellState, type Tab } from '../stores/app'
import {
  deleteHosts as deleteStoredHosts,
  deleteFolderTree as deleteStoredFolderTree,
  listHosts as listStoredHosts,
  listFolders as listStoredFolders,
  saveHost,
  saveFolder,
} from './storage'
import { moveNodes } from './connectionTree'
import {
  initializeVault,
  loadCredentialRecord,
} from './vault'
import {
  closeExec as closeSshExec,
  closeSsh,
  connectSsh,
  exec as runExec,
  getSshSession,
  resize as resizeSsh,
  sendInput,
} from './ssh'
import { nodeClient, type NodeCallbacks } from './nodeClient'
import { closeFileTabSession } from './sftp/file-tabs'

const outputHandlers = new Map<string, (data: Uint8Array) => void>()
const pendingOutput = new Map<string, Uint8Array[]>()

export interface ExecResult {
  stdout: Uint8Array
  stderr: Uint8Array
  exitCode: number
}

export async function initializePwa(): Promise<void> {
  await nodeClient.initializeIdentity()
  await initializeVault()
  store.hosts = await listStoredHosts()
  store.folders = await listStoredFolders()
}

export function wsUrl(): string {
  return nodeClient.wsUrl()
}

export function setNodeDisconnectedHandler(handler: (() => void) | undefined): void {
  nodeClient.setDisconnectedHandler(handler)
}

export function clearAuth(): void {
  nodeClient.clearPairing()
  store.paired = false
  store.nodeConnected = false
}

export function disconnectNode(): void {
  nodeClient.disconnect()
}

export async function pair(pairingCode: string, callbacks: NodeCallbacks = {}): Promise<void> {
  try {
    await nodeClient.pair(pairingCode, callbacks)
    store.error = ''
    store.pairingModalOpen = false
    await listHosts()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.error = message
    callbacks.onError?.(message)
    throw error
  }
}

export async function connect(callbacks: NodeCallbacks = {}): Promise<void> {
  try {
    await nodeClient.connect(callbacks)
    store.error = ''
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    store.nodeConnected = false
    store.error = message
    callbacks.onError?.(message)
    throw error
  }
}

export async function listHosts(): Promise<void> {
  store.hosts = await listStoredHosts()
  store.folders = await listStoredFolders()
}

export async function createHost(host: HostProfile): Promise<void> {
  const normalized = { ...host, folderId: host.folderId ?? null }
  await saveHost(normalized)
  const current = store.hosts.findIndex((item) => item.id === normalized.id)
  if (current === -1) store.hosts.push(normalized)
  else store.hosts[current] = normalized
}

export async function createFolder(folder: FolderProfile): Promise<void> {
  await saveFolder(folder)
  const current = store.folders.findIndex((item) => item.id === folder.id)
  if (current === -1) store.folders.push(folder)
  else store.folders[current] = folder
}

export async function moveConnectionNodes(nodeIds: Set<string>, targetFolderId: string | null): Promise<void> {
  await moveNodes(nodeIds, targetFolderId, store.folders, store.hosts)
  const selectedFolders = new Set<string>()
  const selectedHosts = new Set<string>()
  for (const key of nodeIds) {
    const separator = key.indexOf(':')
    if (separator <= 0) continue
    const kind = key.slice(0, separator)
    const id = key.slice(separator + 1)
    if (kind === 'folder') selectedFolders.add(id)
    if (kind === 'host') selectedHosts.add(id)
  }
  store.folders = store.folders.map((folder) => selectedFolders.has(folder.id) ? { ...folder, parentId: targetFolderId } : folder)
  store.hosts = store.hosts.map((host) => selectedHosts.has(host.id) ? { ...host, folderId: targetFolderId } : host)
}

export async function deleteFolders(folderIds: string[]): Promise<{ folderIds: string[]; hostIds: string[] }> {
  const deleted = await deleteStoredFolderTree(folderIds)
  const folderSet = new Set(deleted.folderIds)
  const hostSet = new Set(deleted.hostIds)
  store.folders = store.folders.filter((folder) => !folderSet.has(folder.id))
  store.hosts = store.hosts.filter((host) => !hostSet.has(host.id))
  store.selectedNodeIds = new Set(Array.from(store.selectedNodeIds).filter((key) => {
    const separator = key.indexOf(':')
    if (separator <= 0) return false
    const id = key.slice(separator + 1)
    return !folderSet.has(id) && !hostSet.has(id)
  }))
  store.selectedHostIds = new Set(Array.from(store.selectedHostIds).filter((id) => !hostSet.has(id)))
  return deleted
}

export async function deleteHosts(hostIds: string[]): Promise<void> {
  if (!hostIds.length) return
  await deleteStoredHosts(hostIds)
  const deleted = new Set(hostIds)
  store.hosts = store.hosts.filter((host) => !deleted.has(host.id))
  store.selectedNodeIds = new Set(
    Array.from(store.selectedNodeIds).filter((key) => !key.startsWith('host:') || !deleted.has(key.slice('host:'.length))),
  )
  store.selectedHostIds = new Set(
    Array.from(store.selectedHostIds).filter((id) => !deleted.has(id)),
  )
}

export function setTerminalOutputHandler(
  sessionId: string,
  handler: ((data: Uint8Array) => void) | null,
): void {
  if (!handler) {
    outputHandlers.delete(sessionId)
    pendingOutput.delete(sessionId)
    return
  }
  outputHandlers.set(sessionId, handler)
  const buffered = pendingOutput.get(sessionId)
  pendingOutput.delete(sessionId)
  for (const data of buffered ?? []) handler(data)
}

function emitTerminalOutput(sessionId: string, data: Uint8Array): void {
  const handler = outputHandlers.get(sessionId)
  if (handler) {
    handler(data)
    return
  }
  const buffered = pendingOutput.get(sessionId) ?? []
  const total = buffered.reduce((sum, item) => sum + item.length, 0)
  if (total + data.length <= 1024 * 1024) {
    buffered.push(data.slice())
    pendingOutput.set(sessionId, buffered)
  }
}

export interface AddTabOptions {
  allowLoginDialog?: boolean
}

export function addTab(host: HostProfile, password: string, insertAfterTabId?: string, options?: AddTabOptions): Tab {
  const tabId = randomId()
  const sessionId = randomId()
  const terminalId = randomId()
  const tab: Tab = {
    id: tabId,
    kind: 'terminal',
    hostId: host.id,
    label: host.name,
    state: 'connecting',
    error: '',
    sessionId,
    terminalId,
    telemetry: null,
    encoding: host.encoding ?? 'utf-8',
  }

  if (insertAfterTabId) {
    tab.afterTabId = insertAfterTabId
    const index = store.tabs.findIndex((item) => item.id === insertAfterTabId)
    if (index >= 0) store.tabs.splice(index + 1, 0, tab)
    else store.tabs.push(tab)
  } else {
    store.tabs.push(tab)
  }
  store.activeTerminalTabId = tabId
  store.focusedDock = 'terminal'
  store.view = 'shell'
  store.connectionModalOpen = false
  store.editingHostId = ''
  void startTab(tab, host, password, options)
  return tab
}

export function reconnectTab(tab: Tab, host: HostProfile, password: string, options?: AddTabOptions): Tab | undefined {
  const reactiveTab = store.tabs.find((item) => item.id === tab.id)
  if (!reactiveTab) return undefined
  setTerminalOutputHandler(reactiveTab.sessionId, null)
  void closeSsh(reactiveTab.sessionId)
  reactiveTab.state = 'connecting'
  reactiveTab.error = ''
  reactiveTab.telemetry = null
  reactiveTab.sessionId = randomId()
  void startTab(reactiveTab, host, password, options)
  return reactiveTab
}

const AUTH_ERROR_PATTERN = /authentication|authenticate|permission\s*denied|too\s*many\s*authentication|invalid\s*credentials|no\s+supported\s+methods\s+remain|no\s+remaining\s+authentication\s+methods/i

function isAuthError(message: string): boolean {
  return AUTH_ERROR_PATTERN.test(message)
}

function isSavedHost(host: HostProfile): boolean {
  return store.hosts.some((item) => item.id === host.id)
}

function openLoginDialog(host: HostProfile, error: string, tabId = '', insertAfterTabId = ''): void {
  store.loginDialogHostId = host.id
  store.loginDialogTabId = tabId
  store.loginDialogError = error
  store.loginDialogInsertAfterTabId = insertAfterTabId
  store.loginDialogOpen = true
}

async function getSavedCredential(hostId: string): Promise<string | undefined> {
  const saved = await loadCredentialRecord(hostId)
  if (!saved) return undefined
  return saved.password ?? ''
}

export async function connectHost(host: HostProfile, insertAfterTabId?: string): Promise<void> {
  try {
    const credential = await getSavedCredential(host.id)
    if (credential === undefined) {
      openLoginDialog(host, '', '', insertAfterTabId)
      return
    }
    addTab(host, credential, insertAfterTabId)
  } catch (error) {
    store.error = error instanceof Error ? error.message : String(error)
  }
}


async function startTab(tab: Tab, host: HostProfile, password: string, options?: AddTabOptions): Promise<void> {
  const { allowLoginDialog = true } = options ?? {}
  try {
    let credential = password
    if (!credential) {
      const saved = await loadCredentialRecord(host.id)
      if (saved) {
        credential = saved.password ?? ''
      }
    }
    const reactiveTab = store.tabs.find((item) => item.id === tab.id)
    if (!reactiveTab) throw new Error('tab not found in reactive store')

    await connectSsh(
      {
        sessionId: reactiveTab.sessionId,
        host: host.address,
        port: host.port,
        username: host.username,
        password: credential,
      },
      (state, error) => updateTabState(reactiveTab.sessionId, state, error),
      (data) => {
        emitTerminalOutput(reactiveTab.sessionId, data)
      },
    )
    updateTabState(reactiveTab.sessionId, 'online')
    if (store.loginDialogOpen && store.loginDialogHostId === host.id) {
      store.loginDialogOpen = false
      store.loginDialogError = ''
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateTabState(tab.sessionId, 'error', message)
    if (allowLoginDialog && isSavedHost(host) && isAuthError(message)) {
      openLoginDialog(host, message, tab.id)
    } else if (store.loginDialogOpen && store.loginDialogHostId === host.id) {
      store.loginDialogError = message
    }
  }
}

function updateTabState(sessionId: string, state: ShellState, error = ''): void {
  const tab = store.tabs.find((item) => item.sessionId === sessionId)
  if (!tab) return
  tab.state = state
  tab.error = error
  if (state === 'idle' || state === 'error') {
    tab.telemetry = null
    if (tab.id === store.activeTerminalTabId) store.telemetry = null
  }
}

export function closeTab(tabId: string): void {
  closeTabs([tabId])
}

export function closeTabs(tabIds: string[], skipDirtyPrompt = false): void {
  if (!skipDirtyPrompt && store.dirtyCloseConfirm) return
  const closing = new Set(tabIds)
  const requestedTabs = store.tabs.filter((tab) => closing.has(tab.id))
  if (!skipDirtyPrompt) {
    const dirty = requestedTabs.find((tab) => tab.kind === 'editor' && tab.editor?.dirty)
    if (dirty && dirty.kind === 'editor' && dirty.editor) {
      store.dirtyCloseConfirm = {
        tabId: dirty.id,
        path: dirty.editor.path,
        remainingTabIds: requestedTabs.filter((tab) => tab.id !== dirty.id).map((tab) => tab.id),
      }
      return
    }
  }
  const tabsToClose = requestedTabs
  if (!tabsToClose.length) return

  const previousTabs = store.tabs.slice()
  const nextActiveId = (kind: Tab['kind'], activeId: string): string => {
    if (!activeId || !closing.has(activeId)) return activeId
    const typed = previousTabs.filter((tab) => tab.kind === kind)
    const index = typed.findIndex((tab) => tab.id === activeId)
    const remaining = typed.filter((tab) => !closing.has(tab.id))
    return remaining[index]?.id ?? remaining[index - 1]?.id ?? remaining[0]?.id ?? ''
  }

  store.tabs = store.tabs.filter((tab) => !closing.has(tab.id))
  for (const tab of tabsToClose) {
    outputHandlers.delete(tab.sessionId)
    pendingOutput.delete(tab.sessionId)
    void closeSsh(tab.sessionId)
    if (tab.kind === 'file' || tab.kind === 'editor') void closeFileTabSession(tab.id)
  }

  store.activeTerminalTabId = nextActiveId('terminal', store.activeTerminalTabId)
  store.activeFileTabId = nextActiveId('file', store.activeFileTabId)
  store.activeEditorTabId = nextActiveId('editor', store.activeEditorTabId)
  if (!store.tabs.some((tab) => tab.kind === 'file' || tab.kind === 'editor')) {
    store.bottomPanelOpen = false
  }
  const activeTerminal = store.tabs.find((tab) => tab.id === store.activeTerminalTabId)
  store.telemetry = activeTerminal?.telemetry ?? null
  if (!store.tabs.length) {
    store.view = 'welcome'
    store.telemetry = null
  } else {
    store.view = 'shell'
  }
}

export function sendTerminalInput(sessionId: string, payload: Uint8Array): void {
  const tab = store.tabs.find((item) => item.sessionId === sessionId)
  if (tab) void sendInput(tab.sessionId, payload).catch((error) => {
    updateTabState(tab.sessionId, 'error', error instanceof Error ? error.message : String(error))
  })
}

export function resizeTerminal(terminalId: string, columns: number, rows: number): void {
  const tab = store.tabs.find((item) => item.terminalId === terminalId)
  if (tab) void resizeSsh(tab.sessionId, columns, rows)
}

export async function exec(sessionId: string, command: string): Promise<ExecResult> {
  const session = getSshSession(sessionId)
  if (!session) throw new Error('SSH session is unavailable')
  return runExec(session, command)
}

export function closeExec(sessionId: string): Promise<void> {
  return closeSshExec(sessionId)
}
