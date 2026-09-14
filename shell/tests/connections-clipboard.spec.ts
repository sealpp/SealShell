import { test, expect, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/connections-tree-harness.html')
  await page.locator('.conn-list').waitFor()
})

function row(page: Page, name: string) {
  return page.locator('.conn-item', { has: page.getByText(name, { exact: true }) })
}

function menuItem(page: Page, name: string) {
  return page.getByRole('menuitem', { name })
}

async function pasteOnRoot(page: Page) {
  const list = page.locator('.conn-list')
  const box = await list.boundingBox()
  await list.click({ button: 'right', position: { x: 60, y: (box?.height ?? 300) - 8 } })
  await menuItem(page, '粘贴').click()
}

async function seedHost(page: Page, host: { id: string; name: string; address: string; folderId: string | null }) {
  await page.evaluate(async (payload) => {
    const { createHost } = await import('/src/services/ws.ts')
    await createHost({ port: 22, username: 'root', ...payload })
  }, host)
}

test('copy a host and paste creates -copy then -copy-2 siblings', async ({ page }) => {
  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '复制').click()
  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '粘贴').click()
  await expect(row(page, 'Root host-copy')).toHaveCount(1)

  // 复制模式下剪贴板保留，可连续粘贴
  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '粘贴').click()
  await expect(row(page, 'Root host-copy-2')).toHaveCount(1)
})

test('copied host carries the encrypted credential under its new id', async ({ page }) => {
  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '复制').click()
  await pasteOnRoot(page)
  const password = await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { loadCredentialRecord } = await import('/src/services/vault.ts')
    const copy = store.hosts.find((host) => host.name === 'Root host-copy')
    return copy ? (await loadCredentialRecord(copy.id))?.password : undefined
  })
  expect(password).toBe('seal-secret')
})

test('deep-copies a folder keeping inner names unchanged', async ({ page }) => {
  await row(page, 'Alpha').click({ button: 'right' })
  await menuItem(page, '复制').click()
  await pasteOnRoot(page)

  const copy = page.locator('.conn-item.folder', { has: page.getByText('Alpha-copy', { exact: true }) })
  await expect(copy).toHaveCount(1)
  await copy.locator('.tree-toggle').click()
  await expect(row(page, 'Alpha host')).toHaveCount(2)
  const nested = page.locator('.conn-item.folder', { has: page.getByText('Nested', { exact: true }) }).nth(1)
  await nested.locator('.tree-toggle').click()
  await expect(row(page, 'Nested host')).toHaveCount(2)
})

test('cut marks the row translucent and paste moves it into the folder', async ({ page }) => {
  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '剪切').click()
  await expect(row(page, 'Root host')).toHaveClass(/cut/)
  await expect(row(page, 'Root host')).toHaveCSS('opacity', '0.5')

  await page.locator('.conn-item.folder', { has: page.getByText('Zeta', { exact: true }) }).click({ button: 'right' })
  await menuItem(page, '粘贴').click()

  const moved = row(page, 'Root host')
  await expect(moved).not.toHaveClass(/cut/)
  await expect(moved).toHaveAttribute('style', /padding-left: 24px/)
  // 剪切粘贴后剪贴板清空，粘贴项隐藏
  await pasteOnRootExpectNoPaste(page)
})

async function pasteOnRootExpectNoPaste(page: Page) {
  const list = page.locator('.conn-list')
  const box = await list.boundingBox()
  await list.click({ button: 'right', position: { x: 60, y: (box?.height ?? 300) - 8 } })
  await expect(menuItem(page, '粘贴')).toHaveCount(0)
  await page.keyboard.press('Escape')
}

test('cut paste at the same location is a no-op', async ({ page }) => {
  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '剪切').click()
  await pasteOnRoot(page)
  await expect(row(page, 'Root host')).toHaveCount(1)
  await expect(row(page, 'Root host')).toHaveAttribute('style', /padding-left: 8px/)
})

test('paste on a folder pastes inside it', async ({ page }) => {
  await row(page, 'Alpha host').click({ button: 'right' })
  await menuItem(page, '复制').click()
  await page.locator('.conn-item.folder', { has: page.getByText('Zeta', { exact: true }) }).click({ button: 'right' })
  await menuItem(page, '粘贴').click()
  const inside = row(page, 'Alpha host').nth(1)
  await expect(inside).toHaveAttribute('style', /padding-left: 24px/)
})

test('paste of a folder into its own descendant is blocked', async ({ page }) => {
  await row(page, 'Alpha').click({ button: 'right' })
  await menuItem(page, '复制').click()
  await page.locator('.conn-item.folder', { has: page.getByText('Nested', { exact: true }) }).first().click({ button: 'right' })
  await menuItem(page, '粘贴').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('无法粘贴')
  await dialog.getByRole('button', { name: '确定' }).click()
  await expect(row(page, 'Alpha-copy')).toHaveCount(0)
})

test('cut paste conflict prompts replace and cancel keeps the source', async ({ page }) => {
  await seedHost(page, { id: 'zeta-dup', name: 'Root host', address: '10.0.0.9', folderId: 'folder-z' })
  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '剪切').click()
  await page.locator('.conn-item.folder', { has: page.getByText('Zeta', { exact: true }) }).click({ button: 'right' })
  await menuItem(page, '粘贴').click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('替换')
  await dialog.getByRole('button', { name: '取消' }).click()
  // 取消：源保留在根层级，目标同名项未被删除，剪切标记已解除
  const cancelled = await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    return store.hosts.filter((item) => item.name === 'Root host').map((item) => item.folderId)
  })
  expect(cancelled.sort()).toEqual(['folder-z', null])
  await expect(page.locator('.conn-item.cut')).toHaveCount(0)

  await row(page, 'Root host').click({ button: 'right' })
  await menuItem(page, '剪切').click()
  await page.locator('.conn-item.folder', { has: page.getByText('Zeta', { exact: true }) }).click({ button: 'right' })
  await menuItem(page, '粘贴').click()
  await expect(dialog).toContainText('替换')
  await dialog.getByRole('button', { name: '替换' }).click()
  await expect.poll(async () => {
    const moved = await page.evaluate(async () => {
      const { store } = await import('/src/stores/app.ts')
      const sameName = store.hosts.filter((item) => item.name === 'Root host')
      return sameName.length === 1 ? { id: sameName[0].id, folderId: sameName[0].folderId } : sameName
    })
    return moved
  }).toEqual({ id: 'host-root', folderId: 'folder-z' })
})

test('apply-to-all checkbox skips remaining conflict prompts', async ({ page }) => {
  await seedHost(page, { id: 'z1', name: 'dup-a', address: '10.0.1.1', folderId: 'folder-z' })
  await seedHost(page, { id: 'z2', name: 'dup-b', address: '10.0.1.2', folderId: 'folder-z' })
  await seedHost(page, { id: 'r1', name: 'dup-a', address: '10.0.2.1', folderId: null })
  await seedHost(page, { id: 'r2', name: 'dup-b', address: '10.0.2.2', folderId: null })

  await row(page, 'dup-a').click()
  await row(page, 'dup-b').click({ modifiers: ['Control'] })
  await page.keyboard.press('Control+x')
  await expect(page.locator('.conn-item.cut')).toHaveCount(2)

  await page.locator('.conn-item.folder', { has: page.getByText('Zeta', { exact: true }) }).click({ button: 'right' })
  await menuItem(page, '粘贴').click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.locator('input[type="checkbox"]').check()
  await dialog.getByRole('button', { name: '取消' }).click()
  // 勾选后取消 → 其余冲突按相同操作跳过，不再出现弹窗；两侧同名项都保留
  await expect(dialog).toHaveCount(0)
  const counts = await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    return ['dup-a', 'dup-b'].map(
      (name) => store.hosts.filter((item) => item.name === name).length,
    )
  })
  expect(counts).toEqual([2, 2])
})

test('keyboard shortcuts copy and escape cancels cut', async ({ page }) => {
  await row(page, 'Root host').click()
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect(row(page, 'Root host-copy')).toHaveCount(1)

  await row(page, 'Root host-copy').click()
  await page.keyboard.press('Control+x')
  await expect(row(page, 'Root host-copy')).toHaveClass(/cut/)
  await page.keyboard.press('Escape')
  await expect(row(page, 'Root host-copy')).not.toHaveClass(/cut/)

  await pasteOnRootExpectNoPaste(page)
})
