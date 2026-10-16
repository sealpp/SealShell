import { getActiveBottomPanelTabId, setBottomPanelActiveTab, store, type BottomPanelCategory } from '../stores/app'
import { menuRegistry, registerAction } from './commands'
import { MenuId } from './actions/menuIds'

registerAction({
  id: 'workbench.openSettings',
  title: '设置',
  description: '打开设置',
  category: 'workbench',
  run: () => {
    store.aboutModalOpen = false
    store.settingsModalOpen = true
  },
  menus: [{ menuId: MenuId.Workbench, group: '1_settings', order: 10 }],
})

registerAction({
  id: 'workbench.openAbout',
  title: '关于',
  description: '查看 SealShell 信息',
  category: 'workbench',
  run: () => {
    store.settingsModalOpen = false
    store.aboutModalOpen = true
  },
  menus: [{ menuId: MenuId.Workbench, group: '2_about', order: 10 }],
})

menuRegistry.appendSeparator(MenuId.Workbench, 'workbench.settings-separator', '2_about', 0)

registerAction({
  id: 'workbench.toggleConnections',
  title: '会话',
  description: '显示或隐藏会话侧栏',
  category: 'workbench',
  checked: 'sidebarOpen',
  run: () => {
    if (store.sidebarOpen && store.sidebarView === 'connections') store.sidebarOpen = false
    else {
      store.sidebarOpen = true
      store.sidebarView = 'connections'
    }
  },
})

function toggleCategory(category: BottomPanelCategory): void {
  if (store.bottomPanelOpen && store.bottomPanelCategory === category) store.bottomPanelOpen = false
  else {
    setBottomPanelActiveTab(getActiveBottomPanelTabId(category), category)
    store.bottomPanelOpen = true
    store.view = 'shell'
  }
}

registerAction({
  id: 'workbench.toggleFileManager', title: '文件管理', description: '显示或隐藏最近使用的文件视图', category: 'workbench',
  run: () => toggleCategory(store.lastFilePanelCategory),
})

registerAction({
  id: 'workbench.toggleMonitoring', title: '性能监测', description: '显示或隐藏性能监测视图', category: 'workbench',
  run: () => toggleCategory('monitors'),
})

registerAction({
  id: 'workbench.togglePorts', title: '端口转发', description: '显示或隐藏端口转发视图', category: 'workbench',
  run: () => toggleCategory('ports'),
})

registerAction({
  id: 'workbench.toggleBottomPanel',
  title: '面板',
  description: '显示或隐藏底部面板',
  category: 'workbench',
  checked: 'bottomPanelOpen',
  keybindings: [{ key: 'Mod+J' }],
  run: () => {
    store.bottomPanelOpen = !store.bottomPanelOpen
    if (store.bottomPanelOpen) store.view = 'shell'
  },
})

export const WORKBENCH_MENU_ID = MenuId.Workbench
