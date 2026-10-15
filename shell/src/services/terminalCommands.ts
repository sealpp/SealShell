import type { Terminal } from '@xterm/xterm'
import { store } from '../stores/app'
import { closeTab, connectHost, createHost } from './ws'
import { writeToClipboard, readFromClipboard } from '../utils/clipboard'
import { getBufferText, getScreenText, getSelectedText } from '../utils/terminalText'
import type { CommandContext } from './context'
import { registerAction, registerSubmenu } from './commands'
import { MenuId } from './actions/menuIds'
import { createFileTab } from './sftp/file-tabs'
import { normalizeRemotePath } from './sftp/path'
import { ENCODINGS } from './encodings'

// Applies an encoding to the current tab only and persists it on the host so
// tabs opened later inherit it; other open tabs keep their own decoder.
export function setTerminalEncoding(tabId: string | undefined, encoding: string): void {
  const tab = store.tabs.find((item) => item.id === tabId)
  if (!tab) return
  tab.encoding = encoding
  const host = store.hosts.find((item) => item.id === tab.hostId)
  if (host) void createHost({ ...host, encoding })
}

function getTab(ctx: CommandContext) {
  return store.tabs.find((tab) => tab.id === ctx.tabId)
}

function getTerminal(ctx: CommandContext): Terminal | undefined {
  return ctx.terminal
}

registerSubmenu({ id: MenuId.TerminalCopy, title: '复制', parentMenuId: MenuId.TerminalContext, order: 20 })
registerSubmenu({ id: MenuId.TerminalPaste, title: '粘贴', parentMenuId: MenuId.TerminalContext, order: 30 })
registerSubmenu({ id: MenuId.TerminalEncoding, title: '编码', parentMenuId: MenuId.TerminalContext, order: 40 })

registerAction({
  id: 'terminal.newTab',
  title: '新建终端',
  description: '为当前主机新建终端标签',
  category: 'terminal',
  when: 'tabExists',
  run: (ctx) => {
    const tab = getTab(ctx)
    if (!tab) return
    const host = store.hosts.find((item) => item.id === tab.hostId)
    if (host) void connectHost(host, tab.id, { initialCwd: tab.cwd })
  },
  keybindings: [{ key: 'Mod+Backquote' }],
  menus: [{ menuId: MenuId.TerminalContext, order: 10 }],
})

registerAction({
  id: 'terminal.openFiles',
  title: '打开文件列表',
  description: '在当前终端右侧打开 SFTP 文件列表',
  category: 'terminal',
  when: 'tabExists',
  enablement: (ctx) => !!getTab(ctx) && getTab(ctx)?.kind === 'terminal',
  run: (ctx) => {
    const tab = getTab(ctx)
    if (!tab || tab.kind !== 'terminal') return
    const host = store.hosts.find((item) => item.id === tab.hostId)
    if (host) createFileTab(host, tab.id, normalizeRemotePath(tab.cwd ?? '/'))
  },
  menus: [{ menuId: MenuId.TerminalContext, order: 15 }],
})

registerAction({
  id: 'terminal.copySelected',
  title: '复制选中文本',
  description: '复制终端中选中的文本',
  category: 'terminal',
  when: 'area == "terminal"',
  enablement: 'hasSelection == true',
  run: async (ctx) => {
    const terminal = getTerminal(ctx)
    if (!terminal) return
    const text = getSelectedText(terminal)
    if (text) await writeToClipboard(text)
  },
  menus: [{ menuId: MenuId.TerminalCopy, order: 10 }],
})

registerAction({
  id: 'terminal.copyScreen',
  title: '复制当前屏幕',
  description: '复制终端当前屏幕文本',
  category: 'terminal',
  when: 'area == "terminal"',
  run: async (ctx) => {
    const terminal = getTerminal(ctx)
    if (!terminal) return
    const text = getScreenText(terminal)
    if (text) await writeToClipboard(text)
  },
  menus: [{ menuId: MenuId.TerminalCopy, order: 20 }],
})

registerAction({
  id: 'terminal.copyBuffer',
  title: '复制屏幕缓冲区',
  description: '复制终端屏幕缓冲区文本',
  category: 'terminal',
  when: 'area == "terminal"',
  run: async (ctx) => {
    const terminal = getTerminal(ctx)
    if (!terminal) return
    const text = getBufferText(terminal)
    if (text) await writeToClipboard(text)
  },
  menus: [{ menuId: MenuId.TerminalCopy, order: 30 }],
})

registerAction({
  id: 'terminal.pasteFromClipboard',
  title: '粘贴',
  description: '将剪贴板文本粘贴到终端',
  category: 'terminal',
  when: 'area == "terminal"',
  enablement: 'isOnline == true',
  run: async (ctx) => {
    const terminal = getTerminal(ctx)
    if (!terminal) return
    const text = await readFromClipboard()
    if (text !== null) terminal.paste(text)
    else store.manualPaste = { open: true, tabId: ctx.tabId ?? '', context: { ...ctx } }
  },
  menus: [{ menuId: MenuId.TerminalPaste, order: 10 }],
})

registerAction({
  id: 'terminal.pasteManual',
  title: '手动粘贴...',
  description: '手动编辑后粘贴文本到终端',
  category: 'terminal',
  when: 'area == "terminal"',
  enablement: 'isOnline == true',
  run: (ctx) => {
    store.manualPaste = { open: true, tabId: ctx.tabId ?? '', context: { ...ctx } }
  },
  menus: [{ menuId: MenuId.TerminalPaste, order: 20 }],
})

for (const enc of ENCODINGS) {
  registerAction({
    id: `terminal.encoding.${enc.id}`,
    title: enc.label,
    description: `将终端编码切换为 ${enc.label}`,
    category: 'terminal',
    when: 'area == "terminal"',
    enablement: 'tabExists',
    checked: (ctx) => ctx.tabEncoding === enc.id,
    run: (ctx) => setTerminalEncoding(ctx.tabId, enc.id),
    menus: [{ menuId: MenuId.TerminalEncoding, order: ENCODINGS.indexOf(enc) }],
  })
}

registerAction({
  id: 'terminal.sessionInfo',
  title: '终端会话信息',
  description: '查看当前终端会话信息',
  category: 'terminal',
  when: 'area == "terminal"',
  enablement: 'tabExists',
  run: (ctx) => {
    if (ctx.tabId) store.terminalSessionInfo = { open: true, tabId: ctx.tabId }
  },
  menus: [{ menuId: MenuId.TerminalContext, order: 50 }],
})

registerAction({
  id: 'terminal.disconnect',
  title: '断开连接',
  description: '断开当前终端连接',
  category: 'terminal',
  when: 'area == "terminal"',
  enablement: 'tabExists',
  run: (ctx) => {
    if (ctx.tabId) closeTab(ctx.tabId)
  },
  menus: [{ menuId: MenuId.TerminalContext, order: 60 }],
})

export { TERMINAL_MENU_ID } from './actions/menuIds'
