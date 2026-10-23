import { test, expect } from '@playwright/test'

const endpoints = [
  { id: 'local', label: '本地路径', initial: 'C:\\fixtures\\nested', parent: 'C:\\fixtures', root: 'C:\\' },
  { id: 'remote', label: '远端路径', initial: '/fixtures/nested', parent: '/fixtures', root: '/' },
]

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/file-navigation-harness.html')
  await expect(page.locator('.file-panel')).toHaveCount(2)
})

for (const endpoint of endpoints) {
  test(`${endpoint.id}: enables parent navigation when the session connects without changing cwd`, async ({ page }) => {
    const pane = page.locator(`[data-file-tab="${endpoint.id}"]`)
    const up = pane.getByRole('button', { name: '上级目录', exact: true })
    await expect(up).toBeDisabled()
    await expect(pane.getByRole('textbox', { name: endpoint.label })).toHaveValue(endpoint.initial)
    await page.getByRole('button', { name: '连接文件会话', exact: true }).click()
    await expect(up).toBeEnabled()
    await expect(pane.locator('.file-parent')).toHaveAttribute('aria-disabled', 'false')
    await page.getByRole('button', { name: '关闭文件会话', exact: true }).click()
    await expect(up).toBeDisabled()
  })

  test(`${endpoint.id}: double-clicks the parent row and updates navigation history`, async ({ page }) => {
    const pane = page.locator(`[data-file-tab="${endpoint.id}"]`)
    const input = pane.getByRole('textbox', { name: endpoint.label })
    await page.getByRole('button', { name: '连接文件会话', exact: true }).click()
    await pane.locator('.file-parent .file-name span:last-child').dblclick()
    await expect(input).toHaveValue(endpoint.parent)
    await pane.getByRole('button', { name: '后退', exact: true }).click()
    await expect(input).toHaveValue(endpoint.initial)
    await pane.getByRole('button', { name: '前进', exact: true }).click()
    await expect(input).toHaveValue(endpoint.parent)
  })

  test(`${endpoint.id}: disables parent navigation at the filesystem root`, async ({ page }) => {
    const pane = page.locator(`[data-file-tab="${endpoint.id}"]`)
    const input = pane.getByRole('textbox', { name: endpoint.label })
    await page.getByRole('button', { name: '连接文件会话', exact: true }).click()
    await input.fill(endpoint.root)
    await input.press('Enter')
    await expect(input).toHaveValue(endpoint.root)
    await expect(pane.getByRole('button', { name: '上级目录', exact: true })).toBeDisabled()
    await expect(pane.locator('.file-parent')).toHaveAttribute('aria-disabled', 'true')
    await expect(pane.locator('.file-parent')).toBeDisabled()
    // Intentionally target the disabled row to verify the navigation guard too.
    await pane.locator('.file-parent').dblclick({ force: true })
    await expect(input).toHaveValue(endpoint.root)
  })

  test(`${endpoint.id}: shares parent navigation between the toolbar and Alt+Up`, async ({ page }) => {
    const pane = page.locator(`[data-file-tab="${endpoint.id}"]`)
    const input = pane.getByRole('textbox', { name: endpoint.label })
    await page.getByRole('button', { name: '连接文件会话', exact: true }).click()
    await pane.getByRole('button', { name: '上级目录', exact: true }).click()
    await expect(input).toHaveValue(endpoint.parent)
    await pane.getByRole('button', { name: '后退', exact: true }).click()
    await expect(input).toHaveValue(endpoint.initial)
    await pane.focus()
    await pane.press('Alt+ArrowUp')
    await expect(input).toHaveValue(endpoint.parent)
  })
}
