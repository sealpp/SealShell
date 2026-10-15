import { store } from '../stores/app'
import { menuRegistry, registerAction } from './commands'
import { MenuId } from './actions/menuIds'

registerAction({
  id: 'workbench.openKeyboardShortcuts',
  title: '键盘快捷键',
  description: '查看和配置键盘快捷键',
  category: 'workbench',
  run: () => {
    store.aboutModalOpen = false
    store.settingsModalOpen = false
    store.keyboardShortcutsModalOpen = true
  },
  menus: [{ menuId: MenuId.Workbench, group: '1_settings', order: 5 }],
})

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

registerAction({
  id: 'workbench.togglePanel',
  title: '系统监控',
  description: '显示或隐藏系统监控面板',
  category: 'workbench',
  checked: 'panelOpen',
  run: () => {
    store.panelOpen = !store.panelOpen
  },
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
  },
})

export const WORKBENCH_MENU_ID = MenuId.Workbench
