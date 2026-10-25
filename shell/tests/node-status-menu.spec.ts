import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/node-status-harness.html')
})

test('opens the Node menu and invokes the pairing command', async ({ page }) => {
  await page.locator('.node-status').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '配对' })).toBeVisible()

  await page.getByRole('menuitem', { name: '配对' }).click()
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(page.locator('#pairing-state')).toHaveText('true')
})

test('resolves Node commands from the current pairing context', async ({ page }) => {
  await page.evaluate(() => {
    const testWindow = window as unknown as Window & { setPaired: () => void }
    testWindow.setPaired()
  })
  await page.locator('.node-status').click()

  await expect(page.getByRole('menuitem', { name: '重新配对' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '断开当前 Node 连接' })).toBeVisible()
})
