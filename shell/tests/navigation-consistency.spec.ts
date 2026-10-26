import { expect, test, type Page } from '@playwright/test'

async function openSettings(page: Page) {
  await page.goto('/tests/workbench-menu-harness.html')
  await page.locator('.workbench-menu-trigger').click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  return page.getByRole('tablist', { name: '设置分类' })
}

test('settings categories share rounded selection, roving focus and keyboard activation', async ({ page }) => {
  const nav = await openSettings(page)
  const appearance = nav.getByRole('tab', { name: '外观', exact: true })
  const suggestions = nav.getByRole('tab', { name: '命令提示', exact: true })
  const ports = nav.getByRole('tab', { name: '端口转发', exact: true })
  await appearance.focus()
  await page.keyboard.press('ArrowDown')
  await expect(suggestions).toBeFocused()
  await expect(suggestions).toHaveAttribute('aria-selected', 'true')
  await expect(suggestions).toHaveCSS('border-radius', '4px')
  await suggestions.hover()
  await expect(suggestions).toHaveCSS('background-color', 'rgb(4, 57, 94)')
  await expect(nav.locator('[tabindex="0"]')).toHaveCount(1)
  await page.getByRole('switch', { name: '命令提示', exact: true }).focus()
  await expect(suggestions).toHaveCSS('background-color', 'rgb(55, 55, 61)')
  await suggestions.focus()
  await page.keyboard.press('End')
  await expect(ports).toBeFocused()
  await expect(ports).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Home')
  await expect(appearance).toBeFocused()
  await expect(appearance).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowUp')
  await expect(ports).toBeFocused()
  await expect(ports).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tabpanel', { name: '端口转发', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(ports).toBeFocused()
})

test('both pointer and keyboard category changes wait for durable saves and stay on a failed write', async ({ page }) => {
  await page.route('**/src/services/terminalPreferences.ts', route => route.fulfill({
    contentType: 'application/javascript',
    body: `
      export * from '/src/services/terminalPreferences.ts?actual';
      import { saveTerminalPreferences as persist } from '/src/services/terminalPreferences.ts?actual';
      window.failPreferenceWrite = true;
      export async function saveTerminalPreferences(value) {
        if (window.failPreferenceWrite) throw new Error('fixture save failed');
        await persist(value);
      }
    `,
  }))
  const nav = await openSettings(page)
  const appearance = nav.getByRole('tab', { name: '外观', exact: true })
  const suggestions = nav.getByRole('tab', { name: '命令提示', exact: true })
  const size = page.getByLabel('字号', { exact: true })
  await size.fill('19')
  await suggestions.click()
  await expect(appearance).toHaveAttribute('aria-selected', 'true')
  await expect(suggestions).toHaveAttribute('aria-selected', 'false')
  await expect(size).toHaveValue('19')
  await expect(page.getByRole('alert')).toContainText('fixture save failed')
  await appearance.focus()
  await page.keyboard.press('ArrowDown')
  await expect(appearance).toHaveAttribute('aria-selected', 'true')
  await expect(size).toBeVisible()
  await page.evaluate(() => { (window as any).failPreferenceWrite = false })
  await appearance.focus()
  await page.keyboard.press('ArrowDown')
  await expect(suggestions).toHaveAttribute('aria-selected', 'true')
  const saved = await page.evaluate(async () => {
    const { readMeta } = await import('/src/services/storage.ts')
    return readMeta('terminalPreferences')
  })
  expect(saved.fontSize).toBe(19)
  await page.keyboard.press('Home')
  await expect(size).toHaveValue('19')
})

test('panel categories use the same keys and preserve mounted instances while switching', async ({ page }) => {
  await page.goto('/tests/workspace-docking-harness.html')
  const nav = page.getByRole('tablist', { name: '面板视图' })
  const files = nav.getByRole('tab', { name: '文件列表', exact: true })
  const editors = nav.getByRole('tab', { name: '文件编辑', exact: true })
  const processes = nav.getByRole('tab', { name: '进程管理', exact: true })
  await expect(page.getByRole('region', { name: '远端 /srv', exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).initialFilePanel = document.querySelector('.file-panel') })
  await files.focus()
  await page.keyboard.press('ArrowRight')
  await expect(editors).toBeFocused()
  await expect(editors).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel', { name: '文件编辑', exact: true })).toBeVisible()
  await expect(nav.locator('[tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('End')
  await expect(processes).toBeFocused()
  await expect(processes).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(files).toBeFocused()
  await expect(files).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('End')
  await page.keyboard.press('Home')
  await expect(files).toBeFocused()
  await expect(page.getByRole('region', { name: '远端 /srv', exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).initialFilePanel === document.querySelector('.file-panel'))).toBe(true)
})
