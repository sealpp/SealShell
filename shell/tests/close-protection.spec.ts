import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/close-protection-harness.html')
  await page.getByRole('button', { name: 'Activate page', exact: true }).click()
})

async function dismissClose(page: Page): Promise<void> {
  const dialogPromise = page.waitForEvent('dialog')
  await page.close({ runBeforeUnload: true })
  const dialog = await dialogPromise
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  expect(page.isClosed()).toBe(false)
  await expect(page.locator('#blocked')).toHaveText('true')
}

test('allows an idle window to close without a dialog', async ({ page }) => {
  const dialogs: string[] = []
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.accept() })
  const closed = page.waitForEvent('close')
  await page.close({ runBeforeUnload: true })
  await closed
  expect(dialogs).toEqual([])
})

test('cancelled close preserves a connection and confirmed close closes the window', async ({ page }) => {
  await page.getByRole('button', { name: 'Connect terminal', exact: true }).click()
  await dismissClose(page)
  await dismissClose(page)
  const dialogPromise = page.waitForEvent('dialog')
  const closed = page.waitForEvent('close')
  await page.close({ runBeforeUnload: true })
  const dialog = await dialogPromise
  expect(dialog.type()).toBe('beforeunload')
  await dialog.accept()
  await closed
})

test('protects queued transfers and cancellation cleanup after all tabs have closed', async ({ page }) => {
  await page.getByRole('button', { name: 'Connect terminal', exact: true }).click()
  for (let index = 0; index < 3; index++) await page.getByRole('button', { name: 'Start transfer', exact: true }).click()
  await expect(page.locator('#tasks')).toHaveText('running,running,queued')
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await dismissClose(page)
  await page.getByRole('button', { name: 'Cancel transfers', exact: true }).click()
  await expect(page.locator('#tasks')).toHaveText('running,running,cancelled')
  await dismissClose(page)
  await page.getByRole('button', { name: 'Finish transfer', exact: true }).click()
  await expect(page.locator('#tasks')).toHaveText('cancelled,running,cancelled')
  await page.getByRole('button', { name: 'Finish transfer', exact: true }).click()
  await expect(page.locator('#tasks')).toHaveText('cancelled,cancelled,cancelled')
  await expect(page.locator('#blocked')).toHaveText('false')
  const dialogs: string[] = []
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.accept() })
  await page.reload()
  expect(dialogs).toEqual([])
})

test('protects background monitoring independently until the operation finishes', async ({ page }) => {
  await page.getByRole('button', { name: 'Start monitoring', exact: true }).click()
  await dismissClose(page)
  await page.getByRole('button', { name: 'Stop monitoring', exact: true }).click()
  await expect(page.locator('#blocked')).toHaveText('false')
})

test('confirms reload for unsaved offline edits and resumes after choosing to stay', async ({ page }) => {
  const editor = page.getByRole('textbox', { name: 'Editor', exact: true })
  await editor.fill('unsaved draft')
  const firstDialog = page.waitForEvent('dialog')
  // page.reload() waits for a navigation that intentionally never commits.
  await page.evaluate(() => { setTimeout(() => location.reload(), 0) })
  const dialog = await firstDialog
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await expect(editor).toHaveValue('unsaved draft')
  const nextDialog = page.waitForEvent('dialog')
  const reload = page.reload()
  await (await nextDialog).accept()
  await reload
  await expect(editor).toHaveValue('')
  await expect(page.locator('#blocked')).toHaveText('false')
})

test('protects navigation and removes the listener when the guard is unmounted', async ({ page }) => {
  await page.getByRole('button', { name: 'Connect terminal', exact: true }).click()
  const dialogPromise = page.waitForEvent('dialog')
  const navigation = page.goto('about:blank').catch(error => error)
  const dialog = await dialogPromise
  expect(dialog.type()).toBe('beforeunload')
  await dialog.dismiss()
  await navigation
  await page.getByRole('button', { name: 'Unmount guard', exact: true }).click()
  const dialogs: string[] = []
  page.on('dialog', async next => { dialogs.push(next.type()); await next.accept() })
  await page.goto('about:blank')
  expect(dialogs).toEqual([])
})
