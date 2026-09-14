import { store } from '../stores/app'
import { connectHost } from './ws'
import { registerAction } from './commands'
import { MenuId } from './actions/menuIds'

registerAction({
  id: 'host.new',
  title: '新建连接',
  description: '新建主机连接配置',
  category: 'workbench',
  run: (ctx) => {
    store.editingHostId = ''
    store.newHostFolderId = ctx.targetFolderId ?? null
    store.connectionModalOpen = true
  },
  menus: [
    { menuId: MenuId.FolderContext, group: '1_create', order: 20 },
    { menuId: MenuId.RootContext, group: '1_create', order: 20 },
  ],
})

registerAction({
  id: 'host.connect',
  title: '连接',
  description: '连接选中的主机',
  category: 'workbench',
  when: 'area == "host"',
  enablement: 'selectedCount == 1',
  run: (ctx) => {
    const hostId = ctx.selectedIds?.[0]
    if (!hostId) return
    const host = store.hosts.find((item) => item.id === hostId)
    if (host) void connectHost(host)
  },
  menus: [{ menuId: MenuId.HostContext, order: 10 }],
})

registerAction({
  id: 'host.edit',
  title: '编辑',
  description: '编辑选中的主机配置',
  category: 'workbench',
  when: 'area == "host"',
  enablement: 'selectedCount == 1',
  run: (ctx) => {
    const hostId = ctx.selectedIds?.[0]
    if (!hostId || !store.hosts.some((host) => host.id === hostId)) return
    store.editingHostId = hostId
    store.connectionModalOpen = true
  },
  menus: [{ menuId: MenuId.HostContext, order: 20 }],
})

export { HOST_MENU_ID } from './actions/menuIds'
