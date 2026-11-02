import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/terminal-file-drop-harness.html')
  await expect(page.locator('.xterm-screen')).toHaveCount(2)
})

test('shows the pointed pane and keeps internal drags unchanged', async ({ page }) => {
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['contents'], 'a.txt'))
    document.querySelector('[data-pane="right"] .shell-terminal')!.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }))
  })
  await expect(page.locator('[data-pane="right"] .terminal-file-drop')).toContainText('alice@right.example:/srv/right')
  await expect(page.locator('[data-pane="left"] .terminal-file-drop')).toHaveCount(0)
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['contents'], 'a.txt'))
    document.querySelector('[data-pane="right"] .shell-terminal')!.dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: transfer }))
    const internal = new DataTransfer()
    internal.setData('application/x-sealshell-files', 'fixture')
    document.querySelector('[data-pane="left"] .shell-terminal')!.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: internal }))
  })
  await expect(page.locator('.terminal-file-drop')).toHaveCount(0)
})

test('reports an unknown directory without changing it or navigating away', async ({ page }) => {
  await page.evaluate(() => {
    ;(window as any).dropFixture.store.tabs[0].cwd = undefined
    const transfer = new DataTransfer()
    transfer.items.add(new File(['contents'], 'a.txt'))
    const pane = document.querySelector('[data-pane="left"] .shell-terminal')!
    pane.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }))
  })
  await expect(page.locator('.terminal-file-drop')).toContainText('无法获取当前终端目录')
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['contents'], 'a.txt'))
    document.querySelector('[data-pane="left"] .shell-terminal')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await expect(page.getByRole('alert')).toContainText('无法获取当前终端目录')
  await page.getByRole('button', { name: '关闭上传错误' }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(page.url()).toContain('terminal-file-drop-harness.html')
})

test('prevents file navigation outside the terminal without consuming text drops', async ({ page }) => {
  const prevented = await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['contents'], 'a.txt'))
    const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
    document.body.dispatchEvent(drop)
    const text = new DataTransfer()
    text.setData('text/plain', 'hello')
    const textDrop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: text })
    document.body.dispatchEvent(textDrop)
    return [drop.defaultPrevented, textDrop.defaultPrevented]
  })
  expect(prevented).toEqual([true, false])
})
