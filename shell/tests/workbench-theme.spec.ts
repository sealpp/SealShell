import { test, expect, type Page } from '@playwright/test'

async function openWorkbench(page: Page) {
  await page.goto('/')
  const pairing = page.getByRole('dialog', { name: '配对 Node', exact: true })
  await expect(pairing).toBeVisible()
  await pairing.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    store.hosts = ['生产服务器', '测试服务器'].map((name, index) => ({
      id: `theme-${index}`, name, address: `192.0.2.${index + 1}`, port: 22, username: 'root', folderId: null,
    }))
  })
}

test('keeps activity indicators centered and distinguishes focused and unfocused tree selection', async ({ page }) => {
  await openWorkbench(page)
  const activity = page.locator('.activity .icon')
  await expect(activity).toHaveCSS('width', '48px')
  await expect(activity).toHaveCSS('height', '48px')
  await expect(page.locator('.activity')).toHaveCSS('background-color', 'rgb(24, 24, 24)')
  await expect(page.locator('.statusbar')).toHaveCSS('height', '22px')
  const host = page.locator('.conn-item').filter({ hasText: '生产服务器' })
  await host.click()
  await expect(host).toHaveCSS('background-color', 'rgb(4, 57, 94)')
  await expect(host).toHaveCSS('height', '22px')
  await expect(host).toHaveCSS('border-left-width', '0px')
  await page.locator('.workbench-menu-trigger').focus()
  await expect(host).toHaveCSS('background-color', 'rgb(55, 55, 61)')
  const before = await activity.boundingBox()
  await activity.click()
  await activity.click()
  expect(await activity.boundingBox()).toEqual(before)
})

test('keeps portal menus and dock tabs on the workbench palette when the terminal theme changes', async ({ page }) => {
  await openWorkbench(page)
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    store.tabs = ['one', 'two'].map(id => ({
      id, kind: 'terminal', hostId: 'theme-0', label: id, state: 'idle', error: '',
      sessionId: id, terminalId: id, encoding: 'utf-8',
    }))
    store.activeTerminalTabId = 'one'
    store.view = 'shell'
  })
  const tab = page.locator('.main-dock .dv-tab.dv-active-tab')
  await expect(tab).toHaveCSS('background-color', 'rgb(31, 31, 31)')
  const tabBox = await tab.boundingBox()
  expect(tabBox!.height).toBe(35)
  await page.evaluate(async () => {
    const { syncTerminalChrome } = await import('/src/services/terminalPreferences.ts')
    syncTerminalChrome('Campbell Powershell')
  })
  await expect(tab).toHaveCSS('background-color', 'rgb(31, 31, 31)')
  await expect(page.locator('.activity')).toHaveCSS('background-color', 'rgb(24, 24, 24)')
  await page.locator('.workbench-menu-trigger').click()
  const menu = page.getByRole('menu')
  await expect(menu).toHaveCSS('background-color', 'rgb(31, 31, 31)')
  await expect(menu).toHaveCSS('border-radius', '8px')
  const settings = menu.getByRole('menuitem', { name: '设置', exact: true })
  await settings.hover()
  await expect(settings).toHaveCSS('background-color', 'rgb(0, 120, 212)')
  await expect(settings).toHaveCSS('height', '24px')
  const inset = await settings.evaluate(item => item.getBoundingClientRect().left - item.parentElement!.getBoundingClientRect().left)
  expect(inset).toBeGreaterThanOrEqual(4)
  await page.keyboard.press('Escape')
})
