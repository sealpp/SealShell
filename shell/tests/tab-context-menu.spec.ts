import { test, expect, type Page } from '@playwright/test'

async function openTabMenu(page: Page, tabIndex: number) {
  const tab = page.locator('.terminal-tab').nth(tabIndex)
  await tab.locator('.terminal-tab-label').click({ button: 'right' })
  return page.getByRole('menu')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/tab-context-menu-harness.html')
})

test('opens the ordered menu from any part of a tab', async ({ page }) => {
  const menu = await openTabMenu(page, 1)

  await expect(menu.locator('.command-menu-label')).toHaveText(['关闭', '关闭其他', '关闭右侧', '关闭全部'])
  await expect(menu.getByRole('menuitem').first().locator('.command-menu-shortcut')).toHaveText('Ctrl+W')
  await expect(menu.getByRole('menuitem', { name: '关闭右侧', exact: true })).toHaveAttribute('data-disabled', '')

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await page.locator('.terminal-tab').nth(1).locator('.terminal-tab-close').click({ button: 'right' })
  await expect(menu).toBeVisible()
})

test('closes the context tab without changing the active tab', async ({ page }) => {
  const menu = await openTabMenu(page, 1)
  await menu.getByRole('menuitem', { name: '关闭 Ctrl+W', exact: true }).click()

  await expect(page.locator('#tab-ids')).toHaveText('tab-a,tab-c,tab-d')
  await expect(page.locator('#active-tab')).toHaveText('tab-a')
})

test('closes other tabs only in the context tab group', async ({ page }) => {
  const menu = await openTabMenu(page, 1)
  await menu.getByRole('menuitem', { name: '关闭其他', exact: true }).click()

  await expect(page.locator('#tab-ids')).toHaveText('tab-b,tab-c,tab-d')
  await expect(page.locator('#active-tab')).toHaveText('tab-b')
})

test('closes tabs to the right only in the context tab group', async ({ page }) => {
  const menu = await openTabMenu(page, 0)
  await menu.getByRole('menuitem', { name: '关闭右侧', exact: true }).click()

  await expect(page.locator('#tab-ids')).toHaveText('tab-a,tab-c,tab-d')
  await expect(page.locator('#active-tab')).toHaveText('tab-a')
})

test('closes all tabs in the context group', async ({ page }) => {
  const menu = await openTabMenu(page, 1)
  await menu.getByRole('menuitem', { name: '关闭全部', exact: true }).click()

  await expect(page.locator('#tab-ids')).toHaveText('tab-c,tab-d')
  await expect(page.locator('#active-tab')).toHaveText('tab-c')
  await expect(page.locator('#view')).toHaveText('shell')
})

test('returns to the welcome view when closing the last group', async ({ page }) => {
  await page.goto('/tests/tab-context-menu-harness.html?single=1')
  const menu = await openTabMenu(page, 1)
  await menu.getByRole('menuitem', { name: '关闭全部', exact: true }).click()

  await expect(page.locator('#tab-ids')).toHaveText('')
  await expect(page.locator('#active-tab')).toHaveText('')
  await expect(page.locator('#view')).toHaveText('welcome')
})
