import type { Terminal } from '@xterm/xterm'

export type CommandArea = 'global' | 'host' | 'node' | 'terminal' | 'file' | 'editor' | 'tab'

export interface CommandContext {
  area: CommandArea
  tabId?: string
  tabGroupTabIds?: string[]
  terminal?: Terminal
  hasSelection?: boolean
  isOnline?: boolean
  canPaste?: boolean
  tabEncoding?: string
  selectedIds?: string[]
  selectedCount?: number
  selectedNodeIds?: string[]
  nodeKind?: 'host' | 'folder' | 'mixed' | 'root'
  targetFolderId?: string | null
  targetNodeKey?: string
  isPaired?: boolean
  selectedPaths?: string[]
  filePath?: string
  fileKind?: 'file' | 'directory' | 'symlink' | 'unknown'
  canPasteFiles?: boolean
}
