import { expect, test, type Page } from '@playwright/test'

async function openWorkbench(page: Page) {
  await page.route('**/src/services/ssh.ts', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      export * from '/src/services/ssh.ts?actual';
      window.initialSizeFixture = { connections: [], ready: new Map(), closed: [], resizes: [] };
      export async function connectSsh(info, onState, onOutput, initialSize) {
        const fixture = window.initialSizeFixture;
        fixture.connections.push({ sessionId: info.sessionId, initialSize });
        onState('connecting');
        await new Promise(resolve => fixture.ready.set(info.sessionId, () => {
          onState('online');
          onOutput(new TextEncoder().encode('shell ready\\r\\n'));
          resolve();
        }));
        return info;
      }
      export async function closeSsh(id) { window.initialSizeFixture.closed.push(id); }
      export async function resize(id, columns, rows) { window.initialSizeFixture.resizes.push({ id, columns, rows }); }
    `,
  }))
  await page.goto('/tests/app-harness.html')
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { commandSuggestions } = await import('/src/services/terminalSuggestions/runtime.ts')
    commandSuggestions.enabled = false
    store.hosts = [{ id: 'size-host', name: 'Size fixture', address: 'test.invalid', port: 22, username: 'test', folderId: null }]
  })
}

async function addTabs(page: Page, count = 1) {
  return page.evaluate(async count => {
    const { store } = await import('/src/stores/app.ts')
    const { addTab } = await import('/src/services/ws.ts')
    return Array.from({ length: count }, () => addTab(store.hosts[0], 'test').id)
  }, count)
}

async function finishConnection(page: Page, index: number) {
  await page.evaluate(index => {
    const fixture = (window as any).initialSizeFixture
    fixture.ready.get(fixture.connections[index].sessionId)()
  }, index)
}

test('Ctrl+W closes only the focused terminal and returns to welcome after the last tab', async ({ page }) => {
  await openWorkbench(page)
  const [first, second] = await addTabs(page, 2)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(2)
  await finishConnection(page, 0)
  await finishConnection(page, 1)
  const firstSession = await page.evaluate(async id => {
    const { store } = await import('/src/stores/app.ts')
    return store.tabs.find(tab => tab.id === id)!.sessionId
  }, first)

  await page.locator('.terminal-tab-label').first().click()
  await page.locator('.xterm-helper-textarea:visible').focus()
  await page.locator('.xterm-helper-textarea:visible').evaluate(element => {
    for (const options of [{ repeat: true }, { isComposing: true }]) {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, ...options }))
    }
  })
  await expect(page.locator('.terminal-tab')).toHaveCount(2)

  await page.keyboard.press('Control+w')
  await expect(page.locator('.terminal-tab')).toHaveCount(1)
  expect(await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    return { ids: store.tabs.map(tab => tab.id), active: store.activeTerminalTabId, closed: (window as any).initialSizeFixture.closed }
  })).toEqual({ ids: [second], active: second, closed: [firstSession] })

  await page.locator('.xterm-helper-textarea:visible').focus()
  await page.keyboard.press('Control+w')
  await expect(page.locator('.terminal-tab')).toHaveCount(0)
  await expect(page.locator('.welcome')).toBeVisible()
})

test('Ctrl+W follows focus between the terminal and the bottom editor', async ({ page }) => {
  await openWorkbench(page)
  const [terminalId] = await addTabs(page)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(1)
  await finishConnection(page, 0)
  await page.evaluate(async () => {
    const { store, setBottomPanelActiveTab } = await import('/src/stores/app.ts')
    store.tabs.push({
      id: 'editor', kind: 'editor', hostId: 'size-host', label: 'focus.txt', state: 'online', error: '',
      sessionId: 'editor', terminalId: '', encoding: 'utf-8',
      editor: { path: '/focus.txt', content: 'saved content', language: 'plaintext', encoding: 'utf-8',
        bom: false, lineEnding: '\n', size: 13, contentVersion: 0, dirty: false, largeFileConfirmed: false },
    })
    setBottomPanelActiveTab('editor', 'editors')
    store.bottomPanelOpen = true
  })
  const editor = page.locator('[data-editor-tab="editor"]')
  await expect(editor.locator('.monaco-editor')).toBeVisible()
  await editor.locator('.view-lines').click()
  await page.locator('.xterm-screen:visible').click()
  await page.keyboard.press('Control+w')
  await expect(page.locator('.terminal-tab')).toHaveCount(0)
  await expect(editor).toBeVisible()
  expect(await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    return store.tabs.map(tab => tab.id)
  })).not.toContain(terminalId)

  await editor.locator('.view-lines').click()
  await page.keyboard.press('Control+w')
  await expect(editor).toHaveCount(0)
})

for (const width of [1280, 800]) {
  test(`new and reconnected terminals pass the fitted ${width}px viewport before opening SSH`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await openWorkbench(page)
    const [id] = await addTabs(page)
    await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(1)
    const initialSize = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts')
      const connection = (window as any).initialSizeFixture.connections[0]
      return { requested: connection.initialSize, measured: store.tabs[0].viewportSize, state: store.tabs[0].state }
    })
    expect(initialSize.requested).toEqual(initialSize.measured)
    expect(initialSize.state).toBe('connecting')
    if (width === 1280) expect(initialSize.requested.columns).toBeGreaterThan(80)
    else expect(initialSize.requested.columns).toBeLessThan(80)
    expect(initialSize.requested.rows).toBeGreaterThan(24)
    await finishConnection(page, 0)
    await expect(page.locator('.terminal-tab .dot.online')).toHaveCount(1)
    await page.evaluate(async id => {
      const { store } = await import('/src/stores/app.ts')
      const { reconnectTab } = await import('/src/services/ws.ts')
      reconnectTab(store.tabs.find(tab => tab.id === id)!, store.hosts[0], 'test')
    }, id)
    await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(2)
    expect(await page.evaluate(() => (window as any).initialSizeFixture.connections[1].initialSize)).toEqual(initialSize.measured)
    await finishConnection(page, 1)
    await expect(page.locator('.terminal-tab .dot.online')).toHaveCount(1)
    expect(page.viewportSize()).toEqual({ width, height: 800 })
  })
}

test('input during the handshake does not fail or partially feed a pending terminal', async ({ page }) => {
  await openWorkbench(page)
  await addTabs(page)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(1)
  await page.locator('.xterm-helper-textarea').focus()
  await page.keyboard.type('early input')
  await expect(page.locator('.terminal-tab .dot.connecting')).toHaveCount(1)
  await expect(page.locator('.xterm-rows')).not.toContainText('session error')
  await finishConnection(page, 0)
  await expect(page.locator('.terminal-tab .dot.online')).toHaveCount(1)
})

test('batch connections measure detached tabs from their visible group peer', async ({ page }) => {
  await openWorkbench(page)
  await addTabs(page, 3)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(3)
  const sizes = await page.evaluate(() => (window as any).initialSizeFixture.connections.map((connection: any) => connection.initialSize))
  expect(sizes[0].columns).toBeGreaterThan(80)
  expect(sizes).toEqual([sizes[0], sizes[0], sizes[0]])
  for (let i = 0; i < 3; i++) await finishConnection(page, i)
  await expect(page.locator('.terminal-tab .dot.online')).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.resizes.length)).toBe(3)
  const reconciled = await page.evaluate(() => (window as any).initialSizeFixture.resizes.map(({ columns, rows }: any) => ({ columns, rows })))
  expect(reconciled).toEqual([sizes[0], sizes[0], sizes[0]])
})

test('reconciles a real viewport change during the handshake', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openWorkbench(page)
  await addTabs(page)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(1)
  const initialSize = await page.evaluate(() => (window as any).initialSizeFixture.connections[0].initialSize)
  await page.setViewportSize({ width: 800, height: 800 })
  await expect.poll(() => page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    return store.tabs[0].viewportSize?.columns
  })).toBeLessThan(initialSize.columns)
  expect(await page.evaluate(() => (window as any).initialSizeFixture.resizes)).toEqual([])
  await finishConnection(page, 0)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.resizes.at(-1)?.columns)).toBeLessThan(initialSize.columns)
})

test('does not start SSH when a tab closes before its first measurement', async ({ page }) => {
  await openWorkbench(page)
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { addTab, closeTab } = await import('/src/services/ws.ts')
    const tab = addTab(store.hosts[0], 'test')
    closeTab(tab.id)
  })
  // A later visible peer must not revive the closed session's waiter.
  await addTabs(page)
  await expect(page.locator('.terminal-tab')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(1)
  await finishConnection(page, 0)
  await expect(page.locator('.terminal-tab .dot.online')).toHaveCount(1)
})

test('keeps a replacement session connecting when the superseded handshake completes', async ({ page }) => {
  await openWorkbench(page)
  const [id] = await addTabs(page)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(1)
  await page.evaluate(async id => {
    const { store } = await import('/src/stores/app.ts')
    const { reconnectTab } = await import('/src/services/ws.ts')
    reconnectTab(store.tabs.find(tab => tab.id === id)!, store.hosts[0], 'test')
  }, id)
  await expect.poll(() => page.evaluate(() => (window as any).initialSizeFixture.connections.length)).toBe(2)
  await finishConnection(page, 0)
  await expect(page.locator('.terminal-tab .dot.connecting')).toHaveCount(1)
  expect(await page.evaluate(() => {
    const fixture = (window as any).initialSizeFixture
    return fixture.closed.filter((id: string) => id === fixture.connections[0].sessionId).length
  })).toBe(2)
  await finishConnection(page, 1)
  await expect(page.locator('.terminal-tab .dot.online')).toHaveCount(1)
})
