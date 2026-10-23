import { store } from '../../stores/app'
import { registerAction } from '../commands'
import { MenuId } from '../actions/menuIds'
import type { CommandContext } from '../context'
import { openProcesses } from './runtime'

function hostId(ctx: CommandContext): string | undefined {
  if (ctx.area === 'host') return ctx.selectedIds?.length === 1 ? ctx.selectedIds[0] : undefined
  return store.tabs.find(tab => tab.id === ctx.tabId && tab.kind === 'terminal')?.hostId
}
registerAction({
  id: 'processes.open', title: '打开进程管理', description: '打开或定位会话的独立进程管理', category: 'workbench',
  enablement: ctx => {
    const id = hostId(ctx)
    return !!id && (store.hosts.some(host => host.id === id) || store.tabs.some(tab => tab.kind === 'process' && tab.hostId === id))
  },
  run: ctx => { const id = hostId(ctx); if (id) openProcesses(id) },
  menus: [{ menuId: MenuId.HostContext, order: 17 }, { menuId: MenuId.TerminalContext, order: 18 }],
})
