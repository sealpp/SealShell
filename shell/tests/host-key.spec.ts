import { expect, test, type Page } from '@playwright/test'

const current = 'SHA256:MK0r6NQ7S0bEWKDLf3o8xNn7dW6Tc2uTz8PS5pEfOqA'
const previous = 'SHA256:Vq5G7EYWXBj8wOcLwCVPVcWYFLHnUoO1ZC7K6NfQTGQ'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/app-harness.html')
  await page.locator('.welcome').waitFor()
  await page.evaluate(async () => {
    const { nativeFixture } = await import('/tests/native-mock.ts')
    const { initializeNativeEvents } = await import('/src/services/native-events.ts')
    ;(window as any).hostKeyDecisions = []
    nativeFixture.handlers.host_key_decision = (decision: unknown) => { (window as any).hostKeyDecisions.push(decision) }
    await initializeNativeEvents()
  })
})

async function prompt(page: Page, id: string, changed = true) {
  await page.evaluate(async ({ id, current, previous }) => {
    const { nativeFixture } = await import('/tests/native-mock.ts')
    nativeFixture.emit({ type: 'hostKey', id, requestId: id, host: '192.168.33.87', port: 22, fingerprint: current, previousFingerprint: previous })
  }, { id, current, previous: changed ? previous : null })
}

async function decisions(page: Page) {
  return page.evaluate(() => (window as any).hostKeyDecisions)
}

test('keeps first-use confirmation distinct and saves only on acceptance', async ({ page }) => {
  await prompt(page, 'first-use', false)
  const dialog = page.getByRole('dialog', { name: '确认远端主机密钥', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(current, { exact: true })).toBeVisible()
  await expect(dialog.getByText('已保存的 SHA-256 指纹')).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '取消连接' })).toBeFocused()
  expect(await decisions(page)).toEqual([])
  await dialog.getByRole('button', { name: '接受并保存' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => decisions(page)).toEqual([{ requestId: 'first-use', accepted: true }])
})

test('shows both fingerprints and defaults to cancelling a changed key', async ({ page }, testInfo) => {
  await prompt(page, 'changed-cancel')
  const dialog = page.getByRole('dialog', { name: '远端主机密钥已变化', exact: true })
  await expect(dialog.getByText(previous, { exact: true })).toBeVisible()
  await expect(dialog.getByText(current, { exact: true })).toBeVisible()
  await expect(dialog.getByText(/连接被冒用/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: '取消连接' })).toBeFocused()
  expect(await decisions(page)).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('host-key-changed.png') })
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => decisions(page)).toEqual([{ requestId: 'changed-cancel', accepted: false }])
})

test('allows explicit acceptance and treats Escape and closing as rejection', async ({ page }) => {
  for (const action of ['accept', 'escape', 'close']) {
    await prompt(page, action)
    const dialog = page.getByRole('dialog', { name: '远端主机密钥已变化', exact: true })
    await expect(dialog).toBeVisible()
    if (action === 'accept') await dialog.getByRole('button', { name: '更新并连接' }).click()
    else if (action === 'escape') await page.keyboard.press('Escape')
    else await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await decisions(page)).at(-1)).toEqual({ requestId: action, accepted: action === 'accept' })
  }
})

test('cancels closed sessions without accepting a queued confirmation', async ({ page }) => {
  await prompt(page, 'active')
  await prompt(page, 'queued-cancelled')
  await prompt(page, 'queued-live')
  await page.evaluate(async () => {
    const { nativeFixture } = await import('/tests/native-mock.ts')
    nativeFixture.emit({ type: 'sessionClosed', id: 'queued-cancelled' })
    nativeFixture.emit({ type: 'sessionClosed', id: 'active' })
  })
  await expect.poll(() => decisions(page)).toEqual([
    { requestId: 'active', accepted: false },
    { requestId: 'queued-cancelled', accepted: false },
  ])
  const dialog = page.getByRole('dialog', { name: '远端主机密钥已变化', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: '取消连接' })).toBeFocused()
  await dialog.getByRole('button', { name: '更新并连接' }).click()
  await expect.poll(async () => (await decisions(page)).at(-1)).toEqual({ requestId: 'queued-live', accepted: true })
})
