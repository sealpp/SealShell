import { test, expect } from '@playwright/test'

declare global {
  interface Window {
    transferHarness: {
      start(label: string): void
      progress(label: string, value: number): void
      finish(label: string, orphanPath?: string): void
      fail(label: string): void
      showEncoding(): void
    }
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/transfer-status-harness.html')
})

test('opens empty details from the right edge and restores keyboard focus on Escape', async ({ page }) => {
  const status = page.locator('.transfer-status')
  const details = page.getByRole('dialog', { name: '传输详情', exact: true })
  await expect(status).toHaveText('传输')
  await expect(details).toBeHidden()
  await status.focus()
  await status.press('Enter')
  await expect(details).toContainText('暂无传输任务')
  const statusBox = (await status.boundingBox())!
  const detailBox = (await details.boundingBox())!
  expect(Math.abs(statusBox.x + statusBox.width - page.viewportSize()!.width)).toBeLessThan(2)
  expect(detailBox.y + detailBox.height).toBeLessThanOrEqual(statusBox.y)
  await page.keyboard.press('Escape')
  await expect(details).toBeHidden()
  await expect(status).toBeFocused()
})

test('keeps closed details closed through progress, completion and another transfer', async ({ page }) => {
  const status = page.locator('.transfer-status')
  const details = page.getByRole('dialog', { name: '传输详情', exact: true })
  await page.evaluate(() => window.transferHarness.start('archive.zip'))
  await expect(details).toBeHidden()
  await expect(status.locator('.spinning')).toBeVisible()
  await page.evaluate(() => window.transferHarness.progress('archive.zip', 42))
  await expect(status).toHaveText('传输 · 42%')
  await status.click()
  await expect(details).toContainText('archive.zip')
  await details.getByRole('button', { name: '关闭传输详情', exact: true }).click()
  for (const value of [55, 75, 99]) {
    await page.evaluate(value => window.transferHarness.progress('archive.zip', value), value)
    await expect(status).toHaveText(`传输 · ${value}%`)
    await expect(details).toBeHidden()
  }
  await page.evaluate(() => window.transferHarness.finish('archive.zip'))
  await expect(status).toHaveText('传输 · 已完成 1')
  await expect(details).toBeHidden()
  await expect(status.locator('.spinning')).toHaveCount(0)
  await status.click()
  await expect(details).toContainText('已完成')
  await status.click()
  await expect(details).toBeHidden()
  await page.evaluate(() => window.transferHarness.start('next.zip'))
  await expect(status).toHaveText('传输 · 0%')
  await expect(details).toBeHidden()
})

test('shows queued work and failures while preserving access to cancel and retry', async ({ page }) => {
  const status = page.locator('.transfer-status')
  const details = page.getByRole('dialog', { name: '传输详情', exact: true })
  await page.evaluate(() => ['one.zip', 'two.zip', 'three.zip'].forEach(label => window.transferHarness.start(label)))
  await expect(status).toHaveText('传输 · 2 项进行中 · 等待 1')
  await status.click()
  const queued = details.locator('.transfer-task').filter({ hasText: 'three.zip' })
  await queued.getByRole('button', { name: '取消', exact: true }).click()
  await expect(queued).toContainText('已取消')
  await expect(status).not.toContainText('等待')
  await details.getByRole('button', { name: '关闭传输详情', exact: true }).click()
  await page.evaluate(() => window.transferHarness.fail('one.zip'))
  await expect(status).toContainText('需处理 1')
  await expect(status).toHaveClass(/attention/)
  await expect(details).toBeHidden()
  await page.evaluate(() => window.transferHarness.progress('two.zip', 60))
  await expect(status).toHaveText('传输 · 60% · 需处理 1')
  await status.click()
  const failed = details.locator('.transfer-task').filter({ hasText: 'one.zip' })
  await expect(failed).toContainText('连接中断')
  await failed.getByRole('button', { name: '重试', exact: true }).click()
  await expect(failed).toContainText('传输中')
  await expect(status).not.toHaveClass(/attention/)
  await page.evaluate(() => { window.transferHarness.finish('one.zip'); window.transferHarness.finish('two.zip') })
  await expect(details).toBeVisible()
  await expect(details.locator('.task-head').filter({ hasText: '已完成' })).toHaveCount(2)
})

test('keeps retained files visible as warnings after successful transfers', async ({ page }) => {
  const status = page.locator('.transfer-status')
  await page.evaluate(() => { window.transferHarness.start('backup.zip'); window.transferHarness.finish('backup.zip', '/target/.sealshell.previous') })
  await expect(status).toHaveText('传输 · 需处理 1')
  await expect(status).toHaveClass(/attention/)
  await expect(status).toHaveAttribute('title', /保留文件 1/)
  await status.click()
  const details = page.getByRole('dialog', { name: '传输详情', exact: true })
  await expect(details).toContainText('/target/.sealshell.previous')
  await details.getByRole('button', { name: '移除记录', exact: true }).click()
  await expect(details).toContainText('暂无传输任务')
  await expect(status).toHaveText('传输')
})

test('keeps encoding beside the transfer preview and respects reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => { window.transferHarness.showEncoding(); window.transferHarness.start('archive.zip') })
  const status = page.locator('.transfer-status')
  const encoding = page.getByRole('button', { name: 'UTF-8', exact: true })
  await expect(encoding).toBeVisible()
  const statusBox = (await status.boundingBox())!
  const encodingBox = (await encoding.boundingBox())!
  expect(Math.abs(encodingBox.x + encodingBox.width - statusBox.x)).toBeLessThan(2)
  expect(Math.abs(statusBox.x + statusBox.width - 900)).toBeLessThan(2)
  await expect(status.locator('.spinning')).toHaveCSS('animation-name', 'none')
})
