import { expect, test, type Page } from '@playwright/test'

async function output(page: Page, text: string) {
  await page.evaluate(text => new Promise<void>(resolve => {
    const fixture = (window as any).mouseFixture
    const parsed = fixture.terminal.onWriteParsed(() => { parsed.dispose(); resolve() })
    fixture.output(text)
  }), text)
}

async function viewport(page: Page) {
  return page.evaluate(() => (window as any).mouseFixture.terminal.buffer.active.viewportY as number)
}

async function selection(page: Page) {
  return page.evaluate(() => ((window as any).mouseFixture.terminal.getSelection() as string).replace(/\r\n/g, '\n'))
}

test.beforeEach(async ({ page }) => {
  await page.route('**/src/services/ws.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/services/ws.ts?actual';
    window.mouseFixture = { input: [] };
    export function resizeTerminal() {}
    export function setTerminalOutputHandler(id, handler) {
      window.mouseFixture.output = text => handler?.(new TextEncoder().encode(text));
    }
    export function sendTerminalInput(id, data) { window.mouseFixture.input.push(...data); }
  ` }))
  await page.route('**/node_modules/.vite/deps/@xterm_xterm.js*', async route => {
    if (new URL(route.request().url()).searchParams.has('mouse-actual')) return route.continue()
    const source = new URL(route.request().url())
    source.searchParams.set('mouse-actual', '1')
    await route.fulfill({ contentType: 'application/javascript', body: `
      import { Terminal as ActualTerminal } from ${JSON.stringify(source.toString())};
      export class Terminal extends ActualTerminal {
        constructor(options) { super(options); window.mouseFixture.terminal = this; }
      }
    ` })
  })
  await page.goto('/tests/terminal-suggestions-harness.html')
  await expect(page.locator('.xterm-screen')).toBeVisible()
  await page.waitForFunction(() => (window as any).mouseFixture.terminal.rows > 2 && (window as any).mouseFixture.output)
  const lines = Array.from({ length: 200 }, (_, i) => `line-${String(i).padStart(3, '0')} selectable words`).join('\r\n') + '\r\n'
  await output(page, lines)
  await expect.poll(() => viewport(page)).toBeGreaterThan(100)
})

test('wheel scrolls history both ways without sending input', async ({ page }) => {
  const bottom = await viewport(page)
  await page.locator('.xterm-screen').hover()
  await page.mouse.wheel(0, -180)
  await expect.poll(() => viewport(page)).toBeLessThan(bottom)
  await page.mouse.wheel(0, 180)
  await expect.poll(() => viewport(page)).toBe(bottom)
  expect(await page.evaluate(() => (window as any).mouseFixture.input)).toEqual([])
})

test('wheel in alternate screen never becomes cursor keys', async ({ page }) => {
  await output(page, '\x1b[?1049h\x1b[?1h\r\n')
  await page.waitForFunction(() => (window as any).mouseFixture.terminal.buffer.active.type === 'alternate')
  await page.locator('.xterm-screen').hover()
  await page.mouse.wheel(0, -180)
  await page.mouse.wheel(0, 180)
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => (window as any).mouseFixture.input)).toEqual([])
  expect(await viewport(page)).toBe(0)
})

test('wheel scrolls local history even when the remote requests mouse reports', async ({ page }) => {
  await output(page, '\x1b[?1000h\x1b[?1006h\r\n')
  await page.waitForFunction(() => (window as any).mouseFixture.terminal.modes.mouseTrackingMode === 'vt200')
  const bottom = await viewport(page)
  await page.locator('.xterm-screen').hover()
  await page.mouse.wheel(0, -180)
  await expect.poll(() => viewport(page)).toBeLessThan(bottom)
  expect(await page.evaluate(() => (window as any).mouseFixture.input)).toEqual([])
})

test('wheel handles line, page and fractional pixel deltas without moving the cursor', async ({ page }) => {
  const result = await page.evaluate(() => {
    const terminal = (window as any).mouseFixture.terminal
    const screen = document.querySelector('.xterm-screen')!
    const cursor = [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY]
    const wheel = (deltaY: number, deltaMode: number) => screen.dispatchEvent(new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true }))
    terminal.scrollToLine(70)
    wheel(-3, WheelEvent.DOM_DELTA_LINE)
    const line = terminal.buffer.active.viewportY
    wheel(1, WheelEvent.DOM_DELTA_PAGE)
    const page = terminal.buffer.active.viewportY
    const cellHeight = screen.getBoundingClientRect().height / terminal.rows
    for (let i = 0; i < 4; i++) wheel(cellHeight * 0.3, WheelEvent.DOM_DELTA_PIXEL)
    const pixel = terminal.buffer.active.viewportY
    terminal.scrollToTop()
    wheel(-100000, WheelEvent.DOM_DELTA_PIXEL)
    wheel(1, WheelEvent.DOM_DELTA_LINE)
    return { line, page, pixel, rows: terminal.rows, boundary: terminal.buffer.active.viewportY,
      cursor, after: [terminal.buffer.active.cursorX, terminal.buffer.active.cursorY], input: (window as any).mouseFixture.input }
  })
  expect(result.line).toBe(67)
  expect(result.page).toBe(67 + result.rows)
  expect(result.pixel).toBe(result.page + 1)
  expect(result.boundary).toBe(1)
  expect(result.after).toEqual(result.cursor)
  expect(result.input).toEqual([])
})

for (const direction of ['up', 'down'] as const) {
  test(`drag selection held inside the ${direction} edge keeps scrolling and stops on release`, async ({ page }) => {
    await page.evaluate(() => (window as any).mouseFixture.terminal.scrollToLine(70))
    const screen = (await page.locator('.xterm-screen').boundingBox())!
    await page.mouse.move(screen.x + 20, screen.y + screen.height / 2)
    await page.mouse.down()
    await page.mouse.move(screen.x + 80, direction === 'up' ? screen.y + 2 : screen.y + screen.height - 2, { steps: 5 })
    const initial = await viewport(page)
    if (direction === 'up') await expect.poll(() => viewport(page)).toBeLessThan(initial)
    else await expect.poll(() => viewport(page)).toBeGreaterThan(initial)
    const first = await selection(page)
    await expect.poll(async () => (await selection(page)).split('\n').length).toBeGreaterThan(first.split('\n').length)
    await page.mouse.up()
    const stopped = await viewport(page)
    const selected = await selection(page)
    await page.waitForTimeout(200)
    expect(await viewport(page)).toBe(stopped)
    expect(await selection(page)).toBe(selected)
    expect(await page.evaluate(() => (window as any).mouseFixture.input)).toEqual([])
  })
}

test('leaving the edge stops scrolling and dragging to the opposite edge reverses it', async ({ page }) => {
  await page.evaluate(() => (window as any).mouseFixture.terminal.scrollToLine(70))
  const screen = (await page.locator('.xterm-screen').boundingBox())!
  await page.mouse.move(screen.x + 20, screen.y + screen.height / 2)
  await page.mouse.down()
  await page.mouse.move(screen.x + 80, screen.y + 2)
  await expect.poll(() => viewport(page)).toBeLessThan(70)
  await page.mouse.move(screen.x + 80, screen.y + screen.height / 2)
  const stopped = await viewport(page)
  await page.waitForTimeout(200)
  expect(await viewport(page)).toBe(stopped)
  await page.mouse.move(screen.x + 80, screen.y + screen.height - 2)
  await expect.poll(() => viewport(page)).toBeGreaterThan(stopped)
  await page.mouse.move(screen.x + 80, screen.y + screen.height + 10)
  const outside = await viewport(page)
  await expect.poll(() => viewport(page)).toBeGreaterThan(outside)
  await page.mouse.up()
  const released = await viewport(page)
  await page.waitForTimeout(200)
  expect(await viewport(page)).toBe(released)
})

test('losing focus ends edge scrolling even before mouseup', async ({ page }) => {
  await page.evaluate(() => (window as any).mouseFixture.terminal.scrollToLine(70))
  const screen = (await page.locator('.xterm-screen').boundingBox())!
  await page.mouse.move(screen.x + 20, screen.y + screen.height / 2)
  await page.mouse.down()
  await page.mouse.move(screen.x + 80, screen.y + 2)
  await expect.poll(() => viewport(page)).toBeLessThan(70)
  await page.locator('.xterm-helper-textarea').evaluate(element => (element as HTMLTextAreaElement).blur())
  const stopped = await viewport(page)
  await page.waitForTimeout(200)
  expect(await viewport(page)).toBe(stopped)
  await page.mouse.up()
  expect(await page.evaluate(() => (window as any).mouseFixture.input)).toEqual([])
})

for (const mode of ['word', 'line', 'column'] as const) {
  test(`edge scrolling preserves native ${mode} selection`, async ({ page }) => {
    await page.evaluate(() => (window as any).mouseFixture.terminal.scrollToLine(70))
    const screen = (await page.locator('.xterm-screen').boundingBox())!
    const cell = await page.evaluate(() => {
      const terminal = (window as any).mouseFixture.terminal
      const rect = document.querySelector('.xterm-screen')!.getBoundingClientRect()
      return { width: rect.width / terminal.cols, height: rect.height / terminal.rows }
    })
    if (mode === 'column') await page.keyboard.down('Alt')
    await page.mouse.move(screen.x + cell.width * 11, screen.y + cell.height * 5.5)
    await page.mouse.down({ clickCount: mode === 'word' ? 2 : mode === 'line' ? 3 : 1 })
    await page.mouse.move(screen.x + cell.width * 14, screen.y + screen.height - 2)
    await expect.poll(() => viewport(page)).toBeGreaterThan(70)
    await page.mouse.move(screen.x + cell.width * 14, screen.y + cell.height * 8.5)
    await page.mouse.up()
    if (mode === 'column') await page.keyboard.up('Alt')
    const lines = (await selection(page)).trimEnd().split('\n')
    if (mode === 'word') expect(lines.at(-1)).toMatch(/^line-\d+ selectable$/)
    else if (mode === 'line') expect(lines.join('\n')).toMatch(/^(line-\d+ selectable words\n)*line-\d+ selectable words$/)
    else expect(lines).toEqual(lines.map(() => 'lec'))
  })
}

test('Shift selection in remote mouse mode scrolls locally without mouse reports', async ({ page }) => {
  await output(page, '\x1b[?1002h\x1b[?1006h\r\n')
  await page.waitForFunction(() => (window as any).mouseFixture.terminal.modes.mouseTrackingMode === 'drag')
  await page.evaluate(() => (window as any).mouseFixture.terminal.scrollToLine(70))
  const screen = (await page.locator('.xterm-screen').boundingBox())!
  await page.keyboard.down('Shift')
  await page.mouse.move(screen.x + 20, screen.y + screen.height / 2)
  await page.mouse.down()
  await page.mouse.move(screen.x + 80, screen.y + 2)
  await expect.poll(() => viewport(page)).toBeLessThan(70)
  await page.mouse.up()
  await page.keyboard.up('Shift')
  expect(await selection(page)).toContain('selectable words')
  expect(await page.evaluate(() => (window as any).mouseFixture.input)).toEqual([])
})
