import { store } from '../stores/app'
import { closeTabs } from './ws'
import { registerAction } from './commands'
import type { CommandContext } from './context'
import { MenuId } from './actions/menuIds'

function getTab(ctx: CommandContext) {
  return ctx.tabId ? store.tabs.find((tab) => tab.id === ctx.tabId) : undefined
}

function getGroupTabIds(ctx: CommandContext): string[] {
  const ids = ctx.tabGroupTabIds ?? (ctx.tabId ? [ctx.tabId] : [])
  return ids.filter((id) => store.tabs.some((tab) => tab.id === id))
}

function getTargetIndex(ctx: CommandContext, ids: string[]): number {
  return ctx.tabId ? ids.indexOf(ctx.tabId) : -1
}

registerAction({
  id: 'tab.close',
  title: '关闭',
  description: '关闭当前标签',
  category: 'workbench',
  when: 'tabExists',
  enablement: (ctx) => !!getTab(ctx),
  run: (ctx) => {
    if (ctx.tabId) closeTabs([ctx.tabId])
  },
  keybindings: [{ key: 'Mod+W', when: '!modalOpen' }],
  menus: [{ menuId: MenuId.TabContext, group: '1_tab', order: 10 }],
})

registerAction({
  id: 'tab.closeOthers',
  title: '关闭其他',
  description: '关闭当前标签组中的其他标签',
  category: 'workbench',
  when: 'area == "tab"',
  enablement: (ctx) => {
    const ids = getGroupTabIds(ctx)
    return !!getTab(ctx) && ids.length > 1 && getTargetIndex(ctx, ids) !== -1
  },
  run: (ctx) => {
    if (!ctx.tabId) return
    closeTabs(getGroupTabIds(ctx).filter((id) => id !== ctx.tabId))
  },
  menus: [{ menuId: MenuId.TabContext, group: '1_tab', order: 20 }],
})

registerAction({
  id: 'tab.closeToRight',
  title: '关闭右侧',
  description: '关闭当前标签右侧的标签',
  category: 'workbench',
  when: 'area == "tab"',
  enablement: (ctx) => {
    const ids = getGroupTabIds(ctx)
    const index = getTargetIndex(ctx, ids)
    return !!getTab(ctx) && index !== -1 && index < ids.length - 1
  },
  run: (ctx) => {
    const ids = getGroupTabIds(ctx)
    const index = getTargetIndex(ctx, ids)
    if (index !== -1) closeTabs(ids.slice(index + 1))
  },
  menus: [{ menuId: MenuId.TabContext, group: '1_tab', order: 30 }],
})

registerAction({
  id: 'tab.closeAll',
  title: '关闭全部',
  description: '关闭当前标签组的全部标签',
  category: 'workbench',
  when: 'area == "tab"',
  enablement: (ctx) => getGroupTabIds(ctx).length > 0 && !!getTab(ctx),
  run: (ctx) => closeTabs(getGroupTabIds(ctx)),
  menus: [{ menuId: MenuId.TabContext, group: '1_tab', order: 40 }],
})

registerAction({
  id: 'tab.editHost',
  title: '编辑主机',
  description: '编辑当前标签对应的主机配置',
  category: 'workbench',
  when: (ctx) => {
    const tab = getTab(ctx)
    return !!tab && store.hosts.some((host) => host.id === tab.hostId)
  },
  enablement: 'area == "tab"',
  run: (ctx) => {
    const tab = getTab(ctx)
    if (!tab) return
    const host = store.hosts.find((item) => item.id === tab.hostId)
    if (!host) return
    store.editingHostId = host.id
    store.connectionModalOpen = true
  },
  menus: [{ menuId: MenuId.TabContext, group: '2_host', order: 10 }],
})

export { TAB_MENU_ID } from './actions/menuIds'
