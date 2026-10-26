import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function openSettings(page: Page) {
  await page.goto('/tests/workbench-menu-harness.html')
  await page.locator('.workbench-menu-trigger').click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
}

test('all settings categories share title typography, content alignment and navigation weight', async ({ page }) => {
  await openSettings(page)
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  const titles: Record<string, unknown> = {}
  for (const name of ['外观', '命令提示', '代理服务器', '端口转发']) {
    const tab = dialog.getByRole('tab', { name, exact: true })
    await tab.click()
    await expect(tab).toHaveCSS('font-weight', '400')
    titles[name] = await dialog.getByRole('heading', { name, level: 2, exact: true }).evaluate(heading => {
      const style = getComputedStyle(heading)
      const content = heading.closest('.settings-main')!
      const container = getComputedStyle(content)
      return {
        font: style.fontFamily, size: style.fontSize, weight: style.fontWeight, color: style.color,
        top: container.paddingTop, left: container.paddingLeft, right: container.paddingRight,
      }
    })
  }
  for (const name of ['命令提示', '代理服务器', '端口转发']) expect(titles[name], name).toEqual(titles['外观'])
})

for (const width of [1280, 375]) {
  test(`settings fields share geometry and focus feedback without horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await openSettings(page)
    const dialog = page.getByRole('dialog', { name: '设置', exact: true })
    const styles = []
    const screenshots = join(tmpdir(), 'seal-e2e', 'settings')
    await mkdir(screenshots, { recursive: true })
    for (const [name, label] of [['外观', '字体'], ['命令提示', 'API 地址'], ['代理服务器', '代理地址'], ['端口转发', '本机监听地址']]) {
      await dialog.getByRole('tab', { name, exact: true }).click()
      if (name === '代理服务器') await dialog.getByRole('button', { name: '添加代理', exact: true }).click()
      const control = dialog.getByLabel(label, { exact: true })
      await control.focus()
      styles.push(await control.evaluate(element => {
        const style = getComputedStyle(element)
        return { height: element.getBoundingClientRect().height, font: style.fontFamily, size: style.fontSize, weight: style.fontWeight,
          background: style.backgroundColor, radius: style.borderRadius, border: style.borderColor, outline: style.outlineColor, outlineWidth: style.outlineWidth }
      }))
      expect(await dialog.locator('.settings-main').evaluate(el => el.scrollWidth - el.clientWidth), name).toBeLessThanOrEqual(1)
      await dialog.screenshot({ path: join(screenshots, `${name}-${width}.png`) })
    }
    expect(styles[0].height).toBe(26)
    expect(styles[0].font).toContain('Segoe UI')
    expect(styles[0].outlineWidth).toBe('1px')
    for (const style of styles.slice(1)) expect(style).toEqual(styles[0])
  })
}

test('port settings await saving on navigation and keep failed changes visible for retry', async ({ page }) => {
  await page.route('**/src/services/ports/runtime.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    export * from '/src/services/ports/runtime.ts?actual';
    import { portPreferences } from '/src/services/ports/runtime.ts?actual';
    window.portSaveFixture = {};
    export async function setPortBindHost(host) {
      await new Promise((resolve, reject) => { window.portSaveFixture = { resolve, reject }; });
      portPreferences.host = host;
    }
  ` }))
  await openSettings(page)
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  const ports = dialog.getByRole('tab', { name: '端口转发', exact: true })
  await ports.click()
  await dialog.getByLabel('本机监听地址', { exact: true }).selectOption('0.0.0.0')
  await dialog.getByRole('tab', { name: '外观', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('正在保存…')
  await expect(dialog.locator('.ui-status-icon.codicon-loading')).toBeVisible()
  await expect(ports).toHaveAttribute('aria-selected', 'true')
  await page.evaluate(() => (window as any).portSaveFixture.resolve())
  await expect(dialog.getByRole('heading', { name: '外观', exact: true })).toBeVisible()
  await ports.click()
  await expect(dialog.getByLabel('本机监听地址', { exact: true })).toHaveValue('0.0.0.0')
  await dialog.getByLabel('本机监听地址', { exact: true }).selectOption('127.0.0.1')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('正在保存…')
  await page.evaluate(() => (window as any).portSaveFixture.reject(new Error('保存失败，请重试')))
  await expect(dialog.getByRole('alert')).toHaveText('保存失败，请重试')
  await expect(dialog.locator('.ui-status-icon.codicon-error')).toBeVisible()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() => (window as any).portSaveFixture.resolve())
  await expect(dialog).toBeHidden()
})
