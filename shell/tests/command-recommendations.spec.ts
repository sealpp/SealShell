import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const input = (page: Page) => page.locator('.xterm-helper-textarea')
const options = (page: Page) => page.getByRole('listbox', { name: '命令候选' }).getByRole('option')
const history = (page: Page) => page.evaluate(() => (window as any).harness.readHistory())
const requests = (page: Page) => page.evaluate(() => (window as any).harness.requests.length)
const respond = (page: Page, index: number, commands: string[]) => page.evaluate(({ index, commands }) => (window as any).harness.respond(index, commands), { index, commands })

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/command-suggestions-harness.html')
  await expect(page.locator('#ready')).toHaveText('true')
  await input(page).focus()
})

test('replaces the whole Unicode command from non-prefix history without execution', async ({ page }) => {
  const command = "cd '/work/项目' && python main.py"
  await page.evaluate(async command => { await (window as any).harness.record('suggestions-a', command) }, command)
  await page.reload()
  await expect(page.locator('#ready')).toHaveText('true')
  await input(page).focus()
  await page.keyboard.type('python main')
  await expect(options(page).first()).toContainText(command)
  await options(page).first().click()
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe('\x15' + command)
  await expect.poll(() => page.evaluate(() => (window as any).harness.text())).toContain('dev@host:~$ ' + command)
  expect((await history(page))[0].uses).toBe(1)
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await history(page))[0].uses).toBe(2)
})

for (const item of [
  { input: 'cd demo', good: "cd -- '/work/demo'", bad: ['ls /work/demo', 'cd /work/demo && ls'] },
  { input: 'ls -la demo', good: "ls -la -- '/work/demo'", bad: ['cd /work/demo', 'ls /work/demo', 'ls -la /work/demo && cat /etc/passwd'] },
  { input: 'tail -n 20 app', good: "tail -n 20 -- '/work/app.log'", bad: ['cat /work/app.log', 'tail -n 100 /work/app.log'] },
]) test(`preserves command and arguments in the visible list: ${item.input}`, async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.type(item.input)
  await expect.poll(() => requests(page)).toBe(1)
  await respond(page, 0, [...item.bad, item.good])
  await expect(options(page)).toHaveCount(1)
  await expect(options(page).first()).toContainText(item.good)
  await options(page).first().click()
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe('\x15' + item.good)
  expect(await history(page)).toEqual([])
})

test('buffers late AI suggestions while selecting, applies them explicitly, and rejects stale results', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.type('git ')
  await expect.poll(() => requests(page)).toBe(1)
  const before = await options(page).allTextContents()
  await page.keyboard.press('ArrowDown')
  await expect(options(page).first()).toBeFocused()
  await respond(page, 0, ['git log --all --graph'])
  expect(await options(page).allTextContents()).toEqual(before)
  await expect(options(page).first()).toBeFocused()
  await page.getByRole('button', { name: '显示 1 条新建议' }).click()
  await expect(options(page).first()).toContainText('git log --all --graph')
  await input(page).focus()
  await page.keyboard.type('s')
  await expect.poll(() => requests(page)).toBe(2)
  await page.keyboard.type('t')
  await respond(page, 1, ['echo stale'])
  await expect(options(page).filter({ hasText: 'echo stale' })).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).harness.requests[1].signal.aborted)).toBe(true)
})

test('puts the user command ahead of a compatible alternative and excludes a different goal', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.type('ls -la demo')
  await expect.poll(() => requests(page)).toBe(1)
  await respond(page, 0, ["eza -la '/work/demo'", "cd '/work/demo'", "ls -la '/work/demo'"])
  await expect(options(page)).toHaveCount(2)
  await expect(options(page).first()).toContainText("ls -la '/work/demo'")
  await expect(options(page).nth(1)).toContainText("eza -la '/work/demo'")
  await options(page).nth(1).click()
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe("\x15eza -la '/work/demo'")
  expect(await history(page)).toEqual([])
})

test('uses one bottom light across preparation stages and preserves selection with reduced motion', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.type('git ')
  await expect.poll(() => requests(page)).toBe(1)
  const popup = page.locator('.terminal-command-suggestions')
  const status = popup.getByRole('status')
  await expect(status).toHaveText('正在准备建议')
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('terminal-command-flow')
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').bottom)).toBe('0px')
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
  await page.keyboard.press('ArrowDown')
  const before = await options(page).allTextContents()
  const initialHeight = (await popup.boundingBox())!.height
  await page.evaluate(() => (window as any).harness.progress(0, 'ai'))
  await expect(status).toHaveText('正在准备建议')
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('terminal-command-flow')
  await expect(popup.locator('.codicon-loading')).toHaveCount(0)
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
  expect((await popup.boundingBox())!.height).toBe(initialHeight)
  await expect(popup).not.toHaveAttribute('title')
  await expect(options(page).first()).toBeFocused()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
  await expect(popup.locator('.terminal-command-static-activity')).toBeVisible()
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').opacity)).toBe('0.9')
  await expect(popup.getByText(/生成中|读目录|查找中|正在读取/)).toHaveCount(0)
  expect((await popup.boundingBox())!.height).toBe(initialHeight)
  await expect(status).toHaveText('正在准备建议')
  await respond(page, 0, ['git log --all --graph'])
  await expect(status).toHaveText('有 1 条新建议待显示')
  await expect(popup.locator('.codicon-check')).toHaveCount(0)
  await expect(popup.locator('.terminal-command-static-activity')).toHaveCount(0)
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').opacity)).toBe('0')
  await expect(page.getByRole('button', { name: '显示 1 条新建议' })).toBeVisible()
  expect(await options(page).allTextContents()).toEqual(before)
  await expect(options(page).first()).toBeFocused()
  await page.getByRole('button', { name: '显示 1 条新建议' }).click()
  await expect(options(page).first()).toContainText('git log --all --graph')
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
})

for (const reducedMotion of ['no-preference', 'reduce'] as const) test(`adapts working feedback without changing the candidate row height: ${reducedMotion}`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion })
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.insertText('查看当前目录')
  await expect.poll(() => requests(page)).toBe(1)
  const popup = page.locator('.terminal-command-suggestions')
  const glowX = () => popup.evaluate(element => new DOMMatrixReadOnly(getComputedStyle(element, '::before').transform).m41)
  const emptyHeight = (await popup.boundingBox())!.height
  const staticMarker = popup.locator('.terminal-command-static-activity')
  if (reducedMotion === 'reduce') {
    await expect(staticMarker).toBeVisible()
    await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
    await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').transform)).toBe('none')
  } else {
    await expect(staticMarker).toBeHidden()
    const startX = await glowX()
    // Observe elapsed time: setting currentTime by hand would not detect a stopped animation.
    await expect.poll(async () => Math.abs(await glowX() - startX)).toBeGreaterThan(8)
  }
  await page.evaluate(() => {
    const request = (window as any).harness.requests[0]
    request.progress('ai')
    request.publish([{ command: 'ls', source: 'ai', priority: 4, uses: 0, lastUsed: 0 }])
  })
  await expect(options(page)).toHaveCount(1)
  expect((await popup.boundingBox())!.height).toBe(emptyHeight)
  if (reducedMotion === 'reduce') {
    const before = await popup.evaluate(element => ({ line: getComputedStyle(element, '::before').transform, marker: element.querySelector('.terminal-command-static-activity')!.getBoundingClientRect().toJSON() }))
    await page.waitForTimeout(300)
    expect(await popup.evaluate(element => ({ line: getComputedStyle(element, '::before').transform, marker: element.querySelector('.terminal-command-static-activity')!.getBoundingClientRect().toJSON() }))).toEqual(before)
    await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
    await expect(staticMarker).toBeVisible()
  } else {
    const populatedX = await glowX()
    await expect.poll(async () => Math.abs(await glowX() - populatedX)).toBeGreaterThan(16)
  }
  await respond(page, 0, [])
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').opacity)).toBe('0')
  await expect(staticMarker).toHaveCount(0)
  expect((await popup.boundingBox())!.height).toBe(emptyHeight)
})

test('finishes silently without growing the suggestion panel', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.type('git ')
  await expect.poll(() => requests(page)).toBe(1)
  await page.evaluate(() => (window as any).harness.progress(0, 'ai'))
  const popup = page.locator('.terminal-command-suggestions')
  const initialHeight = (await popup.boundingBox())!.height
  await respond(page, 0, [])
  await expect(popup.getByRole('status')).toHaveText('建议已更新')
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
  await expect(popup.locator('.codicon-check')).toHaveCount(0)
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').opacity)).toBe('0')
  expect((await popup.boundingBox())!.height).toBe(initialHeight)
  await expect(input(page)).toBeFocused()
})

test('keeps long waits text-free and stops the light when a request is cancelled', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.type('git ')
  await expect.poll(() => requests(page)).toBe(1)
  await page.clock.install()
  await page.evaluate(() => (window as any).harness.progress(0, 'ai'))
  await page.clock.fastForward(30000)
  const popup = page.locator('.terminal-command-suggestions')
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
  await expect(popup.getByRole('status')).toHaveText('正在准备建议')
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('terminal-command-flow')
  await page.keyboard.type('s')
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
  await page.clock.fastForward(650)
  await expect.poll(() => requests(page)).toBe(2)
  await respond(page, 1, [])
  await page.clock.fastForward(30000)
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
})

test('stops the working indicator on failure and ignores progress from cancelled requests', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.type('python ')
  await expect.poll(() => requests(page)).toBe(1)
  await page.keyboard.type('m')
  await expect.poll(() => requests(page)).toBe(2)
  await page.evaluate(() => (window as any).harness.progress(0, 'ai'))
  const popup = page.locator('.terminal-command-suggestions')
  const status = popup.getByRole('status')
  await expect(status).toHaveText('正在准备建议')
  await page.evaluate(() => (window as any).harness.fail(1, '云端推荐失败（HTTP 503）'))
  await expect(status).toHaveText('云端推荐失败（HTTP 503）')
  await expect(popup.locator('.terminal-command-status .codicon-warning')).toBeVisible()
  await expect(popup.locator('.terminal-command-status .ui-status-icon')).toHaveCSS('animation-name', 'none')
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('none')
  await expect(input(page)).toBeFocused()
})

test('recommends from direct input and remembers acceptance separately from submission', async ({ page }) => {
  await page.evaluate(() => { (window as any).harness.enhance(true); (window as any).harness.feedback(true); (window as any).harness.cwd('/work') })
  await page.keyboard.insertText('查看 8080 端口')
  await expect.poll(() => requests(page)).toBe(1)
  expect(await page.evaluate(() => (window as any).harness.sent.join(''))).toBe('查看 8080 端口')
  await expect(input(page)).toBeFocused()
  await respond(page, 0, ["ss -ltnp 'sport = :8080'"])
  await options(page).first().click()
  await expect.poll(() => history(page)).toEqual([expect.objectContaining({ uses: 0, accepted: 1 })])
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe("\x15ss -ltnp 'sport = :8080'")
  await page.keyboard.press('Enter')
  await expect.poll(() => history(page)).toEqual([expect.objectContaining({ uses: 1, accepted: 1, contexts: [expect.objectContaining({ cwd: '/work' })] })])
})

test('invalidates recommendations when cwd changes and hides them during delayed echo', async ({ page }) => {
  await page.evaluate(() => { (window as any).harness.enhance(true); (window as any).harness.cwd('/one') })
  await page.keyboard.type('python ')
  await expect.poll(() => requests(page)).toBe(1)
  await page.evaluate(() => (window as any).harness.cwd('/two'))
  await respond(page, 0, ["cd /one && python main.py"])
  await expect(options(page).filter({ hasText: 'cd /one' })).toHaveCount(0)
  await expect.poll(() => requests(page)).toBe(2)
  await page.evaluate(() => (window as any).harness.echo(false))
  await page.keyboard.type('m')
  await respond(page, 1, ["cd /two && python main.py"])
  await expect(options(page)).toHaveCount(0)
})

test('keeps Ctrl+I and the former intent shortcut in the terminal without opening an input', async ({ page }) => {
  await page.keyboard.press('Control+i')
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe('\t')
  await page.evaluate(() => (window as any).harness.reset())
  await page.keyboard.press('Control+Shift+Space')
  await expect(page.getByRole('textbox', { name: '想完成什么' })).toHaveCount(0)
  await expect(input(page)).toBeFocused()
  expect(await requests(page)).toBe(0)
})

test('saves cloud configuration with encrypted credentials and preserves it across reload', async ({ page }) => {
  await page.getByRole('button', { name: '命令提示设置', exact: true }).click()
  // Locators can auto-scroll before editing; assert discoverability first.
  await expect(page.getByRole('textbox', { name: 'API 地址', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('textbox', { name: '模型', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByLabel('API Key', { exact: true })).toBeInViewport({ ratio: 1 })
  await page.getByRole('switch', { name: 'AI 推荐', exact: true }).check()
  await page.getByRole('textbox', { name: 'API 地址', exact: true }).fill('https://example.invalid/v1')
  await page.getByRole('textbox', { name: '模型', exact: true }).fill('example-model')
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-private-test-key')
  await expect(page.getByRole('status')).toContainText('已自动保存')
  const stored = await page.evaluate(async () => {
    const storage = await import(/* @vite-ignore */ '/src/services/storage.ts')
    const vault = await import(/* @vite-ignore */ '/src/services/vault.ts')
    return { meta: await storage.readMeta('commandSuggestions'), encrypted: await storage.readCredential('command-recommendations'), key: await vault.loadCredentialRecord('command-recommendations') }
  })
  expect(JSON.stringify(stored.meta)).not.toContain('synthetic-private-test-key')
  expect(JSON.stringify(stored.encrypted)).not.toContain('synthetic-private-test-key')
  expect(stored.key.apiKey).toBe('synthetic-private-test-key')
  await page.reload()
  await expect(page.locator('#ready')).toHaveText('true')
  await page.getByRole('button', { name: '命令提示设置', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'AI 推荐', exact: true })).toBeChecked()
  await expect(page.getByRole('textbox', { name: '模型', exact: true })).toHaveValue('example-model')
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('placeholder', '已保存，输入可更换')
  await page.getByRole('switch', { name: '自动补充建议', exact: true }).uncheck()
  await expect(page.getByRole('status')).toContainText('已自动保存')
  expect(await page.evaluate(async () => (await import('/src/services/terminalSuggestions/runtime.ts')).loadRecommendationKey())).toBe('synthetic-private-test-key')
  await page.getByRole('button', { name: '清除 API Key', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已自动保存')
  expect(await page.evaluate(async () => (await import('/src/services/terminalSuggestions/runtime.ts')).loadRecommendationKey())).toBe('')
})

test('the production terminal requests AI for a path even without directory context', async ({ page }) => {
  await page.route('**/src/services/ws.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/services/ws.ts?actual';
    let output;
    const encoder = new TextEncoder();
    export function resizeTerminal() {}
    export function setTerminalOutputHandler(id, handler) {
      output = handler;
      if (handler) setTimeout(() => { handler(encoder.encode('dev@host:~$ ')); window.productionReady = true; }, 0);
    }
    export function sendTerminalInput(id, payload) { output?.(payload); }
  ` }))
  let payload: any
  await page.route('https://model.example/v1/chat/completions', async route => {
    payload = route.request().postDataJSON()
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{"suggestions":[]}' } }] }) })
  })
  await page.goto('/tests/terminal-suggestions-harness.html')
  await page.waitForFunction(() => (window as any).productionReady)
  await page.evaluate(async () => {
    const { initializeVault } = await import('/src/services/vault.ts')
    const { saveSuggestionPreferences } = await import('/src/services/terminalSuggestions/runtime.ts')
    await initializeVault()
    await saveSuggestionPreferences(true, true, { cloud: true, automatic: true, remoteContext: false, shareHistory: false, baseUrl: 'https://model.example/v1', model: 'test-model' }, 'synthetic-key')
  })
  await input(page).focus()
  await page.keyboard.type('cd demo')
  await expect(page.locator('.terminal-command-suggestions')).toContainText('AI 暂未找到匹配建议')
  expect(JSON.parse(payload.messages[1].content).input).toBe('cd demo')
  const trace = await page.evaluate(async () => (await import('/src/services/terminalSuggestions/diagnostics.ts')).recentRecommendationTraces().at(-1))
  expect(trace).toMatchObject({ route: 'ai', modelCalled: true, context: 'disabled', outcome: 'empty' })
})

test('the production terminal composes a real cloud adapter request and inserts its whole response', async ({ page }) => {
  await page.route('**/src/services/ws.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/services/ws.ts?actual';
    const encoder = new TextEncoder();
    let output;
    window.productionInputs = [];
    export function resizeTerminal() {}
    export function setTerminalOutputHandler(id, handler) {
      output = handler;
      if (handler) setTimeout(() => { handler(encoder.encode('dev@host:~$ ')); window.productionReady = true; }, 0);
    }
    export function sendTerminalInput(id, payload) {
      const text = new TextDecoder().decode(payload);
      window.productionInputs.push({ id, text });
      output?.(encoder.encode(text === '\\r' ? '\\r\\ndev@host:~$ ' : text.startsWith('\\x15') ? '\\r\\x1b[Kdev@host:~$ ' + text.slice(1) : text));
    }
  ` }))
  const command = "cd '/work/project' && python3 main.py"
  let payload: any
  let releaseCloud!: () => void
  await page.route('https://model.example/v1/chat/completions', async route => {
    payload = route.request().postDataJSON()
    await new Promise<void>(resolve => { releaseCloud = resolve })
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [{ command }] }) } }] }) })
  })
  await page.goto('/tests/terminal-suggestions-harness.html')
  await page.waitForFunction(() => (window as any).productionReady)
  await page.evaluate(async () => {
    const { initializeVault } = await import(/* @vite-ignore */ '/src/services/vault.ts')
    const { saveSuggestionPreferences } = await import(/* @vite-ignore */ '/src/services/terminalSuggestions/runtime.ts')
    await initializeVault()
    await saveSuggestionPreferences(true, true, { cloud: true, automatic: true, remoteContext: false, shareHistory: false, baseUrl: 'https://model.example/v1', model: 'test-model' }, 'synthetic-key')
  })
  await input(page).focus()
  await page.keyboard.type('python main')
  const popup = page.locator('.terminal-command-suggestions')
  await expect(popup.getByRole('status')).toHaveText('正在准备建议')
  await expect(popup.locator('.terminal-command-status')).toHaveCount(0)
  await expect.poll(() => popup.evaluate(element => getComputedStyle(element, '::before').animationName)).toBe('terminal-command-flow')
  expect((await popup.boundingBox())!.width).toBeLessThan(150)
  const emptyHeight = (await popup.boundingBox())!.height
  const directory = join(tmpdir(), 'seal-e2e', 'command-suggestions')
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, 'cloud-working.png') })
  releaseCloud()
  await expect(options(page).filter({ hasText: command })).toBeVisible()
  expect((await popup.boundingBox())!.height).toBe(emptyHeight)
  expect(JSON.parse(payload.messages[1].content)).toMatchObject({ input: 'python main', history: [] })
  await page.screenshot({ path: join(directory, 'cloud-recommendation.png') })
  await options(page).filter({ hasText: command }).click()
  expect(await page.evaluate(() => (window as any).productionInputs.at(-1))).toEqual({ id: 'production-session', text: '\x15' + command })
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(async () => {
    const { readCommandHistory } = await import(/* @vite-ignore */ '/src/services/storage.ts')
    return readCommandHistory('production-host')
  })).toEqual([expect.objectContaining({ command, uses: 1, accepted: 1 })])
})
