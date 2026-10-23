import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/monitoring-harness.html')
})

async function openFrom(page: Page, source: 'host' | 'terminal') {
  await page.locator(`.test-${source}`).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开性能监测', exact: true }).click()
}

test('shares one bottom panel between two status entries and remembers the file category', async ({ page }) => {
  await page.getByRole('button', { name: '性能监测 0', exact: true }).click()
  await expect(page.getByText('从终端或会话列表右键打开性能监测')).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(5)
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  await expect(page.getByRole('tab', { name: '文件列表', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: '文件编辑', exact: true }).click()
  await page.getByRole('button', { name: '性能监测 0', exact: true }).click()
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  await expect(page.getByRole('tab', { name: '文件编辑', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.workspace-panel')).toHaveCount(1)
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  await expect(page.locator('.workspace-panel')).toBeHidden()
})

test('both context menus locate the same instance after configuration changes', async ({ page }) => {
  await openFrom(page, 'host')
  await expect(page.getByRole('button', { name: '性能监测 1', exact: true })).toBeVisible()
  await expect(page.locator('.metrics-header')).toContainText('user@old-host:22')
  await page.evaluate(() => {
    const { store } = (window as any).monitorFixture
    store.hosts[0].address = 'new-host'
    store.hosts[0].name = '新名字'
  })
  await page.getByRole('button', { name: '性能监测 1', exact: true }).click()
  await openFrom(page, 'terminal')
  await expect(page.locator('.workspace-category-view.active .workspace-instance')).toHaveCount(1)
  await expect(page.locator('.metrics-header')).toContainText('user@old-host:22')
  await expect(page.locator('.metrics-header')).toContainText('测试服务器')
  await page.locator('.workspace-category-view.active .workspace-instance-close').click()
  await openFrom(page, 'terminal')
  await expect(page.locator('.metrics-header')).toContainText('user@new-host:22')
  await expect(page.locator('.metrics-header')).toContainText('新名字')
})

test('preserves monitors after deleting the profile and closing its terminal', async ({ page }) => {
  await openFrom(page, 'terminal')
  await page.evaluate(() => {
    const { store, closeTabs } = (window as any).monitorFixture
    store.hosts = []
    closeTabs(['terminal-a'])
  })
  await expect(page.locator('.metrics-header')).toContainText('old-host')
  await page.getByRole('button', { name: '性能监测 1', exact: true }).click()
  await expect(page.locator('.workspace-panel')).toBeHidden()
  await expect(page.getByRole('button', { name: '性能监测 1', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '性能监测 1', exact: true }).click()
  await page.locator('.workspace-category-view.active .workspace-instance-close').click()
  await expect(page.getByRole('button', { name: '性能监测 0', exact: true })).toBeVisible()
  await expect(page.getByText('从终端或会话列表右键打开性能监测')).toBeVisible()
})

test('fits four metrics horizontally and reflows when the workspace narrows', async ({ page }) => {
  await openFrom(page, 'host')
  await page.evaluate(() => {
    const { store } = (window as any).monitorFixture
    const tab = store.tabs.find((item: any) => item.kind === 'monitor')
    tab.state = 'online'
    tab.monitor.telemetry = { sampledAt: Date.now(), metrics: Object.fromEntries(['cpu.usage', 'memory.usage', 'disk.usage', 'process.count'].map(id => [id, { value: 42, unit: '', quality: 'valid' }])) }
  })
  await expect(page.locator('[data-metric-value]')).toHaveCount(4)
  await expect.poll(() => page.locator('[data-metric-value]').evaluateAll(items => new Set(items.map(item => item.getBoundingClientRect().top)).size)).toBe(1)
  await page.setViewportSize({ width: 720, height: 720 })
  await expect.poll(() => page.locator('[data-metric-value]').evaluateAll(items => new Set(items.map(item => item.getBoundingClientRect().top)).size)).toBe(2)
  await expect(page.locator('.metrics-panel')).toBeVisible()
})
