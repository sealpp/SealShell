import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hint = (page: Page) => page.locator('.terminal-command-hint')
const focus = (page: Page) => page.locator('.xterm-helper-textarea').focus()
const readHistory = (page: Page, id = 'suggestions-a') => page.evaluate(id => (window as any).harness.readHistory(id), id)

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/command-suggestions-harness.html')
  await expect(page.locator('#ready')).toHaveText('true')
  await focus(page)
})

test('bundled ghost text works offline and accepts with Right without executing; native Tab and arrows pass through', async ({ page, context }) => {
  await context.setOffline(true)
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveText('status')
  expect(await page.evaluate(() => (window as any).harness.text())).not.toContain('git status')
  await page.keyboard.press('ArrowRight')
  await expect(hint(page)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as any).harness.text())).toContain('git status')
  expect(await readHistory(page)).toEqual([])
  await page.keyboard.press('Enter')
  await expect.poll(() => readHistory(page)).toEqual([expect.objectContaining({ command: 'git status', uses: 1 })])
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Tab')
  expect(await page.evaluate(() => (window as any).harness.sent.slice(-3))).toEqual(['\x1b[C', '\x1b[A', '\t'])
})

test('Enter executes only typed text, Escape dismisses one prefix, and backspace changes the match', async ({ page }) => {
  await page.keyboard.type('ls')
  await expect(hint(page)).toHaveText(' -la')
  await page.keyboard.press('Escape')
  await expect(hint(page)).toHaveCount(0)
  await page.keyboard.type(' -l')
  await expect(hint(page)).toHaveText('a')
  await page.keyboard.press('Backspace')
  await expect(hint(page)).toHaveText('la')
  await page.keyboard.press('Enter')
  await expect.poll(() => readHistory(page)).toEqual([expect.objectContaining({ command: 'ls -', uses: 1 })])
  expect(await page.evaluate(() => (window as any).harness.sent)).not.toContain('la')
  await page.keyboard.type('ls')
  await expect(hint(page)).toHaveText(' -')
})

test('waits for complete delayed echo before offering a suffix', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.echo(false))
  await page.keyboard.type('git di')
  await page.evaluate(() => (window as any).harness.write('git d'))
  await expect(hint(page)).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe('\x1b[C')
  await page.evaluate(() => (window as any).harness.reset())
  await page.keyboard.type('git di')
  await page.evaluate(() => (window as any).harness.write('git di'))
  await expect(hint(page)).toHaveText('ff')
})

test('history waits for submission echo, ranks frequency and persists across reloads without crossing connections', async ({ page }) => {
  for (const command of ['git log --all', 'git log --all', 'git diff --stat']) {
    await page.keyboard.type(command)
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await readHistory(page)).some((entry: any) => entry.command === command)).toBe(true)
  }
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveText('log --all')
  await expect(hint(page)).toHaveAttribute('data-source', 'history')
  expect(await readHistory(page, 'suggestions-b')).toEqual([])
  await page.reload()
  await expect(page.locator('#ready')).toHaveText('true')
  await focus(page)
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveText('log --all')

  await page.evaluate(() => (window as any).harness.reset())
  await page.evaluate(() => (window as any).harness.echo(false))
  await page.keyboard.type('echo 中文')
  await page.keyboard.press('Enter')
  expect((await readHistory(page)).some((entry: any) => entry.command.startsWith('echo'))).toBe(false)
  await page.evaluate(() => (window as any).harness.write('echo 中文\r\n' + 'dev@host:~$ '))
  await expect.poll(async () => (await readHistory(page)).some((entry: any) => entry.command === 'echo 中文')).toBe(true)
})

test('passwords, leading spaces, continuation prompts, alternate screens and multiline paste do not create history', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.reset('Password: '))
  await page.evaluate(() => (window as any).harness.echo(false))
  await page.keyboard.type('git-secret-password')
  await page.keyboard.press('Enter')
  await expect(hint(page)).toHaveCount(0)
  expect(await readHistory(page)).toEqual([])
  await page.evaluate(() => (window as any).harness.reset())
  await page.keyboard.type('hidden-at-shell-prompt')
  await page.keyboard.press('Enter')
  await page.evaluate(() => (window as any).harness.write('\r\n' + 'dev@host:~$ '))
  expect(await readHistory(page)).toEqual([])
  await page.evaluate(() => (window as any).harness.echo(true))
  await page.evaluate(() => (window as any).harness.reset('> '))
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveCount(0)
  await page.keyboard.press('Enter')
  await page.evaluate(() => (window as any).harness.reset())
  await page.keyboard.type(' git status')
  await page.keyboard.press('Enter')
  await page.evaluate(() => (window as any).harness.reset())
  await page.evaluate(() => (window as any).harness.write('\x1b[?1049h$ '))
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveCount(0)
  await page.keyboard.press('Enter')
  await page.evaluate(() => (window as any).harness.reset())
  await page.evaluate(() => (window as any).harness.paste('echo one\necho two'))
  await page.keyboard.press('Enter')
  await expect(hint(page)).toHaveCount(0)
  expect(await readHistory(page)).toEqual([])
})

test('pauses during IME, selection, cursor editing and focus changes; supports zsh application cursor mode', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.write('\x1b[?1h'))
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveText('status')
  await page.locator('.xterm-helper-textarea').dispatchEvent('compositionstart')
  await expect(hint(page)).toHaveCount(0)
  await page.locator('.xterm-helper-textarea').dispatchEvent('compositionend')
  await expect(hint(page)).toHaveText('status')
  await page.evaluate(() => (window as any).harness.select())
  await expect(hint(page)).toHaveCount(0)
  await page.evaluate(() => (window as any).harness.clearSelection())
  await expect(hint(page)).toHaveText('status')
  await page.getByRole('textbox', { name: 'Other input' }).focus()
  await expect(hint(page)).toHaveCount(0)
  await focus(page)
  await expect(hint(page)).toHaveText('status')
  await page.keyboard.press('ArrowLeft')
  await page.evaluate(() => (window as any).harness.write('\x1b[D'))
  await expect(hint(page)).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe('\x1bOC')
})

test('settings stop history, disable hints, persist, and clear history through the app dialog', async ({ page }) => {
  await page.keyboard.type('echo saved')
  await page.keyboard.press('Enter')
  await expect.poll(() => readHistory(page)).toHaveLength(1)
  await page.getByRole('button', { name: '命令提示设置', exact: true }).click()
  await page.getByRole('checkbox', { name: '记住当前浏览器的命令历史' }).uncheck()
  await expect(page.getByRole('status')).toContainText('已自动保存')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await focus(page)
  await page.keyboard.type('echo ')
  await expect(hint(page)).toHaveCount(0)
  await page.evaluate(() => (window as any).harness.reset())
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveText('status')
  await page.getByRole('button', { name: '命令提示设置', exact: true }).click()
  await page.getByRole('checkbox', { name: '启用本地命令提示' }).uncheck()
  await expect(page.getByRole('status')).toContainText('已自动保存')
  await page.getByRole('button', { name: '关闭', exact: true }).click()
  await focus(page)
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect.poll(() => readHistory(page)).toHaveLength(1)
  await page.reload()
  await expect(page.locator('#ready')).toHaveText('true')
  await page.getByRole('button', { name: '命令提示设置', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: '启用本地命令提示' })).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: '记住当前浏览器的命令历史' })).not.toBeChecked()
  await page.getByRole('button', { name: '清除命令历史', exact: true }).click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect.poll(() => readHistory(page)).toEqual([])
})

test('atomic persistence keeps concurrent counts and does not resurrect deleted connections', async ({ page }) => {
  await page.evaluate(() => Promise.all(Array.from({ length: 8 }, () => (window as any).harness.record('suggestions-b', 'echo concurrent'))))
  expect(await readHistory(page, 'suggestions-b')).toEqual([expect.objectContaining({ command: 'echo concurrent', uses: 8 })])
  await page.evaluate(() => (window as any).harness.deleteHosts(['suggestions-b']))
  await page.evaluate(() => (window as any).harness.record('suggestions-b', 'echo stale'))
  expect(await readHistory(page, 'suggestions-b')).toEqual([])
  await page.evaluate(async () => {
    const harness = (window as any).harness
    await harness.saveFolder({ id: 'suggestions-folder', name: 'folder', parentId: null })
    await harness.saveHost({ id: 'suggestions-b', name: 'b', address: 'test.invalid', port: 22, username: 'dev', folderId: 'suggestions-folder' })
    await harness.record('suggestions-b', 'echo nested')
    await harness.deleteFolderTree(['suggestions-folder'])
    await harness.record('suggestions-b', 'echo stale')
  })
  expect(await readHistory(page, 'suggestions-b')).toEqual([])
})

test('keeps Unicode and wrapped history intact and suppresses invisible hints at the right edge or after resize', async ({ page }) => {
  await page.evaluate(() => (window as any).harness.resize(24, 18))
  const command = 'echo 中文目录 abcdefghijklmnopqrstuvwxyz'
  await page.keyboard.insertText(command)
  await page.keyboard.press('Enter')
  await expect.poll(() => readHistory(page)).toEqual([expect.objectContaining({ command })])
  await page.keyboard.type('echo ')
  await expect(hint(page)).toHaveText(command.slice(5))
  await page.evaluate(() => (window as any).harness.resize(30, 18))
  await expect(hint(page)).toHaveCount(0)
  await page.evaluate(() => (window as any).harness.reset())
  await page.evaluate(() => (window as any).harness.resize(16, 18))
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => (window as any).harness.sent.at(-1))).toBe('\x1b[C')
})

test('the production terminal renders a hint and sends accepted text through its session input path', async ({ page }) => {
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
      output?.(encoder.encode(text === '\\r' ? '\\r\\ndev@host:~$ ' : text));
    }
  ` }))
  await page.goto('/tests/terminal-suggestions-harness.html')
  await page.waitForFunction(() => (window as any).productionReady)
  await focus(page)
  // The initial fit can resize the terminal. Wait for its settled geometry.
  await expect.poll(() => page.locator('.xterm-screen').evaluate(element => element.clientWidth)).toBeGreaterThan(300)
  await page.keyboard.type('git ')
  await expect(hint(page)).toHaveText('status')
  const screenshotDirectory = join(tmpdir(), 'seal-e2e', 'command-suggestions')
  await mkdir(screenshotDirectory, { recursive: true })
  await page.screenshot({ path: join(screenshotDirectory, 'inline.png') })
  await page.keyboard.press('ArrowRight')
  expect(await page.evaluate(() => (window as any).productionInputs.at(-1))).toEqual({ id: 'production-session', text: 'status' })
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(async () => {
    const { readCommandHistory } = await import(/* @vite-ignore */ '/src/services/storage.ts')
    return readCommandHistory('production-host')
  })).toEqual([expect.objectContaining({ command: 'git status' })])
})
