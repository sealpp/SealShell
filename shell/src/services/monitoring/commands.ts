import { store } from '../../stores/app'
import { registerAction } from '../commands'
import { MenuId } from '../actions/menuIds'
import type { CommandContext } from '../context'
import { openMonitor } from './runtime'

function hostId(ctx: CommandContext): string | undefined {
  if (ctx.area === 'host') return ctx.selectedIds?.length === 1 ? ctx.selectedIds[0] : undefined
  const tab = store.tabs.find(tab => tab.id === ctx.tabId && tab.kind === 'terminal')
  return tab?.hostId
}

registerAction({
  id: 'monitor.open', title: '打开性能监测', description: '打开或定位会话的独立性能监测', category: 'workbench',
  enablement: ctx => {
    const id = hostId(ctx)
    return !!id && (store.hosts.some(host => host.id === id) || store.tabs.some(tab => tab.kind === 'monitor' && tab.hostId === id))
  },
  run: ctx => { const id = hostId(ctx); if (id) openMonitor(id) },
  menus: [
    { menuId: MenuId.HostContext, order: 15 },
    { menuId: MenuId.TerminalContext, order: 16 },
  ],
})
