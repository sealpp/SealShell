import { writeToClipboard } from '../../utils/clipboard'
import { store, type FileTab } from '../../stores/app'
import { registerAction } from '../commands'
import { MenuId } from '../actions/menuIds'
import { copySelectedFileEntries, deleteFileEntries, navigateFileTab, navigateParentFileTab, pasteFileTab, refreshFileTab, renameFileEntry } from './file-tabs'
import { openEditorTab } from './editor-tabs'
import { alertDialog, confirmDialog, promptDialog } from '../dialogs'

function getFileTab(tabId?: string): FileTab | undefined {
  const tab = tabId ? store.tabs.find((candidate) => candidate.id === tabId) : undefined
  return tab?.kind === 'file' ? tab as FileTab : undefined
}

function selectedPaths(ctx: { tabId?: string; selectedPaths?: string[] }): string[] {
  return ctx.selectedPaths ?? getFileTab(ctx.tabId)?.file.selectedPaths ?? []
}

registerAction({
  id: 'file.open',
  title: '打开',
  description: '打开远端文件或进入目录',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => !!ctx.filePath,
  run: async (ctx) => {
    const tab = getFileTab(ctx.tabId)
    if (!tab || !ctx.filePath) return
    const entry = tab.file.entries.find((candidate) => candidate.path === ctx.filePath)
    if (!entry) return
    if (entry.kind === 'directory') await navigateFileTab(tab.id, entry.path)
    else if (entry.kind === 'file' || entry.kind === 'symlink') await openEditorTab(tab.id, entry)
  },
  menus: [{ menuId: MenuId.FileContext, order: 10 }],
})

registerAction({
  id: 'file.copy',
  title: '复制',
  description: '复制选中的远端项目',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => selectedPaths(ctx).length > 0,
  run: (ctx) => { if (ctx.tabId) copySelectedFileEntries(ctx.tabId, 'copy') },
  keybindings: [{ key: 'Mod+C', when: 'area == "file"' }],
  menus: [{ menuId: MenuId.FileContext, order: 20 }],
})

registerAction({
  id: 'file.cut',
  title: '剪切',
  description: '剪切选中的远端项目',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => selectedPaths(ctx).length > 0,
  run: (ctx) => { if (ctx.tabId) copySelectedFileEntries(ctx.tabId, 'cut') },
  keybindings: [{ key: 'Mod+X', when: 'area == "file"' }],
  menus: [{ menuId: MenuId.FileContext, order: 30 }],
})

registerAction({
  id: 'file.paste',
  title: '粘贴',
  description: '粘贴应用内部的远端剪贴板',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => !!ctx.canPasteFiles,
  run: async (ctx) => { if (ctx.tabId) await pasteFileTab(ctx.tabId) },
  keybindings: [{ key: 'Mod+V', when: 'area == "file"' }],
  menus: [{ menuId: MenuId.FileContext, order: 40 }],
})

registerAction({
  id: 'file.rename',
  title: '重命名',
  description: '重命名远端项目',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => selectedPaths(ctx).length === 1,
  run: async (ctx) => {
    const path = selectedPaths(ctx)[0]
    const name = await promptDialog('重命名', path?.slice(path.lastIndexOf('/') + 1) ?? '', { message: path ?? '请输入新的文件名' })
    if (ctx.tabId && name !== null && path) await renameFileEntry(ctx.tabId, path, name)
  },
  keybindings: [{ key: 'F2' }],
  menus: [{ menuId: MenuId.FileContext, order: 50 }],
})

registerAction({
  id: 'file.delete',
  title: '删除',
  description: '递归删除选中的远端项目',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => selectedPaths(ctx).length > 0,
  run: async (ctx) => {
    if (!ctx.tabId) return
    if (!await confirmDialog('确认删除', `确认递归删除 ${selectedPaths(ctx).length} 个项目？`, { confirmLabel: '删除', danger: true })) return
    await deleteFileEntries(ctx.tabId, selectedPaths(ctx))
  },
  keybindings: [
    { key: 'Delete', when: 'area == "file"' },
    { key: 'Backspace', when: 'area == "file"' },
  ],
  menus: [{ menuId: MenuId.FileContext, order: 60 }],
})

registerAction({
  id: 'file.copyPath',
  title: '复制路径',
  description: '复制选中项目的远端绝对路径',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => selectedPaths(ctx).length > 0,
  run: async (ctx) => { await writeToClipboard(selectedPaths(ctx).join('\n')) },
  menus: [{ menuId: MenuId.FileContext, order: 70 }],
})

registerAction({
  id: 'file.properties',
  title: '属性',
  description: '查看远端项目属性',
  category: 'workbench',
  when: 'area == "file"',
  enablement: (ctx) => selectedPaths(ctx).length === 1,
  run: async (ctx) => {
    const tab = getFileTab(ctx.tabId)
    const entry = tab?.file.entries.find((candidate) => candidate.path === selectedPaths(ctx)[0])
    if (entry) await alertDialog('属性', `${entry.name}\n${entry.path}\n${entry.kind}\n${entry.size} bytes`)
  },
  menus: [{ menuId: MenuId.FileContext, order: 80 }],
})

registerAction({
  id: 'file.refresh',
  title: '刷新',
  description: '刷新当前远端目录',
  category: 'workbench',
  when: 'area == "file"',
  run: async (ctx) => { if (ctx.tabId) await refreshFileTab(ctx.tabId) },
  keybindings: [{ key: 'F5' }],
  menus: [{ menuId: MenuId.FileContext, order: 90 }],
})

registerAction({
  id: 'file.parent',
  title: '进入上级目录',
  description: '进入当前目录的上级目录',
  category: 'workbench',
  when: 'area == "file"',
  run: async (ctx) => { if (ctx.tabId) await navigateParentFileTab(ctx.tabId) },
  keybindings: [{ key: 'Alt+ArrowUp' }],
  menus: [{ menuId: MenuId.FileContext, order: 100 }],
})
