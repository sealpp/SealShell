import type { IBuffer, IMarker, Terminal } from '@xterm/xterm'
import { canRememberCommand, COMMAND_LENGTH_LIMIT } from './model'

interface PromptAnchor {
  marker: IMarker
  prefix: string
}

export interface CommandLineSnapshot {
  command: string
  row: number
  column: number
}

// Recognize a small set of visible shell prompts. A continuation prompt ('> ')
// and arbitrary application input are deliberately not treated as a shell.
export function isShellPrompt(text: string): boolean {
  return /^(?:[#$%❯➜] |(?:\([^()\r\n]*\) )?(?:\[[^\r\n]+\]|[\w.-]+@[\w.-]+[^\r\n]*|[\w.-]+|[~/][^\r\n]*)[#$%❯] )$/.test(text)
}

function wrappedRowText(buffer: IBuffer, row: number, columns: number): string {
  const line = buffer.getLine(row)!
  const next = buffer.getLine(row + 1)
  const last = line.getCell(columns - 1)
  // A wide glyph moved to the next row leaves one null padding cell behind.
  // Preserve actual spaces, but do not insert that padding into the command.
  const padding = next?.isWrapped && next.getCell(0)?.getWidth() === 2
    && last?.getWidth() === 1 && last.getChars() === ''
  return line.translateToString(false, 0, columns - (padding ? 1 : 0))
}

function readAnchoredLine(buffer: IBuffer, anchor: PromptAnchor, columns: number): { text: string; endRow: number } | undefined {
  let row = anchor.marker.line
  if (row < 0) return undefined
  let text = ''
  while (row < buffer.length) {
    const line = buffer.getLine(row)
    if (!line) return undefined
    const wrapped = buffer.getLine(row + 1)?.isWrapped ?? false
    text += wrapped ? wrappedRowText(buffer, row, columns) : line.translateToString(true, 0, columns)
    if (text.length > COMMAND_LENGTH_LIMIT + anchor.prefix.length) return undefined
    if (!wrapped) return text.startsWith(anchor.prefix) ? { text, endRow: row } : undefined
    row++
  }
  return undefined
}

/** Observe echoed buffer text; never construct history from raw keystrokes. */
export class TerminalCommandLine {
  private anchor?: PromptAnchor
  private submitted?: PromptAnchor
  private edited = false
  private expectedCommand?: string
  private awaitingEdit = false

  constructor(private terminal: Terminal, private onCommand: (command: string) => void) {}

  input(data: string): void {
    if (data === '\r') {
      this.submitted?.marker.dispose()
      this.submitted = this.edited ? this.anchor : undefined
      if (!this.edited) this.anchor?.marker.dispose()
      this.anchor = undefined
      this.edited = false
      this.expectedCommand = undefined
      this.awaitingEdit = false
    } else if (/[\r\n\x03\x04\x12\x1a]/.test(data) || data.includes('\x1b[200~')) {
      // Multiline paste, interrupt, EOF, reverse search and suspended jobs do
      // not have a reliably known single command line.
      this.reset()
    } else if (this.anchor) {
      this.edited = true
      if (data === '\x1b[C' || data === '\x1bOC') {
        const line = this.readLine()
        // Right can accept a remote suggestion. Use the visible line end as
        // a target; resume only after a new edit and its complete echo agree.
        if (line && (this.expectedCommand === undefined || line.command === this.expectedCommand)) {
          this.expectedCommand = line.command + line.tail.trimEnd()
        }
        this.awaitingEdit = true
      } else if (this.expectedCommand !== undefined) {
        if (!/[\x00-\x1f\x7f]/.test(data)) {
          this.expectedCommand += data
          this.awaitingEdit = false
        } else if (data === '\x7f') {
          this.expectedCommand = Array.from(this.expectedCommand).slice(0, -1).join('')
          this.awaitingEdit = false
        } else this.expectedCommand = undefined
      }
    }
  }

  update(): void {
    const terminal = this.terminal
    const buffer = terminal.buffer.normal
    if (this.submitted) {
      const line = readAnchoredLine(buffer, this.submitted, terminal.cols)
      if (!line || buffer.baseY + buffer.cursorY > line.endRow || terminal.buffer.active.type === 'alternate') {
        if (line) {
          const command = line.text.slice(this.submitted.prefix.length)
          if (canRememberCommand(command)) this.onCommand(command)
        }
        this.submitted.marker.dispose()
        this.submitted = undefined
      }
    }
    if (terminal.buffer.active.type !== 'normal' || terminal.modes.mouseTrackingMode !== 'none') {
      this.clearAnchor()
      return
    }
    if (this.anchor) {
      const line = readAnchoredLine(buffer, this.anchor, terminal.cols)
      const cursorRow = buffer.baseY + buffer.cursorY
      if (!line || cursorRow < this.anchor.marker.line || cursorRow > line.endRow) this.clearAnchor()
    }
    if (!this.anchor && !this.submitted) {
      const row = buffer.baseY + buffer.cursorY
      const line = buffer.getLine(row)
      if (!line || line.isWrapped || line.translateToString(true, buffer.cursorX).trimEnd()) return
      const prefix = line.translateToString(false, 0, buffer.cursorX)
      if (!isShellPrompt(prefix)) return
      const marker = terminal.registerMarker(0)
      if (marker) { this.anchor = { marker, prefix }; this.expectedCommand = '' }
    }
  }

  snapshot(): CommandLineSnapshot | undefined {
    if (this.awaitingEdit) return undefined
    const line = this.readLine()
    // A slow echo may still show an earlier prefix while newer input is in
    // flight. Text after the cursor may be a remote autosuggestion; the local
    // list uses only the echoed prefix that agrees with our known input.
    if (!line || line.command !== this.expectedCommand) return undefined
    return { command: line.command, row: line.row, column: line.column }
  }

  private readLine(): (CommandLineSnapshot & { tail: string }) | undefined {
    const buffer = this.terminal.buffer.active
    if (!this.anchor || buffer.type !== 'normal' || buffer.viewportY !== buffer.baseY) return undefined
    const cursorRow = buffer.baseY + buffer.cursorY
    const line = readAnchoredLine(buffer, this.anchor, this.terminal.cols)
    if (!line || cursorRow < this.anchor.marker.line || cursorRow > line.endRow) return undefined
    const lastLine = buffer.getLine(cursorRow)!
    let beforeCursor = ''
    for (let row = this.anchor.marker.line; row < cursorRow; row++) beforeCursor += wrappedRowText(buffer, row, this.terminal.cols)
    beforeCursor += lastLine.translateToString(false, 0, buffer.cursorX)
    if (!beforeCursor.startsWith(this.anchor.prefix)) return undefined
    return {
      command: beforeCursor.slice(this.anchor.prefix.length),
      tail: line.text.slice(beforeCursor.length),
      row: buffer.cursorY,
      column: buffer.cursorX,
    }
  }

  private clearAnchor(): void {
    this.anchor?.marker.dispose()
    this.anchor = undefined
    this.edited = false
    this.expectedCommand = undefined
    this.awaitingEdit = false
  }

  reset(): void {
    this.clearAnchor()
    this.submitted?.marker.dispose()
    this.submitted = undefined
  }
}
