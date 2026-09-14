import { store } from '../stores/app'
import { registerAction } from './commands'
import { MenuId } from './actions/menuIds'
import { alertDialog, confirmCheckboxDialog } from './dialogs'
import {
  buildVisibleNodes,
  canMoveToFolder,
  cloneConnectionNodes,
  collectFolderDescendants,
  collectFolderHostIds,
  findSiblingNameConflict,
  nodeInsideFolder,
  nodeKey,
  normalizeMoveSelection,
  parseNodeKey,
  resolveCopyName,
  resolvePasteFolderId,
  siblingNames,
} from './connectionTree'
import { createFolder, createHost, deleteFolders, deleteHosts, moveConnectionNodes } from './ws'
import { loadCredentialRecord, saveCredentialRecord } from './vault'
import type { CommandContext } from './context'

function selectedKeys(ctx: CommandContext): Set<string> {
  const keys = ctx.selectedNodeIds ?? Array.from(store.selectedNodeIds)
  return normalizeMoveSelection(new Set(keys), store.folders, store.hosts)
}

function clipboardTitle(verb: string) {
  return (ctx: CommandContext) => {
    const count = ctx.selectedNodeIds?.length ?? 0
    return count > 1 ? `${verb} (${count})` : verb
  }
}

function selectNodeKeys(keys: string[]): void {
  store.selectedNodeIds = new Set(keys)
  store.selectedHostIds = new Set(
    keys.filter((key) => key.startsWith('host:')).map((key) => key.slice('host:'.length)),
  )
  store.selectionAnchorNodeId = keys[keys.length - 1] ?? ''
}

function keyboardTargetKey(): string | undefined {
  const order = buildVisibleNodes(store.folders, store.hosts, store.expandedFolderIds)
  return order.map((node) => nodeKey(node.kind, node.id)).find((key) => store.selectedNodeIds.has(key))
}

function folderConflictMessage(name: string, folderId: string): string {
  const descendants = collectFolderDescendants([folderId], store.folders)
  const hostCount = collectFolderHostIds(descendants, store.hosts).length
  return `目标位置已存在同名文件夹 "${name}"，其中包含 ${hostCount} 个主机、${descendants.size - 1} 个子文件夹，替换后原内容将被删除且无法恢复。是否替换？`
}

async function pasteConnections(targetKey?: string): Promise<void> {
  const clipboard = store.connectionClipboard
  if (!clipboard?.nodeKeys.length) return
  const keys = clipboard.nodeKeys
  const clipboardSet = new Set(keys)
  const targetFolderId = resolvePasteFolderId(targetKey, clipboardSet, store.folders, store.hosts)
  if (targetFolderId !== null && !store.folders.some((folder) => folder.id === targetFolderId)) {
    await alertDialog('无法粘贴', '目标文件夹已不存在。')
    return
  }
  if (!canMoveToFolder(clipboardSet, targetFolderId, store.folders)) {
    await alertDialog('无法粘贴', '目标位置在被粘贴文件夹的内部。')
    return
  }
  const produced: string[] = []
  let conflictPreset: boolean | undefined
  try {
    for (const key of keys) {
      const parsed = parseNodeKey(key)
      if (!parsed) continue
      const item = parsed.kind === 'folder'
        ? store.folders.find((folder) => folder.id === parsed.id)
        : store.hosts.find((host) => host.id === parsed.id)
      if (!item) continue
      if (clipboard.mode === 'copy') {
        const name = resolveCopyName(item.name, siblingNames(targetFolderId, store.folders, store.hosts))
        const cloned = cloneConnectionNodes(key, targetFolderId, name, store.folders, store.hosts)
        if (!cloned) continue
        for (const folder of cloned.folders) await createFolder(folder)
        for (const host of cloned.hosts) await createHost(host)
        for (const pair of cloned.credentialPairs) {
          const credential = await loadCredentialRecord(pair.from)
          if (credential) await saveCredentialRecord(pair.to, credential)
        }
        produced.push(cloned.rootKey)
        continue
      }
      const parentId = parsed.kind === 'folder'
        ? (item as { parentId: string | null }).parentId
        : (item as { folderId: string | null }).folderId
      if (parentId === targetFolderId) continue
      const conflict = findSiblingNameConflict(item.name, targetFolderId, store.folders, store.hosts, parsed.id)
      if (conflict) {
        const conflictIsFolder = 'parentId' in conflict
        if (conflictIsFolder !== (parsed.kind === 'folder')) {
          await alertDialog('无法粘贴', `目标位置已存在同名${conflictIsFolder ? '文件夹' : '主机'} "${item.name}"，不能替换。`)
          continue
        }
        if (conflictIsFolder && keys.some((entry) => nodeInsideFolder(entry, conflict.id, store.folders, store.hosts))) {
          await alertDialog('无法替换', `同名文件夹 "${item.name}" 包含被移动的项目，不能替换。`)
          continue
        }
        let replace = conflictPreset
        if (replace === undefined) {
          const message = conflictIsFolder
            ? folderConflictMessage(item.name, conflict.id)
            : `目标位置已存在同名主机 "${item.name}"，替换后原配置及其凭据将被删除且无法恢复。是否替换？`
          const result = await confirmCheckboxDialog('替换确认', message, {
            confirmLabel: '替换',
            cancelLabel: '取消',
            danger: true,
            checkboxLabel: '对本次操作中的其余冲突执行相同操作',
          })
          replace = result.confirmed
          if (result.checked) conflictPreset = result.confirmed
        }
        if (!replace) continue
        if (conflictIsFolder) await deleteFolders([conflict.id])
        else await deleteHosts([conflict.id])
      }
      await moveConnectionNodes(new Set([key]), targetFolderId)
      produced.push(key)
    }
  } finally {
    if (clipboard.mode === 'cut') store.connectionClipboard = null
  }
  if (targetFolderId !== null && produced.length) {
    const expanded = new Set(store.expandedFolderIds)
    expanded.add(targetFolderId)
    store.expandedFolderIds = expanded
  }
  if (produced.length) selectNodeKeys(produced)
}

registerAction({
  id: 'conn.copy',
  title: clipboardTitle('复制'),
  description: '复制选中的主机或文件夹',
  category: 'workbench',
  when: 'area == "host"',
  enablement: (ctx) => (ctx.selectedNodeIds?.length ?? 0) > 0,
  run: (ctx) => {
    const keys = selectedKeys(ctx)
    if (!keys.size) return
    store.connectionClipboard = { version: 1, mode: 'copy', nodeKeys: Array.from(keys), createdAt: Date.now() }
  },
  keybindings: [{ key: 'Mod+C', when: 'area == "host"' }],
  menus: [
    { menuId: MenuId.HostContext, order: 25 },
    { menuId: MenuId.FolderContext, group: '2_clipboard', order: 10 },
  ],
})

registerAction({
  id: 'conn.cut',
  title: clipboardTitle('剪切'),
  description: '剪切选中的主机或文件夹',
  category: 'workbench',
  when: 'area == "host"',
  enablement: (ctx) => (ctx.selectedNodeIds?.length ?? 0) > 0,
  run: (ctx) => {
    const keys = selectedKeys(ctx)
    if (!keys.size) return
    store.connectionClipboard = { version: 1, mode: 'cut', nodeKeys: Array.from(keys), createdAt: Date.now() }
  },
  keybindings: [{ key: 'Mod+X', when: 'area == "host"' }],
  menus: [
    { menuId: MenuId.HostContext, order: 26 },
    { menuId: MenuId.FolderContext, group: '2_clipboard', order: 20 },
  ],
})

registerAction({
  id: 'conn.paste',
  title: '粘贴',
  description: '粘贴连接剪贴板中的主机或文件夹',
  category: 'workbench',
  when: (ctx) => ctx.area === 'host' && !!store.connectionClipboard?.nodeKeys.length,
  run: async (ctx) => {
    await pasteConnections(ctx.targetNodeKey ?? keyboardTargetKey())
  },
  keybindings: [{ key: 'Mod+V', when: 'area == "host"' }],
  menus: [
    { menuId: MenuId.HostContext, order: 27 },
    { menuId: MenuId.FolderContext, group: '2_clipboard', order: 30 },
    { menuId: MenuId.RootContext, group: '2_clipboard', order: 10 },
  ],
})

registerAction({
  id: 'conn.cancelCut',
  title: '取消剪切',
  description: '取消连接列表中的剪切标记',
  category: 'workbench',
  when: (ctx) => ctx.area === 'host' && store.connectionClipboard?.mode === 'cut',
  run: () => {
    store.connectionClipboard = null
  },
  keybindings: [{ key: 'Escape', when: 'area == "host"' }],
})
