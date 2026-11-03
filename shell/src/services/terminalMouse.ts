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

/** Start xterm's native selection scrolling just inside the screen edges. */
export function attachTerminalSelectionScrolling(terminal: Terminal): IDisposable {
  const screen = terminal.element!.querySelector<HTMLElement>('.xterm-screen')!
  const document = screen.ownerDocument
  const view = document.defaultView!
  let dragging = false
  let translatedMove: MouseEvent | undefined

  function stopDrag() {
    dragging = false
    translatedMove = undefined
    document.removeEventListener('mousemove', onMove, true)
    document.removeEventListener('mouseup', stopDrag, true)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    view.removeEventListener('blur', cancelDrag)
  }

  function cancelDrag() {
    if (!dragging) return
    stopDrag()
    // Release xterm's document listeners and scroll timer if mouseup was lost.
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  }

  function onVisibilityChange() {
    if (document.hidden) cancelDrag()
  }

  function onMove(event: MouseEvent) {
    if (event === translatedMove) return
    if (!(event.buttons & 1) || !screen.isConnected) { cancelDrag(); return }

    const rect = screen.getBoundingClientRect()
    const edge = Math.min(24, rect.height / terminal.rows * 1.5)
    let clientY = event.clientY
    if (clientY >= rect.top && clientY < rect.top + edge) {
      clientY = rect.top - 1 - (rect.top + edge - clientY) / 4
    } else if (clientY <= rect.bottom && clientY > rect.bottom - edge) {
      clientY = rect.bottom + 1 + (clientY - rect.bottom + edge) / 4
    } else return

    // Translate only the edge coordinates. xterm keeps ownership of the anchor,
    // word/line/column modes, wide cells, scroll speed and continuous extension.
    translatedMove = new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, view,
      clientX: event.clientX, clientY,
      button: event.button, buttons: event.buttons,
      altKey: event.altKey, ctrlKey: event.ctrlKey,
      metaKey: event.metaKey, shiftKey: event.shiftKey,
    })
    event.stopImmediatePropagation()
    document.dispatchEvent(translatedMove)
  }

  function onDown(event: MouseEvent) {
    if (event.button !== 0 || (terminal.modes.mouseTrackingMode !== 'none' && !event.shiftKey)) return
    cancelDrag()
    dragging = true
    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', stopDrag, true)
    document.addEventListener('visibilitychange', onVisibilityChange)
    view.addEventListener('blur', cancelDrag)
  }

  screen.addEventListener('mousedown', onDown)
  terminal.textarea!.addEventListener('blur', cancelDrag)
  return { dispose: () => {
    cancelDrag()
    terminal.textarea!.removeEventListener('blur', cancelDrag)
    screen.removeEventListener('mousedown', onDown)
  } }
}
