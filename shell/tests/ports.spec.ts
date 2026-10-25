import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/tests/monitoring-harness.html') })

test('shares the bottom container, keeps file history and toggles the empty ports view', async ({ page }) => {
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  await page.getByRole('tab', { name: '文件编辑', exact: true }).click()
  await page.getByRole('button', { name: '端口转发 0', exact: true }).click()
  await expect(page.getByRole('tab', { name: '端口转发', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: '文件管理', exact: true })).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByText('从终端或会话列表右键打开端口转发')).toBeVisible()
  await expect(page.locator('.workspace-panel')).toHaveCount(1)
  await page.getByRole('button', { name: '端口转发 0', exact: true }).click()
  await expect(page.locator('.workspace-panel')).toBeHidden()
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  await expect(page.getByRole('tab', { name: '文件编辑', exact: true })).toHaveAttribute('aria-selected', 'true')
})

test('locates only on demand and deduplicates by saved profile through both menus', async ({ page }) => {
  await page.locator('.test-host').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开端口转发', exact: true }).click()
  await expect(page.getByRole('button', { name: '端口转发 1', exact: true })).toBeVisible()
  await page.locator('.test-terminal').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开端口转发', exact: true }).click()
  await expect(page.locator('.ports-panel:visible')).toHaveCount(1)
  await page.evaluate(async () => {
    const { store } = (window as any).monitorFixture
    store.hosts.push({ ...store.hosts[0], id: 'b', name: '第二配置' })
    const { openPorts } = await import('/src/services/ports/runtime.ts')
    openPorts('b')
  })
  await expect(page.locator('.ports-panel:visible')).toHaveCount(1)
  await expect(page.getByRole('button', { name: '端口转发 2', exact: true })).toBeVisible()
  await expect(page.locator('.workspace-instance.active')).toContainText('第二配置')
  await page.getByRole('button', { name: '打开或定位当前终端的端口转发', exact: true }).click()
  await expect(page.locator('.workspace-instance.active')).toContainText('测试服务器')
  await page.evaluate(() => { (window as any).monitorFixture.store.activeTerminalTabId = '' })
  await expect(page.getByRole('button', { name: '打开或定位当前终端的端口转发', exact: true })).toBeDisabled()
})

test('validates targets inline and keeps failed checked rules distinct from disabled rules', async ({ page }) => {
  await page.locator('.test-host').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开端口转发', exact: true }).click()
  const panel = page.locator('.ports-panel:visible')
  await panel.getByRole('button', { name: '添加端口转发', exact: true }).first().click()
  const input = panel.getByRole('textbox', { name: '新的转发目标' })
  await input.fill('not a target'); await input.press('Enter')
  await expect(panel.getByRole('alert')).toContainText('请输入端口或地址:端口')
  await input.fill('10.0.0.8:5432'); await input.press('Enter')
  const row = panel.locator('[data-port-id="10.0.0.8:5432"]')
  await expect(row).toHaveAttribute('data-status', 'failed')
  await expect(row.getByRole('checkbox')).toBeChecked()
  const localPort = row.getByRole('textbox')
  await localPort.fill('15432'); await localPort.press('Enter')
  await expect(localPort).toHaveValue('15432')
  await row.getByRole('checkbox').uncheck()
  await expect(row).toHaveAttribute('data-status', 'disabled')
  await row.getByRole('button', { name: '删除转发规则' }).click()
  await expect(row).toHaveCount(0)
})

test('sorts and resizes all data columns without changing rules, edits or enabled state', async ({ page }) => {
  await page.locator('.test-host').click({ button: 'right' })
  await page.getByRole('menuitem', { name: '打开端口转发', exact: true }).click()
  const panel = page.locator('.ports-panel:visible')
  await expect(panel.locator('.ports-notice.error')).toBeVisible()
  await page.evaluate(() => {
    const state = (window as any).monitorFixture.store.tabs.find((tab: any) => tab.kind === 'port').ports
    state.rows = [
      { id: 'db:9000', host: 'db', port: 9000, localPort: 12000, enabled: true, status: 'active', listening: true },
      { id: 'db:80', host: 'db', port: 80, localPort: 80, enabled: false, status: 'disabled', listening: false },
      { id: 'api:3000', host: 'api', port: 3000, localPort: 3000, enabled: true, status: 'failed', listening: null },
    ].map(row => ({ ...row, configured: true, error: '' }))
  })
  const ids = () => panel.locator('[data-port-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-port-id')))
  const defaults = ['db:9000', 'db:80', 'api:3000']
  for (const label of ['远端地址', '本机端口', '状态', '发现']) {
    const button = panel.getByRole('button', { name: `按${label}排序`, exact: true })
    const header = panel.getByRole('columnheader').filter({ has: page.getByRole('button', { name: `按${label}排序`, exact: true }) })
    await button.scrollIntoViewIfNeeded()
    const bounds = (await button.boundingBox())!
    await button.click({ position: { x: bounds.width - 14, y: bounds.height / 2 } })
    await expect(header).toHaveAttribute('aria-sort', 'ascending')
    if (label === '远端地址') await expect.poll(ids).toEqual(['api:3000', 'db:80', 'db:9000'])
    if (label === '本机端口') await expect.poll(ids).toEqual(['db:80', 'api:3000', 'db:9000'])
    const ascending = await ids()
    await button.press('Space')
    await expect(header).toHaveAttribute('aria-sort', 'descending')
    await expect.poll(ids).toEqual([...ascending].reverse())
    await button.press('Enter')
    await expect(header).toHaveAttribute('aria-sort', 'none')
    await expect.poll(ids).toEqual(defaults)
  }
  const input = panel.locator('[data-port-id="db:80"]').getByRole('textbox')
  await input.fill('8080')
  await input.press('Escape')
  await expect(input).toHaveValue('80')
  await input.fill('8080')
  // Clicking a header commits the normal blur edit, then sorts the latest value.
  await panel.getByRole('button', { name: '按本机端口排序' }).click()
  await expect(input).toHaveValue('8080')
  await expect.poll(ids).toEqual(['api:3000', 'db:80', 'db:9000'])
  await expect(panel.locator('[data-port-id="db:9000"]').getByRole('checkbox')).toBeChecked()
  await expect(panel.locator('[data-port-id="db:80"]').getByRole('checkbox')).not.toBeChecked()
  const handle = panel.getByRole('separator', { name: '调整远端地址列宽' })
  const header = panel.getByRole('columnheader').nth(1)
  const original = (await header.boundingBox())!.width
  await handle.scrollIntoViewIfNeeded()
  const bounds = (await handle.boundingBox())!
  await page.mouse.move(bounds.x + 3, bounds.y + 10)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 53, bounds.y + 10)
  await page.mouse.up()
  expect((await header.boundingBox())!.width).toBeGreaterThan(original + 45)
  await handle.focus()
  await handle.press('Home')
  await expect(handle).toHaveAttribute('aria-valuenow', '110')
  await handle.press('ArrowRight')
  await expect(handle).toHaveAttribute('aria-valuenow', '120')
  await expect(panel.getByRole('columnheader').nth(2)).toHaveAttribute('aria-sort', 'ascending')
  await expect(panel.locator('[data-port-id="db:80"]')).toHaveCSS('height', '22px')
  await expect(input).toHaveCSS('font-size', '13px')
  expect(await page.evaluate(() => (window as any).monitorFixture.store.tabs.find((tab: any) => tab.kind === 'port').ports.rows.map((row: any) => row.id))).toEqual(defaults)
})
