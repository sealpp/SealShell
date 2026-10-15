import type { Terminal } from '@xterm/xterm'

function isUsableDirectory(value: string): boolean {
  return value.startsWith('/') && !/[\x00-\x1f\x7f]/.test(value)
}

export function parseTerminalDirectory(code: number, value: string): string | undefined {
  let directory: string
  if (code === 7) {
    if (value.startsWith('/')) {
      directory = value
    } else {
      try {
        const uri = new URL(value)
        if (uri.protocol !== 'file:') return undefined
        directory = decodeURIComponent(uri.pathname)
      } catch {
        return undefined
      }
    }
  } else if (code === 1337 && value.startsWith('CurrentDir=')) {
    // iTerm2 paths are literal: percent signs and backslashes are not escapes.
    directory = value.slice('CurrentDir='.length)
  } else if (code === 633 && value.startsWith('P;Cwd=')) {
    directory = value.slice('P;Cwd='.length).split(';')[0]!
      .replace(/\\x([0-9a-f]{2})|\\\\/gi, (_, hex: string | undefined) => hex ? String.fromCharCode(parseInt(hex, 16)) : '\\')
  } else {
    return undefined
  }
  return isUsableDirectory(directory) ? directory : undefined
}

export function registerTerminalDirectoryHandlers(terminal: Terminal, onDirectory: (directory: string) => void): void {
  for (const code of [7, 1337, 633]) {
    terminal.parser.registerOscHandler(code, value => {
      const directory = parseTerminalDirectory(code, value)
      if (directory === undefined) return false
      onDirectory(directory)
      return true
    })
  }
}

export function initialDirectoryCommand(directory: string | undefined): string | undefined {
  if (!directory || !isUsableDirectory(directory)) return undefined
  // A leading space avoids history entries when HISTCONTROL includes ignorespace.
  return ` cd -- '${directory.replace(/'/g, "'\\''")}'\r`
}
