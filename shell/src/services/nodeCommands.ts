import { IconLinkOff, IconPlug } from '../ui/icons'
import { store } from '../stores/app'
import { disconnectNode } from './ws'
import { registerAction } from './commands'
import { MenuId } from './actions/menuIds'

registerAction({
  id: 'node.pair',
  title: (ctx) => ctx.isPaired ? '重新配对' : '配对',
  description: '配对或重新配对 SealNode',
  category: 'workbench',
  icon: IconPlug,
  run: () => {
    store.pairingModalOpen = true
  },
  menus: [{ menuId: MenuId.NodeStatus, order: 10 }],
})

registerAction({
  id: 'node.disconnect',
  title: '断开当前 Node 连接',
  description: '断开当前 SealNode 连接',
  category: 'workbench',
  icon: IconLinkOff,
  when: 'isPaired == true',
  run: () => disconnectNode(),
  menus: [{ menuId: MenuId.NodeStatus, order: 20 }],
})

export { NODE_MENU_ID } from './actions/menuIds'
