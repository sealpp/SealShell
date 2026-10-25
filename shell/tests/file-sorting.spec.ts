import { test, expect } from '@playwright/test'

interface SortingFixture { listCalls: number; hold: boolean; release?: () => void }

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/file-navigation-harness.html')
  await expect(page.locator('.file-panel')).toHaveCount(2)
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { registerFileSession, refreshFileTab } = await import('/src/services/sftp/file-tabs.ts')
    const { createFilePaths } = await import('/src/services/files/path.ts')
    const fixture: SortingFixture = { listCalls: 0, hold: false }
    ;(window as unknown as { fileSorting: SortingFixture }).fileSorting = fixture
    for (const tab of store.tabs.filter(tab => tab.kind === 'file')) {
      const paths = createFilePaths(tab.id === 'local')
      const entries = [
        { name: 'z-folder', kind: 'directory', size: 0, modifiedAt: 0 },
        { name: 'file10.txt', kind: 'file', size: 2048, modifiedAt: 1000 },
        { name: 'file2.txt', kind: 'file', size: 10, modifiedAt: 3000 },
        { name: 'b.json', kind: 'file', size: 3, modifiedAt: 2000 },
        { name: 'c.go', kind: 'file', size: 4096, modifiedAt: 4000 },
        { name: 'a.yaml', kind: 'file', size: 1024, modifiedAt: 5000 },
        { name: 'link.go', kind: 'symlink', size: 7, modifiedAt: 0 },
      ].map(entry => ({ ...entry, path: paths.join(tab.file.cwd, entry.name) }))
      registerFileSession(tab.id, {
        paths, async disconnect() {},
        async list(path) {
          fixture.listCalls++
          if (fixture.hold) await new Promise<void>(resolve => { fixture.release = resolve })
          return { path, entries }
        },
      })
      tab.state = 'online'
      await refreshFileTab(tab.id)
    }
  })
})

test('cycles every header through ascending, descending and default without changing selection or reading the backend', async ({ page }) => {
  const defaultNames = ['z-folder', 'a.yaml', 'b.json', 'c.go', 'file2.txt', 'file10.txt', 'link.go']
  const ascending = [
    defaultNames,
    ['z-folder', 'b.json', 'link.go', 'file2.txt', 'a.yaml', 'file10.txt', 'c.go'],
    ['z-folder', 'link.go', 'file10.txt', 'b.json', 'file2.txt', 'c.go', 'a.yaml'],
    ['z-folder', 'c.go', 'b.json', 'a.yaml', 'file2.txt', 'file10.txt', 'link.go'],
  ]
  for (const endpoint of ['local', 'remote']) {
    const pane = page.locator('[data-file-tab="' + endpoint + '"]')
    const names = pane.locator('.file-row:not(.file-parent) .file-name-text')
    await expect(pane.getByRole('combobox', { name: '排序', exact: true })).toHaveCount(0)
    await expect(names).toHaveText(defaultNames)
    await pane.locator('.file-row').filter({ hasText: 'file2.txt' }).click()
    for (const [index, label] of ['名称', '大小', '修改时间', '类型'].entries()) {
      const header = pane.getByRole('columnheader').nth(index)
      const button = header.getByRole('button', { name: `按${label}排序` })
      await expect(header).toHaveAttribute('aria-sort', 'none')
      const bounds = (await button.boundingBox())!
      await button.click({ position: { x: bounds.width - 14, y: bounds.height / 2 } })
      await expect(header).toHaveAttribute('aria-sort', 'ascending')
      await expect(names).toHaveText(ascending[index])
      await button.press('Space')
      await expect(header).toHaveAttribute('aria-sort', 'descending')
      await expect(names).toHaveText(['z-folder', ...ascending[index].slice(1).reverse()])
      await button.press('Enter')
      await expect(header).toHaveAttribute('aria-sort', 'none')
      await expect(header.locator('svg')).toHaveCount(0)
      await expect(names).toHaveText(defaultNames)
      await expect(pane.locator('.file-row.selected .file-name-text')).toHaveText('file2.txt')
    }
  }
  const localSelection = page.locator('[data-file-tab="local"] .file-row.selected')
  const remoteSelection = page.locator('[data-file-tab="remote"] .file-row.selected')
  await expect(localSelection).toHaveAttribute('aria-selected', 'true')
  await expect(localSelection).toHaveCSS('background-color', 'rgb(55, 55, 61)')
  await expect(remoteSelection).toHaveCSS('background-color', 'rgb(4, 57, 94)')
  await expect(remoteSelection).toHaveCSS('height', '22px')
  expect(await page.evaluate(() => (window as unknown as { fileSorting: SortingFixture }).fileSorting.listCalls)).toBe(2)
})

test('resizes columns without sorting and keeps pane sort state independent', async ({ page }) => {
  const pane = page.locator('[data-file-tab="local"]')
  const remote = page.locator('[data-file-tab="remote"]')
  await pane.getByRole('button', { name: '按大小排序' }).click()
  const handle = pane.getByRole('separator', { name: '调整名称列宽' })
  const bounds = await handle.boundingBox()
  const original = await pane.getByRole('columnheader').first().boundingBox()
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + 10)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width / 2 + 45, bounds!.y + 10)
  await page.mouse.up()
  expect((await pane.getByRole('columnheader').first().boundingBox())!.width).toBeGreaterThan(original!.width + 40)
  await handle.focus()
  await handle.press('ArrowRight')
  await expect(pane.getByRole('columnheader').nth(1)).toHaveAttribute('aria-sort', 'ascending')
  await expect(pane.getByRole('columnheader').nth(0)).toHaveAttribute('aria-sort', 'none')
  await expect(remote.getByRole('columnheader').nth(0)).toHaveAttribute('aria-sort', 'none')
  expect(await page.evaluate(() => (window as unknown as { fileSorting: SortingFixture }).fileSorting.listCalls)).toBe(2)
})

for (const clear of [false, true]) test(`applies ${clear ? 'default' : 'explicit'} order when an in-flight refresh finishes`, async ({ page }) => {
  const pane = page.locator('[data-file-tab="remote"]')
  await page.evaluate(() => { (window as unknown as { fileSorting: SortingFixture }).fileSorting.hold = true })
  await pane.getByRole('button', { name: '刷新', exact: true }).click()
  await expect(pane.getByText('正在加载...')).toBeVisible()
  await pane.getByRole('button', { name: '按大小排序' }).click()
  if (clear) {
    await pane.getByRole('button', { name: '按大小排序' }).click()
    await pane.getByRole('button', { name: '按大小排序' }).click()
  }
  const expected = clear ? ['z-folder', 'a.yaml', 'b.json', 'c.go', 'file2.txt', 'file10.txt', 'link.go']
    : ['z-folder', 'b.json', 'link.go', 'file2.txt', 'a.yaml', 'file10.txt', 'c.go']
  await expect(pane.locator('.file-row:not(.file-parent) .file-name-text')).toHaveText(expected)
  await page.evaluate(() => {
    const fixture = (window as unknown as { fileSorting: SortingFixture }).fileSorting
    fixture.hold = false
    fixture.release!()
  })
  await expect(pane.getByText('正在加载...')).toHaveCount(0)
  await expect(pane.locator('.file-row:not(.file-parent) .file-name-text')).toHaveText(expected)
  expect(await page.evaluate(() => (window as unknown as { fileSorting: SortingFixture }).fileSorting.listCalls)).toBe(3)
})
