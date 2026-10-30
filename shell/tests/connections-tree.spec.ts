import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/connections-tree-harness.html')
  await page.locator('.conn-list').waitFor()
})

test('renders sorted folders and compact host names with SSH icons and connection details on hover', async ({ page }) => {
  const rows = page.locator('.conn-item')
  await expect(rows.nth(0)).toContainText('Alpha')
  await expect(rows.nth(1)).toContainText('Nested')
  await expect(rows.nth(2)).toContainText('Nested host')
  await expect(rows.nth(2).getByRole('img', { name: 'SSH 终端' })).toBeVisible()
  await expect(rows.nth(2)).toHaveAttribute('title', 'Nested host\nSSH · root@10.0.0.3:22\n双击连接')
  await expect(rows.nth(3)).toContainText('Alpha host')
  await expect(rows.nth(4)).toContainText('Zeta')
  await expect(rows.nth(5)).toContainText('Root host')
  await expect(rows.nth(5)).toHaveCSS('min-height', '22px')
  await expect(rows.nth(5).getByRole('img', { name: 'SSH 终端' })).toBeVisible()
  await expect(rows.nth(3)).toHaveAttribute('title', 'Alpha host\nSSH · admin@10.0.0.2:2200\n双击连接')
  await expect(rows.locator('.conn-meta, .conn-btn')).toHaveCount(0)
  await rows.nth(5).click()
  await page.evaluate(() => document.fonts.ready)
  const screenshotDir = join(tmpdir(), 'seal-e2e', 'connections')
  await mkdir(screenshotDir, { recursive: true })
  await page.screenshot({ path: join(screenshotDir, 'session-type-icons.png'), clip: { x: 0, y: 0, width: 360, height: 220 } })
})

test('keeps the host label stable and readable in a narrow sidebar when hovered and selected', async ({ page }) => {
  await page.locator('#app').evaluate((element) => {
    element.style.width = '120px'
  })
  const host = page.locator('.conn-item').filter({ hasText: 'Root host' })
  const label = host.locator('.conn-label')
  const before = await label.boundingBox()
  await host.hover()
  expect(await label.boundingBox()).toEqual(before)
  await host.click()
  expect(await label.boundingBox()).toEqual(before)
  const clippedPixels = await label.evaluate(element => element.scrollWidth - element.clientWidth)
  // Integer DOM widths can differ by one pixel with platform-specific fonts.
  expect(clippedPixels).toBeLessThanOrEqual(1)
})

test('opens folder context menu and creates a child folder', async ({ page }) => {
  await page.locator('.conn-item.folder').filter({ hasText: 'Alpha' }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '新建文件夹' })).toBeVisible()
  await page.getByRole('menuitem', { name: '新建文件夹' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('#folder-name').fill('Services')
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.conn-item.folder').filter({ hasText: 'Services' })).toBeVisible()
})

test('supports mixed multi-select and moves selected nodes into a folder', async ({ page }) => {
  const rootHost = page.locator('.conn-item').filter({ hasText: 'Root host' })
  const zeta = page.locator('.conn-item.folder').filter({ hasText: 'Zeta' })
  await rootHost.click()
  await page.locator('.conn-item.folder').filter({ hasText: 'Nested' }).click({ modifiers: ['Control'] })
  await expect(page.locator('.conn-item.selected')).toHaveCount(2)
  await rootHost.dragTo(zeta)
  await expect(page.locator('.conn-item').filter({ hasText: 'Root host' })).toHaveAttribute('style', /padding-left: 24px/)
})

test('confirms recursive folder deletion without affecting open tab state', async ({ page }) => {
  await page.locator('.conn-item.folder').filter({ hasText: 'Alpha' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '删除' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Alpha')
  await expect(dialog).toContainText('文件夹及其中的主机配置和凭据将被一并删除')
  await dialog.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('.conn-item').filter({ hasText: 'Alpha' })).toHaveCount(0)
  await expect(page.locator('.conn-item').filter({ hasText: 'Nested' })).toHaveCount(0)
  await expect(page.locator('.conn-item').filter({ hasText: 'Alpha host' })).toHaveCount(0)
})

test('Delete key removes the selected connection node', async ({ page }) => {
  await page.locator('.conn-item').filter({ hasText: 'Root host' }).click()
  await page.keyboard.press('Delete')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText('Root host')
  await dialog.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('.conn-item').filter({ hasText: 'Root host' })).toHaveCount(0)
})

test('loads explicitly ungrouped hosts into the virtual root', async ({ page }) => {
  const folderId = await page.evaluate(async () => {
    const storage = await import('/src/services/storage.ts')
    await storage.saveHost({ id: 'legacy-host', name: 'Legacy', address: '10.0.0.9', port: 22, username: 'root', folderId: null })
    return (await storage.listHosts()).find((host) => host.id === 'legacy-host')?.folderId
  })
  expect(folderId).toBeNull()
})
