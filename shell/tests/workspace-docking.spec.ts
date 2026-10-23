import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

declare global {
  interface Window {
    __workspaceHarnessAddFile?: () => void
    __workspaceHarnessOpenEditor?: () => void
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/workspace-docking-harness.html')
  await page.locator('.workspace-panel').waitFor()
})

function workspaceDock(page: Page): Locator {
  return page.locator('.workspace-category-view.active .workspace-dock')
}

async function dragInstanceTo(page: Page, dock: Locator, tab: string, x: number, y: number): Promise<void> {
  const source = page.getByRole('button', { name: tab })
  const [dockBox, sourceBox] = await Promise.all([dock.boundingBox(), source.boundingBox()])
  expect(dockBox).not.toBeNull()
  expect(sourceBox).not.toBeNull()
  if (!dockBox || !sourceBox) return
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(sourceBox.x - 40, sourceBox.y + sourceBox.height / 2, { steps: 4 })
  await page.mouse.move(dockBox.x + x, dockBox.y + y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(100)
}

async function visibleWorkspaceGroups(page: Page) {
  return page.locator('.workspace-category-view.active .workspace-dockview .dv-groupview').evaluateAll((groups) => groups
    .map((group) => {
      const rect = group.getBoundingClientRect()
      return { width: rect.width, height: rect.height, tabs: [...group.querySelectorAll('.dv-tab')].map((tab) => tab.textContent) }
    })
    .filter((group) => group.width > 1 && group.height > 1))
}

test('keeps fixed categories and shows only the selected category instances', async ({ page }) => {
  await expect(page.getByRole('tab')).toHaveCount(5)
  await expect(page.locator('.workspace-category-view.active .workspace-instance')).toHaveCount(3)
  const dockBox = await page.locator('.workspace-category-view.active .workspace-dockview').boundingBox()
  expect(dockBox?.height ?? 0).toBeGreaterThan(0)

  await page.getByRole('tab', { name: '文件编辑', exact: true }).click()
  await expect(page.locator('.workspace-category-view.active .workspace-instance')).toHaveCount(1)
  await expect(page.locator('.workspace-category-view.active .workspace-instance-label')).toContainText('README.md')
})

test('opens a new editor without recursing through the hidden file dock layout', async ({ page }) => {
  await page.evaluate(() => window.__workspaceHarnessOpenEditor?.())
  const activeView = page.locator('.workspace-category-view.active')
  await expect(activeView.locator('.workspace-instance')).toHaveCount(2)
  await expect(activeView.locator('.workspace-instance-label[title="opened.md"]')).toBeVisible()
  await expect(activeView.locator('.editor-panel')).toHaveCount(2)
})

test('keeps grouped markers stable and activates tabs across panes', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', 12, dockBox.height / 2)

  const splitBounds = await page.locator('.workspace-category-view.active .workspace-dockview .dv-groupview').evaluateAll((groups) => groups
    .map((group) => {
      const rect = group.getBoundingClientRect()
      return { width: rect.width, tabs: [...group.querySelectorAll('.dv-tab')].map((tab) => tab.textContent) }
    })
    .filter((group) => group.width > 1))
  expect(splitBounds).toHaveLength(2)
  expect(Math.abs(splitBounds[0].width - splitBounds[1].width)).toBeLessThan(3)

  const instances = page.locator('.workspace-category-view.active .workspace-instance')
  await expect(instances.locator('.workspace-instance-label')).toHaveText(['远端 /opt', '远端 /srv', '远端 /var'])
  await expect(instances.locator('.workspace-instance-marker')).toHaveText(['┌', '└', ''])

  await page.getByRole('button', { name: '远端 /var' }).click()
  await expect(page.getByRole('region', { name: '远端 /var' })).toBeVisible()
  await expect(page.getByRole('region', { name: '远端 /srv' })).toBeHidden()
  await expect(page.getByRole('region', { name: '远端 /opt' })).toBeHidden()
  await expect(instances.locator('.workspace-instance-marker')).toHaveText(['┌', '└', ''])

  await page.getByRole('button', { name: '远端 /srv' }).click()
  await expect(page.getByRole('button', { name: '远端 /srv' })).toHaveClass(/active/)
  await expect(page.getByRole('region', { name: '远端 /opt' })).toBeVisible()
  await expect(page.getByRole('region', { name: '远端 /srv' })).toBeVisible()
  await expect(page.getByRole('region', { name: '远端 /var' })).toBeHidden()
})

test('restores the clicked panel when returning to a tabbed group', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', dockBox.width / 2, dockBox.height / 2)

  await page.getByRole('button', { name: '远端 /var' }).click()
  await page.getByRole('button', { name: '远端 /opt' }).click()
  await expect(page.getByRole('button', { name: '远端 /opt' })).toHaveClass(/active/)
  await expect(page.getByRole('region', { name: '远端 /opt' })).toBeVisible()
  await expect(page.getByRole('region', { name: '远端 /var' })).toBeHidden()
})

test('activates the clicked tab inside a grouped pane', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /var', dockBox.width / 2, dockBox.height / 2)

  const groupedDock = page.locator('.workspace-dockview .dv-groupview').filter({
    has: page.locator('.dv-tab').filter({ hasText: '远端 /srv' }),
  })
  await expect(groupedDock.locator('.dv-tab')).toHaveCount(2)

  await page.getByRole('button', { name: '远端 /var' }).click()
  await expect(groupedDock.locator('.dv-tab').filter({ hasText: '远端 /var' })).toHaveClass(/dv-active-tab/)
  await expect(groupedDock.locator('.dv-tab').filter({ hasText: '远端 /srv' })).not.toHaveClass(/dv-active-tab/)

  await page.getByRole('button', { name: '远端 /srv' }).click()
  await expect(groupedDock.locator('.dv-tab').filter({ hasText: '远端 /srv' })).toHaveClass(/dv-active-tab/)
  await expect(groupedDock.locator('.dv-tab').filter({ hasText: '远端 /var' })).not.toHaveClass(/dv-active-tab/)
})

test('preserves split sizes when switching groups and opening an instance', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', 12, dockBox.height / 2)

  const sash = page.locator('.workspace-category-view.active .workspace-dockview .dv-sash.dv-enabled').first()
  const sashBox = await sash.boundingBox()
  expect(sashBox).not.toBeNull()
  if (!sashBox) return
  await page.mouse.move(sashBox.x + sashBox.width / 2, sashBox.y + sashBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(dockBox.x + 300, sashBox.y + sashBox.height / 2, { steps: 8 })
  await page.mouse.up()

  const groupFor = (label: string) => page.locator('.workspace-category-view.active .workspace-dockview .dv-groupview').filter({
    has: page.locator('.dv-tab').filter({ hasText: label }),
  })
  const optGroup = groupFor('远端 /opt')
  const srvGroup = groupFor('远端 /srv')
  const bounds = async (locator: ReturnType<typeof groupFor>) => {
    const box = await locator.boundingBox()
    expect(box).not.toBeNull()
    if (!box) throw new Error('expected workspace group bounds')
    return { width: box.width, height: box.height }
  }
  const before = { opt: await bounds(optGroup), srv: await bounds(srvGroup) }

  await page.getByRole('button', { name: '远端 /var' }).click()
  await page.getByRole('button', { name: '远端 /srv' }).click()
  const afterSwitch = { opt: await bounds(optGroup), srv: await bounds(srvGroup) }
  expect(Math.abs(afterSwitch.opt.width - before.opt.width)).toBeLessThan(3)
  expect(Math.abs(afterSwitch.srv.width - before.srv.width)).toBeLessThan(3)

  await page.evaluate(() => window.__workspaceHarnessAddFile?.())
  await expect(page.getByRole('button', { name: '远端 /tmp' })).toBeVisible()
  const afterOpen = { opt: await bounds(optGroup), srv: await bounds(srvGroup) }
  expect(Math.abs(afterOpen.opt.width - before.opt.width)).toBeLessThan(3)
  expect(Math.abs(afterOpen.srv.width - before.srv.width)).toBeLessThan(3)

  await page.getByRole('button', { name: '远端 /tmp' }).click()
  await page.getByRole('button', { name: '远端 /srv' }).click()
  const afterNewGroupSwitch = { opt: await bounds(optGroup), srv: await bounds(srvGroup) }
  expect(Math.abs(afterNewGroupSwitch.opt.width - before.opt.width)).toBeLessThan(3)
  expect(Math.abs(afterNewGroupSwitch.srv.width - before.srv.width)).toBeLessThan(3)
})

test('equalizes panes created by vertical edge drops', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', dockBox.width / 2, 12)

  const heights = (await visibleWorkspaceGroups(page)).map((group) => group.height)
  expect(heights).toHaveLength(2)
  expect(Math.abs(heights[0] - heights[1])).toBeLessThan(3)

  await dragInstanceTo(page, dock, '远端 /var', dockBox.width / 2, dockBox.height - 12)
  const repeatedHeights = (await visibleWorkspaceGroups(page)).map((group) => group.height)
  expect(repeatedHeights).toHaveLength(3)
  expect(Math.max(...repeatedHeights) - Math.min(...repeatedHeights)).toBeLessThan(3)

  await page.evaluate(() => window.__workspaceHarnessAddFile?.())
  await expect(page.getByRole('button', { name: '远端 /tmp' })).toBeVisible()
  await dragInstanceTo(page, dock, '远端 /tmp', dockBox.width / 2, dockBox.height - 12)
  const fourPaneHeights = (await visibleWorkspaceGroups(page)).map((group) => group.height)
  expect(fourPaneHeights).toHaveLength(4)
  expect(Math.max(...fourPaneHeights) - Math.min(...fourPaneHeights)).toBeLessThan(3)
})

test('keeps repeated horizontal edge drops evenly distributed', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', 12, dockBox.height / 2)
  await dragInstanceTo(page, dock, '远端 /var', dockBox.width - 12, dockBox.height / 2)
  await page.evaluate(() => window.__workspaceHarnessAddFile?.())
  await expect(page.getByRole('button', { name: '远端 /tmp' })).toBeVisible()
  await dragInstanceTo(page, dock, '远端 /tmp', dockBox.width - 12, dockBox.height / 2)

  const widths = (await visibleWorkspaceGroups(page)).map((group) => group.width)
  expect(widths).toHaveLength(4)
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(3)
})

test('distributes a pane when its source group already contains tabs', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', dockBox.width / 2, dockBox.height / 2)
  await page.getByRole('button', { name: '远端 /var' }).click()
  await dragInstanceTo(page, dock, '远端 /srv', 12, dockBox.height / 2)

  const widths = await visibleWorkspaceGroups(page)
  expect(widths).toHaveLength(3)
  expect(Math.max(...widths.map((group) => group.width)) - Math.min(...widths.map((group) => group.width))).toBeLessThan(3)
  expect(widths.flatMap((group) => group.tabs)).toEqual(expect.arrayContaining(['远端 /opt', '远端 /srv', '远端 /var']))
})

test('distributes vertically when its source group already contains tabs', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', dockBox.width / 2, dockBox.height / 2)
  await page.getByRole('button', { name: '远端 /var' }).click()
  await dragInstanceTo(page, dock, '远端 /srv', dockBox.width / 2, 12)

  const heights = await visibleWorkspaceGroups(page)
  expect(heights).toHaveLength(3)
  expect(Math.max(...heights.map((group) => group.height)) - Math.min(...heights.map((group) => group.height))).toBeLessThan(3)
  expect(heights.flatMap((group) => group.tabs)).toEqual(expect.arrayContaining(['远端 /opt', '远端 /srv', '远端 /var']))
})

test('keeps a parallel target even when a hidden multi-tab source is split into it', async ({ page }) => {
  const dock = workspaceDock(page)
  const dockBox = await dock.boundingBox()
  expect(dockBox).not.toBeNull()
  if (!dockBox) return
  await dragInstanceTo(page, dock, '远端 /opt', dockBox.width / 2, dockBox.height / 2)
  await page.getByRole('button', { name: '远端 /var' }).click()
  await page.evaluate(() => window.__workspaceHarnessAddFile?.())
  await expect(page.getByRole('button', { name: '远端 /tmp' })).toBeVisible()
  await dragInstanceTo(page, dock, '远端 /tmp', dockBox.width / 2, 12)
  await page.getByRole('button', { name: '远端 /var' }).click()
  await dragInstanceTo(page, dock, '远端 /srv', dockBox.width / 2, dockBox.height - 12)

  const heights = await visibleWorkspaceGroups(page)
  expect(heights).toHaveLength(4)
  expect(Math.max(...heights.map((group) => group.height)) - Math.min(...heights.map((group) => group.height))).toBeLessThan(3)
  expect(heights.flatMap((group) => group.tabs)).toEqual(expect.arrayContaining(['远端 /opt', '远端 /srv', '远端 /var', '远端 /tmp']))
})

test('selects an instance without changing the other category layout', async ({ page }) => {
  const first = page.locator('.workspace-category-view.active .workspace-instance').nth(1)
  await first.click()
  await expect(first).toHaveClass(/active/)
  await page.getByRole('tab', { name: '文件编辑', exact: true }).click()
  await expect(page.locator('.workspace-category-view.active .workspace-instance')).toHaveCount(1)
  await page.getByRole('tab', { name: '文件列表' }).click()
  await expect(page.locator('.workspace-category-view.active .workspace-instance').nth(1)).toHaveClass(/active/)
})

test('opens the file context menu from a file row', async ({ page }) => {
  const row = page.locator('.workspace-category-view.active .file-row:visible').filter({ hasText: 'README.md' }).last()
  await expect(row).toBeVisible()
  await row.click({ button: 'right' })
  await expect(page.locator('[role="menu"]:visible')).toBeVisible()
})

test('provides panel maximize, restore, and close controls', async ({ page }) => {
  const panel = page.locator('.workspace-panel')
  await expect(panel).toHaveAttribute('aria-label', '面板')

  await page.getByRole('button', { name: '最大化面板' }).click()
  await expect(panel).toHaveClass(/maximized/)
  await expect(page.getByRole('button', { name: '恢复面板大小' })).toBeVisible()

  await page.getByRole('button', { name: '恢复面板大小' }).click()
  await expect(panel).not.toHaveClass(/maximized/)

  await page.getByRole('button', { name: '关闭面板' }).click()
  await expect(panel).toBeHidden()
})
