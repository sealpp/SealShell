import { store } from '../stores/app'
import { createFolder } from './ws'
import { registerAction } from './commands'
import { MenuId } from './actions/menuIds'
import { randomId } from '../utils/id'

registerAction({
  id: 'folder.new',
  title: '新建文件夹',
  description: '新建连接文件夹',
  category: 'workbench',
  when: 'area == "host"',
  run: (ctx) => {
    store.editingFolderId = ''
    store.folderParentId = ctx.targetFolderId ?? null
    store.folderModalOpen = true
  },
  menus: [
    { menuId: MenuId.FolderContext, group: '1_create', order: 10 },
    { menuId: MenuId.RootContext, group: '1_create', order: 10 },
  ],
})

registerAction({
  id: 'folder.rename',
  title: '重命名',
  description: '重命名文件夹',
  category: 'workbench',
  when: 'area == "host"',
  enablement: 'selectedCount == 1',
  run: (ctx) => {
    const folderId = ctx.selectedIds?.[0]
    if (!folderId || !store.folders.some((folder) => folder.id === folderId)) return
    store.editingFolderId = folderId
    store.folderParentId = store.folders.find((folder) => folder.id === folderId)?.parentId ?? null
    store.folderModalOpen = true
  },
  menus: [{ menuId: MenuId.FolderContext, group: '2_edit', order: 10 }],
})

export async function saveNewFolder(name: string): Promise<void> {
  const parentId = store.folderParentId
  await createFolder({ id: randomId(), name, parentId })
  if (parentId !== null) {
    const expanded = new Set(store.expandedFolderIds)
    expanded.add(parentId)
    store.expandedFolderIds = expanded
  }
}

export async function saveRenamedFolder(name: string): Promise<void> {
  const folder = store.folders.find((item) => item.id === store.editingFolderId)
  if (!folder) return
  await createFolder({ ...folder, name })
}

