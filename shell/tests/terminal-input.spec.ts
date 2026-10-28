import { expect, test, type Page } from '@playwright/test'

async function sentText(page: Page) {
  return page.evaluate(() => new TextDecoder().decode(new Uint8Array((window as any).terminalInputBytes.flat())))
}

test.beforeEach(async ({ page }) => {
  await page.route('**/src/services/ws.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/services/ws.ts?actual';
    let output;
    window.terminalInputBytes = [];
    export function resizeTerminal() {}
    export function setTerminalOutputHandler(id, handler) {
      output = handler;
      if (handler) setTimeout(() => {
        handler(new TextEncoder().encode('dev@host:~$ '));
        window.terminalInputReady = true;
      }, 0);
    }
    export function sendTerminalInput(id, payload) {
      window.terminalInputBytes.push([...payload]);
      // Split every multibyte character at the receive boundary.
      for (const byte of payload) output?.(new Uint8Array([byte]));
    }
  ` }))
  await page.goto('/tests/terminal-suggestions-harness.html')
  await page.waitForFunction(() => (window as any).terminalInputReady)
  await page.locator('.xterm-screen').click()
})

test('UTF-8 paste preserves Chinese at both ends and across output chunks', async ({ page }) => {
  const text = '中文开头 echo 测试 中文结尾'
  await page.locator('.xterm-helper-textarea').evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
  await expect.poll(() => sentText(page)).toBe(text)
  await expect(page.locator('.xterm-rows')).toContainText(text)
})

test('browser IME commits each Chinese phrase exactly once', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page)
  for (const phrase of ['中文', '连续输入', '测试']) {
    await cdp.send('Input.imeSetComposition', { text: phrase, selectionStart: phrase.length, selectionEnd: phrase.length })
    await expect(page.locator('.terminal-command-suggestions')).toHaveCount(0)
    await cdp.send('Input.insertText', { text: phrase })
  }
  await expect.poll(() => sentText(page)).toBe('中文连续输入测试')
  await expect(page.locator('.xterm-rows')).toContainText('中文连续输入测试')
})

test('GBK selection sends GBK bytes for Chinese', async ({ page }) => {
  await page.evaluate(async () => {
    const { store } = await import(/* @vite-ignore */ '/src/stores/app.ts')
    store.tabs[0].encoding = 'gbk'
  })
  await page.keyboard.insertText('中文')
  expect(await page.evaluate(() => (window as any).terminalInputBytes.flat())).toEqual([0xd6, 0xd0, 0xce, 0xc4])
  await expect(page.locator('.xterm-rows')).toContainText('中文')
})
