import { randomId } from '../../utils/id'
import { setBottomPanelActiveTab, store, type EditorTab, type FileEntry, type FileTab } from '../../stores/app'
import { getFileBackend, registerFileSession } from './file-tabs'
import type { FileBackend } from '../files/types'
import { transferFile } from './transfer'
import { confirmDialog } from '../dialogs'
import { encodingDecoder } from '../encodings'
import { readFileContents } from '../files/read'

const MAX_EDIT_SIZE = 10 * 1024 * 1024

function detectLanguage(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  return ({ ts: 'typescript', js: 'javascript', json: 'json', md: 'markdown', py: 'python', sh: 'shell' } as Record<string, string>)[extension] ?? 'text'
}

function bomSignature(bytes: Uint8Array): { encoding: 'utf-8' | 'utf-16le' | 'utf-16be'; offset: number } | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return { encoding: 'utf-8', offset: 3 }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { encoding: 'utf-16le', offset: 2 }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { encoding: 'utf-16be', offset: 2 }
  return null
}

function decodeFile(buffer: ArrayBuffer, forcedEncoding?: string): Pick<EditorTab['editor'], 'content' | 'encoding' | 'bom' | 'lineEnding'> {
  const bytes = new Uint8Array(buffer)
  const signature = bomSignature(bytes)
  const encoding = forcedEncoding ?? signature?.encoding ?? 'utf-8'
  // A BOM is only honored when it matches the effective decoding; under a
  // forced foreign encoding the signature bytes decode as regular content.
  const bom = !!signature && (!forcedEncoding || signature.encoding === forcedEncoding)
  const offset = bom ? signature.offset : 0
  const content = new TextDecoder(encodingDecoder(encoding)).decode(bytes.slice(offset))
  const crlf = (content.match(/\r\n/g) ?? []).length
  const cr = (content.match(/\r(?!\n)/g) ?? []).length
  const lf = (content.match(/(?<!\r)\n/g) ?? []).length
  const lineEnding: EditorTab['editor']['lineEnding'] = crlf >= lf && crlf >= cr ? '\r\n' : cr > lf ? '\r' : '\n'
  return { content, encoding, bom, lineEnding }
}

function encodeFile(editor: EditorTab['editor']): ArrayBuffer {
  const normalized = editor.content.replace(/\r\n|\r|\n/g, editor.lineEnding)
  let body: Uint8Array
  if (editor.encoding === 'utf-8') body = new TextEncoder().encode(normalized)
  else if (editor.encoding !== 'utf-16le' && editor.encoding !== 'utf-16be') {
    throw new Error(`Saving with ${editor.encoding} encoding is not supported yet`)
  } else {
    body = new Uint8Array(normalized.length * 2)
    for (let index = 0; index < normalized.length; index += 1) {
      const code = normalized.charCodeAt(index)
      if (editor.encoding === 'utf-16le') { body[index * 2] = code & 0xff; body[index * 2 + 1] = code >> 8 }
      else { body[index * 2] = code >> 8; body[index * 2 + 1] = code & 0xff }
    }
  }
  if (!editor.bom) return body.buffer as ArrayBuffer
  const prefix = editor.encoding === 'utf-8' ? new Uint8Array([0xef, 0xbb, 0xbf]) : editor.encoding === 'utf-16le' ? new Uint8Array([0xff, 0xfe]) : new Uint8Array([0xfe, 0xff])
  const merged = new Uint8Array(prefix.length + body.length)
  merged.set(prefix)
  merged.set(body, prefix.length)
  return merged.buffer as ArrayBuffer
}

export async function openEditorTab(fileTabId: string, entry: FileEntry): Promise<EditorTab | undefined> {
  const source = store.tabs.find((candidate) => candidate.id === fileTabId) as FileTab | undefined
  if (!source || source.kind !== 'file') return undefined
  const openConnection = getFileBackend(source.id)?.fork
  if (!openConnection) throw new Error('文件会话不可用，请重新打开窗口')
  const editor: EditorTab = {
    id: randomId(),
    kind: 'editor',
    hostId: source.hostId,
    endpoint: { ...source.endpoint },
    label: entry.name,
    state: 'connecting',
    error: '',
    sessionId: randomId(),
    terminalId: randomId(),
    telemetry: null,
    encoding: 'utf-8',
    cwd: source.file.cwd,
    editor: {
      path: entry.path,
      language: detectLanguage(entry.name),
      dirty: false,
      encoding: 'utf-8',
      bom: false,
      lineEnding: '\n',
      content: '',
      size: entry.size,
      largeFileConfirmed: false,
      contentVersion: 0,
    },
  }
  store.tabs.push(editor)
  setBottomPanelActiveTab(editor.id, 'editors')
  store.bottomPanelOpen = true
  try {
    if (entry.size > MAX_EDIT_SIZE && !await confirmDialog('文件较大', `${entry.name} 大小超过 10 MiB，仍要打开吗？`, { confirmLabel: '继续打开' })) throw new Error('Opening large file was cancelled')
    const backend = await openConnection()
    if (!store.tabs.some((item) => item.id === editor.id)) { await backend.disconnect(); return editor }
    registerFileSession(editor.id, backend)
    const stat = await backend.stat(entry.path, true)
    const content = decodeFile(await readFileContents(backend, entry.path, stat.size))
    const reactive = store.tabs.find((candidate) => candidate.id === editor.id) as EditorTab | undefined
    if (!reactive) return editor
    reactive.state = 'online'
    reactive.editor = { ...reactive.editor, ...content, size: stat.size, largeFileConfirmed: stat.size > MAX_EDIT_SIZE }
    return reactive
  } catch (error) {
    const reactive = store.tabs.find((candidate) => candidate.id === editor.id) as EditorTab | undefined
    const target = reactive ?? editor
    target.state = 'error'
    target.error = error instanceof Error ? error.message : String(error)
    return target
  }
}

// Re-decodes the remote file under a chosen encoding. The bump of
// contentVersion tells the editor view to rebuild its document.
export async function reopenEditorTab(tabId: string, encoding: string): Promise<void> {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as EditorTab | undefined
  const backend = getFileBackend(tabId)
  if (!tab || !backend) throw new Error('Editor session is unavailable')
  if (tab.editor.dirty) {
    const confirmed = await confirmDialog('以该编码重新打开', '当前文件有未保存的修改，重新打开将丢弃这些修改。', { confirmLabel: '丢弃修改并重新打开', danger: true })
    if (!confirmed) return
  }
  const stat = await backend.stat(tab.editor.path, true)
  const decoded = decodeFile(await readFileContents(backend, tab.editor.path, stat.size), encoding)
  tab.editor = { ...tab.editor, ...decoded, size: stat.size, dirty: false, contentVersion: tab.editor.contentVersion + 1 }
}

// Marks the editor to be written under a different encoding on the next save.
export function setEditorEncoding(tabId: string, encoding: string, bom: boolean): void {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as EditorTab | undefined
  if (!tab) return
  tab.editor.encoding = encoding
  tab.editor.bom = bom
  tab.editor.dirty = true
}

export async function saveEditorTab(tabId: string): Promise<void> {
  const tab = store.tabs.find((candidate) => candidate.id === tabId) as EditorTab | undefined
  const backend = getFileBackend(tabId)
  if (!tab || !backend) throw new Error('Editor session is unavailable')
  const payload = encodeFile(tab.editor)
  const memorySource: FileBackend = {
    paths: backend.paths,
    disconnect: async () => undefined,
    list: async () => ({ path: '/', entries: [] }),
    stat: async () => ({ name: tab.editor.path, path: tab.editor.path, kind: 'file', size: payload.byteLength, modifiedAt: Date.now() }),
    read: async (_path, offset = 0, length = payload.byteLength) => payload.slice(offset, offset + length),
    write: async () => undefined,
    mkdir: async () => undefined,
    remove: async () => undefined,
    rename: async () => ({ atomic: true }),
  }
  await transferFile(memorySource, backend, tab.editor.path, tab.editor.path, { })
  tab.editor.dirty = false
  tab.editor.size = payload.byteLength
}
