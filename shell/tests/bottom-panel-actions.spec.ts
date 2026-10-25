import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => { await page.goto('/tests/monitoring-harness.html') })

test('locates the earliest file tab for the saved profile and preserves its directory', async ({ page }) => {
  await page.evaluate(() => {
    const { store } = (window as any).monitorFixture
    const file = (id: string, hostId: string, kind = 'sftp') => ({
      id, kind: 'file', hostId, endpoint: kind === 'sftp' ? { kind, hostId } : { kind, nodeId: 'fixture' },
      label: id, state: 'online', error: '', sessionId: id, terminalId: '', encoding: 'utf-8', cwd: `/${id}`,
      file: { cwd: `/${id}`, defaultPath: '/', history: ['/', `/${id}`], historyIndex: 1, entries: [], selectedPaths: [], sortKey: null, sortDirection: 'asc', showHidden: false, loading: false, error: '' },
    })
    store.tabs.push(file('other-profile', 'b'), file('local', 'a', 'local'), file('first', 'a'), file('second', 'a'))
    store.activeFileTabId = 'second'
    store.tabs[0].cwd = '/new-terminal-directory'
    store.tabs.push({ ...store.tabs[0], id: 'another-terminal', sessionId: 'another-terminal' })
    store.activeTerminalTabId = 'another-terminal'
  })
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  const locate = page.getByRole('button', { name: '打开或定位当前终端的文件列表', exact: true })
  await locate.click()
  await expect(page.locator('.workspace-instance.active')).toHaveAttribute('data-tab-id', 'first')
  const first = page.locator('[data-file-tab="first"]')
  await expect(first).toBeVisible()
  await expect(first.getByRole('textbox', { name: '远端路径', exact: true })).toHaveValue('/first')
  await locate.click()
  await expect(page.locator('.workspace-category-view.active .workspace-instance')).toHaveCount(4)

  await page.evaluate(() => { (window as any).monitorFixture.store.hosts = [] })
  await expect(locate).toBeEnabled()
  await page.locator('.workspace-instance[data-tab-id="first"] .workspace-instance-close').click()
  await locate.click()
  await expect(page.locator('.workspace-instance.active')).toHaveAttribute('data-tab-id', 'second')
  await page.locator('.workspace-instance[data-tab-id="second"] .workspace-instance-close').click()
  await expect(locate).toBeDisabled()
})

test('disables terminal file actions without a terminal and hides them in the editor view', async ({ page }) => {
  await page.getByRole('button', { name: '文件管理', exact: true }).click()
  const locate = page.getByRole('button', { name: '打开或定位当前终端的文件列表', exact: true })
  await expect(locate).toBeEnabled()
  await expect(page.getByRole('button', { name: '新建本地窗口并分栏', exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).monitorFixture.store.activeTerminalTabId = '' })
  await expect(locate).toBeDisabled()
  await expect(locate).toHaveAttribute('title', '当前没有可用的终端会话')
  await page.getByRole('tab', { name: '文件编辑', exact: true }).click()
  await expect(locate).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新建本地窗口并分栏', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '最大化面板', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭面板', exact: true })).toBeVisible()
})

for (const category of ['性能监测', '端口转发', '进程管理']) {
  test(`${category} opens on demand and locates one instance per saved profile`, async ({ page }) => {
    await page.getByRole('button', { name: `${category} 0`, exact: true }).click()
    const locate = page.getByRole('button', { name: `打开或定位当前终端的${category}`, exact: true })
    await locate.click()
    await expect(page.locator('.workspace-category-view.active .workspace-instance')).toHaveCount(1)
    const firstId = await page.locator('.workspace-instance.active').getAttribute('data-tab-id')
    await page.evaluate(() => {
      const { store } = (window as any).monitorFixture
      store.tabs.push({ ...store.tabs[0], id: 'same-profile-terminal' })
      store.activeTerminalTabId = 'same-profile-terminal'
    })
    await locate.click()
    await expect(page.locator('.workspace-instance.active')).toHaveAttribute('data-tab-id', firstId!)
    await expect(page.getByRole('button', { name: `${category} 1`, exact: true })).toBeVisible()
    await page.evaluate(() => {
      const { store } = (window as any).monitorFixture
      store.hosts.push({ ...store.hosts[0], id: 'b', name: '同地址第二配置' })
      store.tabs.push({ ...store.tabs[0], id: 'other-profile-terminal', hostId: 'b' })
      store.activeTerminalTabId = 'other-profile-terminal'
    })
    await expect(page.locator('.workspace-instance.active')).toHaveAttribute('data-tab-id', firstId!)
    await locate.click()
    await expect(page.getByRole('button', { name: `${category} 2`, exact: true })).toBeVisible()
    await expect(page.locator('.workspace-instance.active')).toContainText('同地址第二配置')
    await page.evaluate(() => {
      const { store } = (window as any).monitorFixture
      store.hosts = []
      store.activeTerminalTabId = 'terminal-a'
    })
    await locate.click()
    await expect(page.locator('.workspace-instance.active')).toHaveAttribute('data-tab-id', firstId!)
    await page.evaluate(() => { (window as any).monitorFixture.store.activeTerminalTabId = '' })
    await expect(locate).toBeDisabled()
    await page.getByRole('button', { name: '关闭面板', exact: true }).click()
    await expect(page.locator('.workspace-panel')).toBeHidden()
    await expect(page.getByRole('button', { name: `${category} 2`, exact: true })).toBeVisible()
  })
}
