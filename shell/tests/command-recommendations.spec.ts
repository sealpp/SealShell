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

test('keeps natural-language input local, remembers acceptance and submitted intent separately', async ({ page }) => {
  await page.evaluate(() => { (window as any).harness.enhance(true); (window as any).harness.feedback(true); (window as any).harness.cwd('/work') })
  await page.keyboard.press('Control+Shift+Space')
  const intent = page.getByRole('textbox', { name: '想完成什么' })
  await expect(intent).toBeFocused()
  await intent.fill('查看 8080 端口')
  await expect.poll(() => requests(page)).toBe(1)
  expect(await page.evaluate(() => (window as any).harness.sent)).toEqual([])
  await respond(page, 0, ["ss -ltnp 'sport = :8080'"])
  await options(page).first().click()
  await expect.poll(() => history(page)).toEqual([expect.objectContaining({ uses: 0, accepted: 1, intents: ['查看 8080 端口'] })])
  expect(await page.evaluate(() => (window as any).harness.sent)).toEqual(["ss -ltnp 'sport = :8080'"])
  await page.keyboard.press('Enter')
  await expect.poll(() => history(page)).toEqual([expect.objectContaining({ uses: 1, accepted: 1, contexts: [expect.objectContaining({ cwd: '/work' })] })])
  await page.evaluate(() => (window as any).harness.enhance(false))
  await page.keyboard.press('Control+Shift+Space')
  await intent.fill('查看 8080')
  await expect(options(page).first()).toContainText("ss -ltnp 'sport = :8080'")
  await page.keyboard.press('Escape')
  await expect(intent).toHaveCount(0)
  await expect(input(page)).toBeFocused()
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

test('continuing to type after intent list navigation edits the local query', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.enhance(true))
  await page.keyboard.press('Control+Shift+Space')
  const intent = page.getByRole('textbox', { name: '想完成什么' })
  await intent.fill('run')
  await expect.poll(() => requests(page)).toBe(1)
  await respond(page, 0, ['echo run'])
  await intent.press('ArrowDown')
  await expect(options(page).first()).toBeFocused()
  await page.keyboard.type('x')
  await expect(intent).toHaveValue('runx')
  await expect.poll(() => requests(page)).toBe(2)
  await respond(page, 1, ['echo runx'])
  await intent.press('ArrowDown')
  await page.keyboard.press('Backspace')
  await expect(intent).toHaveValue('run')
  expect(await page.evaluate(() => (window as any).harness.sent)).toEqual([])
})

test('saves cloud configuration with encrypted credentials and preserves it across reload', async ({ page }) => {
  await page.getByRole('button', { name: '命令提示设置', exact: true }).click()
  await page.getByRole('checkbox', { name: '启用云端智能推荐' }).check()
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
  await expect(page.getByRole('checkbox', { name: '启用云端智能推荐' })).toBeChecked()
  await expect(page.getByRole('textbox', { name: '模型', exact: true })).toHaveValue('example-model')
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
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
  await page.route('https://model.example/v1/chat/completions', route => {
    payload = route.request().postDataJSON()
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
  await expect(options(page).filter({ hasText: command })).toBeVisible()
  expect(JSON.parse(payload.messages[1].content)).toMatchObject({ input: 'python main', mode: 'command', history: [] })
  const directory = join(tmpdir(), 'seal-e2e', 'command-suggestions')
  await mkdir(directory, { recursive: true })
  await page.screenshot({ path: join(directory, 'cloud-recommendation.png') })
  await options(page).filter({ hasText: command }).click()
  expect(await page.evaluate(() => (window as any).productionInputs.at(-1))).toEqual({ id: 'production-session', text: '\x15' + command })
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(async () => {
    const { readCommandHistory } = await import(/* @vite-ignore */ '/src/services/storage.ts')
    return readCommandHistory('production-host')
  })).toEqual([expect.objectContaining({ command, uses: 1, accepted: 1 })])
})
