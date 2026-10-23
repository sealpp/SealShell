import { watch } from 'vue'
import { store, type EditorTab } from '../../stores/app'
import { monaco } from './runtime'
import { detectEditorLanguage } from './language'

interface EditorDocument {
  model: monaco.editor.ITextModel
  viewState: monaco.editor.ICodeEditorViewState | null
  wordWrap: 'on' | 'off'
  dispose(): void
}
const documents = new Map<string, EditorDocument>()

// Dockview can recreate a view when moving it. The file tab owns the document,
// so moving/hiding a pane retains its undo stack; closing the tab disposes it.
watch(() => store.tabs.map(tab => tab.id), ids => {
  const live = new Set(ids)
  for (const [id, document] of documents) {
    if (!live.has(id)) { document.dispose(); documents.delete(id) }
  }
}, { flush: 'post' })

export function getEditorDocument(tab: EditorTab): EditorDocument {
  const existing = documents.get(tab.id)
  if (existing) return existing
  const language = () => detectEditorLanguage(monaco.languages.getLanguages(), tab.editor.path, tab.editor.content)
  tab.editor.language = language()
  const model = monaco.editor.createModel(tab.editor.content, tab.editor.language,
    monaco.Uri.from({ scheme: 'sealshell', authority: tab.id, path: '/' + tab.editor.path.replace(/\\/g, '/').replace(/^\/+/, '') }))
  let reloading = false
  const change = model.onDidChangeContent(() => {
    if (reloading) return
    tab.editor.content = model.getValue(monaco.editor.EndOfLinePreference.LF)
    tab.editor.dirty = true
  })
  const stopReload = watch(() => tab.editor.contentVersion, () => {
    reloading = true
    try {
      model.setValue(tab.editor.content)
      tab.editor.language = language()
      monaco.editor.setModelLanguage(model, tab.editor.language)
      document.viewState = null
    } finally { reloading = false }
  }, { flush: 'sync' })
  const document: EditorDocument = {
    model, viewState: null, wordWrap: 'on',
    dispose() { stopReload(); change.dispose(); model.dispose() },
  }
  documents.set(tab.id, document)
  return document
}

export { monaco }
