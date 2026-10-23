import { test, expect } from '@playwright/test'

test('shares themed icons across endpoints and retains link identity, selection and offline rendering', async ({ page, context }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/tests/file-navigation-harness.html')
  await expect(page.locator('.file-panel')).toHaveCount(2)
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { registerFileSession } = await import('/src/services/sftp/file-tabs.ts')
    const { createFilePaths } = await import('/src/services/files/path.ts')
    const metrics = window as unknown as { fileIconQueries: number }
    metrics.fileIconQueries = 0
    const unexpectedQuery = async () => { metrics.fileIconQueries++; throw new Error('Icons must not query the filesystem') }
    for (const tab of store.tabs.filter(tab => tab.kind === 'file')) {
      const paths = createFilePaths(tab.id === 'local')
      registerFileSession(tab.id, { paths, list: unexpectedQuery, stat: unexpectedQuery, read: unexpectedQuery, async disconnect() {} })
      tab.state = 'online'
      tab.file.loading = false
      tab.file.entries = [
        { name: 'src', kind: 'directory' }, { name: 'package.json', kind: 'file' },
        { name: 'main.rs', kind: 'symlink' }, { name: 'Dockerfile.tar.gz', kind: 'file' },
      ].map(entry => ({ ...entry, path: paths.join(tab.file.cwd, entry.name), size: 120, modifiedAt: 0 }))
    }
  })
  for (const endpoint of ['local', 'remote']) {
    const pane = page.locator('[data-file-tab="' + endpoint + '"]')
    await expect(pane.locator('[data-file-icon="folder-src"]')).toBeVisible()
    await expect(pane.locator('[data-file-icon="nodejs"]')).toHaveAttribute('title', 'JSON 文件')
    await expect(pane.locator('[data-file-icon="zip"]')).toHaveAttribute('title', '压缩包')
    const link = pane.locator('.file-row').filter({ hasText: 'main.rs' })
    await expect(link.locator('[data-file-icon="rust"]')).toBeVisible()
    await expect(link.locator('.file-decoration')).toHaveText('⤷')
    await expect(link.locator('span').last()).toHaveText('符号链接')
    await link.click()
    const style = await link.evaluate(row => {
      const icon = row.querySelector('.file-icon')!
      return { text: getComputedStyle(row).color, icon: getComputedStyle(icon).backgroundColor, width: icon.getBoundingClientRect().width }
    })
    expect(style.icon).toBe(style.text)
    expect(style.width).toBe(16)
  }
  await context.setOffline(true)
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const tab = store.tabs.find(tab => tab.id === 'remote')!
    tab.file.entries[1].name = 'main.go'
    tab.file.entries[1].path = '/fixtures/nested/main.go'
  })
  const icon = page.locator('[data-file-tab="remote"] [data-file-icon="go"]')
  await expect(icon).toBeVisible()
  expect(await icon.evaluate(el => getComputedStyle(el).maskImage)).toContain('data:image/svg+xml,')
  expect(await page.evaluate(() => (window as unknown as { fileIconQueries: number }).fileIconQueries)).toBe(0)
  expect(errors).toEqual([])
})
