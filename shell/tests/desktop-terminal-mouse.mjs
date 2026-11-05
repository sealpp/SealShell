import { expect } from '@playwright/test'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const mouseScript = fileURLToPath(new URL('./desktop-mouse.py', import.meta.url))
const python = process.env.SEAL_PYTHON ?? fileURLToPath(new URL('../../.venv/Scripts/python.exe', import.meta.url))

export async function verifyDesktopTerminalMouse(page, { artifacts, pid }) {
  await run(python, [mouseScript, '--pid', String(pid), '--prepare-only'], { windowsHide: true })
  const id = await page.evaluate(() => {
    const { store, ws } = window.desktopFixture
    const tab = ws.addTab(store.hosts.find(host => host.id === 'desktop-fixture'), 'fixture-password')
    tab.label = 'Mouse fixture'
    return tab.id
  })
  try {
    await page.waitForFunction(id => window.desktopFixture.store.tabs.find(tab => tab.id === id)?.state === 'online', id)
    const screen = page.locator('.main-dock .shell-terminal:visible .xterm-screen')
    // Read the existing terminal context without adding a production test hook.
    await screen.evaluate(element => {
      let component = element.closest('.shell-terminal').__vueParentComponent
      while (component) {
        const context = typeof component.props.context === 'function' ? component.props.context() : undefined
        if (context?.terminal) {
          const terminal = context.terminal
          const fixture = { terminal, input: [] }
          fixture.subscription = terminal.onData(data => fixture.input.push(data))
          window.desktopTerminalMouse = fixture
          return
        }
        component = component.parent
      }
      throw new Error('Terminal command context not found')
    })
    const write = text => page.evaluate(text => new Promise(resolve => window.desktopTerminalMouse.terminal.write(text, resolve)), text)
    const viewport = () => page.evaluate(() => window.desktopTerminalMouse.terminal.buffer.active.viewportY)
    // SSH online can precede Bash/zsh startup output; wait for the fixture prompt.
    if (process.env.SEAL_E2E_BASH || process.env.SEAL_E2E_ZSH) {
      await page.waitForFunction(() => {
        const buffer = window.desktopTerminalMouse.terminal.buffer.active
        return /[$#%] $/.test(buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(false, 0, buffer.cursorX) ?? '')
      })
    }
    await write(Array.from({ length: 250 }, (_, i) => `mouse-line-${String(i).padStart(3, '0')} selectable words`).join('\r\n') + '\r\n')
    const bottom = await viewport()
    await screen.hover()
    await page.mouse.wheel(0, -180)
    await expect.poll(viewport).toBeLessThan(bottom)
    await page.mouse.wheel(0, 180)
    await expect.poll(viewport).toBe(bottom)
    await write('\x1b[?1049h\x1b[?1h')
    await page.mouse.wheel(0, -180)
    await page.mouse.wheel(0, 180)
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => window.desktopTerminalMouse.input)).toEqual([])
    await write('\x1b[?1049l\x1b[?1l\x1b[?1000h\x1b[?1006h')
    await page.mouse.wheel(0, -180)
    await expect.poll(viewport).toBeLessThan(bottom)
    expect(await page.evaluate(() => window.desktopTerminalMouse.input)).toEqual([])
    await write('\x1b[?1000l\x1b[?1006l')

    for (const direction of ['up', 'down']) {
      await page.evaluate(() => { const terminal = window.desktopTerminalMouse.terminal; terminal.clearSelection(); terminal.scrollToLine(100) })
      const rect = await screen.boundingBox()
      const scale = await page.evaluate(() => window.devicePixelRatio)
      await run(python, [mouseScript, '--pid', String(pid),
        '--from', String(rect.x + 20), String(rect.y + rect.height / 2),
        '--to', String(rect.x + 80), String(direction === 'up' ? rect.y + 2 : rect.y + rect.height - 2),
        '--scale', String(scale), '--hold-ms', '800'], { windowsHide: true })
      const state = await page.evaluate(() => {
        const terminal = window.desktopTerminalMouse.terminal
        return { viewport: terminal.buffer.active.viewportY, rows: terminal.rows,
          selection: terminal.getSelection().split(/\r?\n/).length, input: window.desktopTerminalMouse.input }
      })
      if (direction === 'up') expect(state.viewport).toBeLessThan(100)
      else expect(state.viewport).toBeGreaterThan(100)
      expect(state.selection).toBeGreaterThan(state.rows)
      expect(state.input).toEqual([])
      await page.waitForTimeout(200)
      expect(await viewport()).toBe(state.viewport)
      await page.screenshot({ path: join(artifacts, `terminal-mouse-${direction}.png`) })
    }
    console.log('Desktop terminal mouse: local wheel scrolling, no alternate-screen cursor keys or remote wheel reports; OS edge dragging extends beyond one screen and stops on release')
  } finally {
    await page.evaluate(id => {
      window.desktopTerminalMouse?.subscription.dispose()
      delete window.desktopTerminalMouse
      window.desktopFixture.ws.closeTabs([id])
    }, id)
  }
}
