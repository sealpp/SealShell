export const MenuId = {
  Workbench: 'workbench.activity',
  HostContext: 'host.context',
  FolderContext: 'folder.context',
  RootContext: 'root.context',
  TabContext: 'tab.context',
  TerminalContext: 'terminal.context',
  TerminalCopy: 'terminal.copy',
  TerminalPaste: 'terminal.paste',
  TerminalEncoding: 'terminal.encoding',
  FileContext: 'file.context',
  FileInstances: 'file.instances',
} as const

export const HOST_MENU_ID = MenuId.HostContext
export const FOLDER_MENU_ID = MenuId.FolderContext
export const ROOT_MENU_ID = MenuId.RootContext
export const TAB_MENU_ID = MenuId.TabContext
export const TERMINAL_MENU_ID = MenuId.TerminalContext
export const FILE_MENU_ID = MenuId.FileContext
