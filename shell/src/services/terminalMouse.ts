import type { IDisposable, Terminal } from '@xterm/xterm'

/** Keep wheel gestures in the local viewport, including remote mouse modes. */
export function attachTerminalWheelScrolling(terminal: Terminal): IDisposable {
  const element = terminal.element!
  const screen = element.querySelector<HTMLElement>('.xterm-screen')!
  let remainder = 0

  function onWheel(event: WheelEvent) {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (!event.deltaY) return

    const buffer = terminal.buffer.active
    if ((event.deltaY < 0 && buffer.viewportY === 0)
      || (event.deltaY > 0 && buffer.viewportY === buffer.baseY)) {
      remainder = 0
      return
    }

    const cellHeight = screen.getBoundingClientRect().height / terminal.rows
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? terminal.rows : 1 / cellHeight
    const sensitivity = (terminal.options.scrollSensitivity ?? 1)
      * (event.altKey ? terminal.options.fastScrollSensitivity ?? 5 : 1)
    if (Math.sign(remainder) !== Math.sign(event.deltaY)) remainder = 0
    remainder += event.deltaY * unit * sensitivity
    const lines = Math.trunc(remainder)
    remainder -= lines
    if (lines) terminal.scrollLines(lines)
  }

  // Capture before both xterm's viewport and its PTY mouse/key translation.
  element.addEventListener('wheel', onWheel, { capture: true, passive: false })
  return { dispose: () => element.removeEventListener('wheel', onWheel, true) }
}
