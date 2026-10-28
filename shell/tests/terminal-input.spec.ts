import { expect, test, type Page } from '@playwright/test'

async function sentText(page: Page) {
  return page.evaluate(() => new TextDecoder().decode(new Uint8Array((window as any).terminalInputBytes.flat())))
}

async function paste(page: Page, text: string) {
  await page.locator('.xterm-helper-textarea').evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, text)
}

test.beforeEach(async ({ page }) => {
  await page.route('**/src/services/ws.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/services/ws.ts?actual';
    import { SshWorkerClient } from '/src/services/ssh/ssh-worker-client.ts';
    let output;
    window.terminalInputBytes = [];
    const client = new SshWorkerClient({
      postMessage(message, transfer) {
        const received = structuredClone(message, { transfer });
        const payload = new Uint8Array(received.payload);
        window.terminalInputBytes.push([...payload]);
        // Split every multibyte character at the receive boundary.
        for (const byte of payload) output?.(new Uint8Array([byte]));
      }
    });
    export function resizeTerminal() {}
    export function setTerminalOutputHandler(id, handler) {
      output = handler;
      if (handler) setTimeout(() => {
        handler(new TextEncoder().encode('dev@host:~$ '));
        window.terminalInputReady = true;
      }, 0);
    }
    export function sendTerminalInput(id, payload) {
      client.send(payload);
    }
  ` }))
  await page.goto('/tests/terminal-suggestions-harness.html')
  await page.waitForFunction(() => (window as any).terminalInputReady)
  await page.locator('.xterm-screen').click()
})

test('UTF-8 paste preserves Chinese at both ends and across output chunks', async ({ page }) => {
  const text = '中文开头 echo 测试 中文结尾'
  await paste(page, text)
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

for (const method of ['insert', 'paste', 'composition'] as const) {
  test(`GBK selection sends GBK bytes for Chinese ${method}`, async ({ page, context }) => {
    await page.evaluate(async () => {
      const { store } = await import(/* @vite-ignore */ '/src/stores/app.ts')
      store.tabs[0].encoding = 'gbk'
    })
    if (method === 'paste') await paste(page, '中文')
    else if (method === 'composition') {
      const cdp = await context.newCDPSession(page)
      await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 })
      expect(await page.evaluate(() => (window as any).terminalInputBytes)).toEqual([])
      await cdp.send('Input.insertText', { text: '中文' })
    } else await page.keyboard.insertText('中文')
    await expect.poll(() => page.evaluate(() => (window as any).terminalInputBytes.flat())).toEqual([0xd6, 0xd0, 0xce, 0xc4])
    await expect(page.locator('.xterm-rows')).toContainText('中文')
  })
}
