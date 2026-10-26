import { expect, test, type Page } from '@playwright/test'

async function openTerminals(page: Page, ids = ['layout-a'], state: 'connecting' | 'online' = 'online') {
  await page.route('**/src/services/ws.ts', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      export * from '/src/services/ws.ts?actual';
      const handlers = new Map();
      const encoder = new TextEncoder();
      window.terminalLayoutFixture = { handlers, bindings: [], resizes: [], inputs: [], ready: new Set(), remoteSizes: new Map() };
      export function setTerminalOutputHandler(id, handler) {
        window.terminalLayoutFixture.bindings.push({ id, bound: !!handler });
        if (handler) handlers.set(id, text => handler(encoder.encode(text)));
        else handlers.delete(id);
      }
      export function resizeTerminal(id, columns, rows) {
        window.terminalLayoutFixture.resizes.push({ id, columns, rows });
        if (window.terminalLayoutFixture.ready.has(id)) window.terminalLayoutFixture.remoteSizes.set(id, { columns, rows });
      }
      export function sendTerminalInput(id, data) {
        const text = new TextDecoder().decode(data);
        window.terminalLayoutFixture.inputs.push({ id, text });
        handlers.get(id)?.(text);
      }
    `,
  }))
  await page.goto('/')
  const pairing = page.getByRole('dialog', { name: '配对 Node', exact: true })
  await expect(pairing).toBeVisible()
  await pairing.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(async ({ ids, state }) => {
    const { store } = await import('/src/stores/app.ts')
    const { commandSuggestions } = await import('/src/services/terminalSuggestions/runtime.ts')
    commandSuggestions.enabled = false
    for (const id of ids) {
      const fixture = (window as any).terminalLayoutFixture
      fixture.remoteSizes.set(id, { columns: 80, rows: 24 })
      if (state === 'online') fixture.ready.add(id)
    }
    store.hosts = [{ id: 'layout-host', name: 'Layout fixture', address: 'test.invalid', port: 22, username: 'test', folderId: null }]
    store.tabs = ids.map(id => ({
      id, kind: 'terminal', hostId: 'layout-host', label: id, state, error: '',
      sessionId: id, terminalId: id, encoding: 'utf-8',
    }))
    store.view = 'shell'
    store.activeTerminalTabId = ids[0]
  }, { ids, state })
  await expect(page.locator('.terminal-tab')).toHaveCount(ids.length)
  await page.waitForFunction(ids => ids.every(id => (window as any).terminalLayoutFixture.handlers.has(id)), ids)
}

for (const { name, width, reconnect } of [
  { name: 'new wide', width: 1280, reconnect: false },
  { name: 'new narrow', width: 800, reconnect: false },
  { name: 'reconnected', width: 1280, reconnect: true },
]) {
  test(`${name} terminals publish the fitted size when SSH becomes ready without a viewport resize`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await openTerminals(page, ['layout-a'], reconnect ? 'online' : 'connecting')
    await expect.poll(() => page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts')
      return store.tabs[0].viewportSize?.columns ?? 80
    })).not.toBe(80)
    const fitted = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts')
      return { ...store.tabs[0].viewportSize }
    })
    if (reconnect) {
      await page.evaluate(async () => {
        const { store } = await import('/src/stores/app.ts')
        const fixture = (window as any).terminalLayoutFixture
        fixture.ready.delete('layout-a')
        fixture.remoteSizes.set('layout-a', { columns: 80, rows: 24 })
        store.tabs[0].state = 'connecting'
        store.tabs[0].sessionId = 'reconnected-session'
      })
      await page.waitForFunction(() => (window as any).terminalLayoutFixture.handlers.has('reconnected-session'))
    }
    expect(await page.evaluate(() => (window as any).terminalLayoutFixture.remoteSizes.get('layout-a'))).toEqual({ columns: 80, rows: 24 })
    await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts')
      const fixture = (window as any).terminalLayoutFixture
      fixture.ready.add('layout-a')
      store.tabs[0].state = 'online'
    })
    await expect.poll(() => page.evaluate(() => (window as any).terminalLayoutFixture.remoteSizes.get('layout-a'))).toEqual(fitted)
    expect(page.viewportSize()).toEqual({ width, height: 800 })
  })
}

async function recordLayoutChanges(page: Page) {
  await page.evaluate(() => {
    const fixture = (window as any).terminalLayoutFixture
    const dock = document.querySelector('.main-dock-host')!
    fixture.layouts = []
    fixture.observer = new ResizeObserver(() => {
      // Runs after MainDock's observer, before paint. A final-state check
      // would miss the always renderer's RAF-delayed content overlay.
      const groups = [...dock.querySelectorAll('.dv-groupview')].map(el => el.getBoundingClientRect())
      const panels = [...dock.querySelectorAll('.shell-terminal-content')]
        .filter(el => el.checkVisibility())
        .map(el => {
          const rect = el.getBoundingClientRect()
          const group = [...groups].sort((a, b) => Math.abs(a.left - rect.left) - Math.abs(b.left - rect.left))[0]!
          const slider = el.querySelector('.scrollbar.vertical .slider')!.getBoundingClientRect()
          return { left: rect.left, groupLeft: group.left, width: rect.width, groupWidth: group.width, right: slider.right, groupRight: group.right }
        })
      fixture.layouts.push({ width: dock.clientWidth, panels })
    })
    fixture.observer.observe(dock)
  })
  await expect.poll(() => page.evaluate(() => (window as any).terminalLayoutFixture.layouts.length)).toBeGreaterThan(0)
}

for (const split of [false, true]) {
  test(`keeps terminal content and scrollbars aligned before paint when toggling the sidebar${split ? ' with split panes' : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 })
    await openTerminals(page, split ? ['layout-a', 'layout-b'] : ['layout-a'])
    if (split) {
      const dock = page.locator('.main-dock')
      const bounds = (await dock.boundingBox())!
      await page.locator('.terminal-tab').filter({ hasText: 'layout-b' }).dragTo(dock, {
        targetPosition: { x: bounds.width - 5, y: bounds.height / 2 },
      })
      await expect(page.locator('.main-dock .dv-groupview')).toHaveCount(2)
    }
    await page.evaluate(() => {
      for (const write of (window as any).terminalLayoutFixture.handlers.values()) {
        write('\x1b[?25l' + Array.from({ length: 2000 }, (_, i) => `line ${i}\r\n`).join(''))
      }
    })
    await expect(page.locator('.xterm-rows').first()).toContainText('line 1999')
    await page.locator('.xterm-screen').last().hover()
    await page.mouse.wheel(0, -40)
    await expect(page.locator('.xterm .scrollbar.vertical').last()).toHaveCSS('opacity', '1')
    await recordLayoutChanges(page)
    const activity = page.getByRole('button', { name: '会话', exact: true })
    for (let i = 0; i < 6; i++) {
      const previous = await page.evaluate(() => (window as any).terminalLayoutFixture.layouts.length)
      await activity.click()
      await expect.poll(() => page.evaluate(() => (window as any).terminalLayoutFixture.layouts.length)).toBeGreaterThan(previous)
    }
    const layouts = await page.evaluate(() => (window as any).terminalLayoutFixture.layouts)
    expect(new Set(layouts.map((layout: any) => layout.width)).size).toBe(2)
    for (const layout of layouts) {
      expect(layout.panels).toHaveLength(split ? 2 : 1)
      for (const panel of layout.panels) {
        expect(Math.abs(panel.left - panel.groupLeft)).toBeLessThan(2)
        expect(Math.abs(panel.width - panel.groupWidth)).toBeLessThan(2)
        expect(Math.abs(panel.right - panel.groupRight)).toBeLessThan(2)
      }
    }
  })
}

test('preserves terminal instances, background output and input routing across tab switches', async ({ page }) => {
  await openTerminals(page, ['layout-a', 'layout-b'])
  const tab = (id: string) => page.locator('.terminal-tab').filter({ hasText: id })
  await tab('layout-a').click()
  await page.evaluate(() => (window as any).terminalLayoutFixture.handlers.get('layout-a')('first terminal\r\nprompt$ '))
  await expect(page.locator('.xterm-rows:visible')).toContainText('first terminal')
  await page.locator('.xterm-screen:visible').click()
  await page.keyboard.type('pending')
  await expect(page.locator('.xterm-rows:visible')).toContainText('prompt$ pending')
  // Allow the initial fit and backend resize debounce to finish before
  // checking that switching equal-sized tabs does not resize the PTY again.
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const fixture = (window as any).terminalLayoutFixture
    fixture.firstRoot = document.querySelector('.shell-terminal')
    fixture.initialBindings = fixture.bindings.length
    fixture.initialResizes = fixture.resizes.filter((resize: any) => resize.id === 'layout-a').length
  })
  await tab('layout-b').click()
  await page.evaluate(() => (window as any).terminalLayoutFixture.handlers.get('layout-a')('\r\nbackground output\r\n'))
  await expect(page.locator('.xterm-rows:visible')).not.toContainText('background output')
  await page.locator('.xterm-screen:visible').click()
  await page.keyboard.type('second')
  await expect(page.locator('.xterm-rows:visible')).toContainText('second')
  await tab('layout-a').click()
  await expect(page.locator('.xterm-rows:visible')).toContainText('background output')
  await expect(page.locator('.xterm-rows:visible')).toContainText('prompt$ pending')
  await page.waitForTimeout(250)
  const state = await page.evaluate(() => {
    const fixture = (window as any).terminalLayoutFixture
    return {
      sameRoot: fixture.firstRoot === document.querySelector('.shell-terminal'),
      rebound: fixture.bindings.length - fixture.initialBindings,
      resized: fixture.resizes.filter((resize: any) => resize.id === 'layout-a').length - fixture.initialResizes,
      firstInput: fixture.inputs.filter((input: any) => input.id === 'layout-a').map((input: any) => input.text).join(''),
      secondInput: fixture.inputs.filter((input: any) => input.id === 'layout-b').map((input: any) => input.text).join(''),
    }
  })
  expect(state).toEqual({ sameRoot: true, rebound: 0, resized: 0, firstInput: 'pending', secondInput: 'second' })
})
