import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function open(page: Page) {
  await page.goto('/tests/workbench-menu-harness.html')
  await page.locator('.workbench-menu-trigger').click()
  await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '模型服务', exact: true }).click()
}
async function add(page: Page) {
  await page.getByRole('button', { name: '添加服务', exact: true }).click()
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-model-secret')
}
async function fixture(page: Page) {
  await page.evaluate(async () => {
    const { nativeFixture } = await import('/tests/native-mock.ts')
    ;(window as any).modelCalls = []
    nativeFixture.handlers.http_request = async args => {
      ;(window as any).modelCalls.push(args)
      if (args.method === 'GET') return JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b', name: 'Model B' }] })
      if (args.protocol === 'anthropic') return JSON.stringify({ content: [{ type: 'text', text: 'OK' }] })
      if (args.protocol === 'openai-responses') return JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] })
      return JSON.stringify({ choices: [{ message: { content: 'OK' } }] })
    }
  })
}

test('lists models without adding them, saves explicit choices and key, and detects with a model protocol override', async ({ page }) => {
  await open(page); await fixture(page); await add(page)
  await page.getByRole('button', { name: '获取模型列表', exact: true }).click()
  await expect(page.getByRole('button', { name: '添加模型 model-a', exact: true })).toBeVisible()
  await expect(page.getByLabel('主模型', { exact: true }).locator('option')).toHaveCount(1)
  await page.getByRole('button', { name: '添加模型 model-a', exact: true }).click()
  await expect(page.getByRole('button', { name: '添加模型 model-a', exact: true })).toBeDisabled()
  await page.getByLabel('主模型', { exact: true }).selectOption({ label: 'Model A · model-a' })
  const row = page.locator('.model-row').filter({ hasText: 'Model A' })
  await row.getByText('高级配置', { exact: true }).click()
  await row.getByLabel('model-a 接口协议', { exact: true }).selectOption('openai-responses')
  await row.getByLabel('model-a 超时', { exact: true }).fill('90')
  await page.getByRole('button', { name: '检测模型 model-a', exact: true }).click()
  await expect(row.getByRole('status')).toContainText('可用')
  const wire = await page.evaluate(() => (window as any).modelCalls)
  expect(wire[0]).toMatchObject({ method: 'GET', url: 'https://api.deepseek.com/v1/models', proxy: { mode: 'direct' } })
  expect(wire.at(-1)).toMatchObject({ protocol: 'openai-responses', url: 'https://api.deepseek.com/v1/responses', timeoutMs: 90000, body: { input: 'Reply with OK.', store: false } })
  const records = await page.evaluate(() => JSON.parse(localStorage.getItem('sealshell-browser-test-records')!))
  expect(JSON.stringify(records.meta.modelServices)).not.toContain('synthetic-model-secret')
  expect(records.meta.modelServices.services[0].models.map((model: any) => model.id)).toEqual(['model-a'])
  await page.reload()
  await page.locator('.workbench-menu-trigger').click(); await page.getByRole('menuitem', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '模型服务', exact: true }).click()
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('placeholder', '已保存，输入可更换')
  await expect(page.getByLabel('主模型', { exact: true }).locator('option:checked')).toHaveText('Model A · model-a')
  await page.locator('.model-row').getByText('高级配置', { exact: true }).click()
  await expect(page.getByLabel('model-a 接口协议', { exact: true })).toHaveValue('openai-responses')
  const dir = join(tmpdir(), 'seal-e2e', 'model-services'); await mkdir(dir, { recursive: true })
  await page.getByRole('dialog', { name: '设置', exact: true }).screenshot({ path: join(dir, 'model-services.png') })
})

test('keeps history controls independent, supports inheritance, and allows deletion of the active model', async ({ page }) => {
  await open(page); await add(page)
  await page.getByLabel('模型 ID', { exact: true }).fill('manual-model')
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  await page.getByLabel('主模型', { exact: true }).selectOption({ label: 'manual-model · manual-model' })
  await page.getByRole('tab', { name: '智能命令提示', exact: true }).click()
  await expect(page.getByLabel('模型', { exact: true }).locator('option:checked')).toContainText('继承主模型')
  await page.getByRole('switch', { name: '智能命令提示', exact: true }).check()
  await page.getByRole('tab', { name: '历史命令提示', exact: true }).click()
  await page.getByRole('switch', { name: '历史命令提示', exact: true }).uncheck()
  await expect(page.getByRole('switch', { name: '记录命令历史', exact: true })).toBeChecked()
  await page.getByRole('tab', { name: '智能命令提示', exact: true }).click()
  await expect(page.getByRole('switch', { name: '智能命令提示', exact: true })).toBeChecked()
  await page.getByRole('button', { name: 'AI 功能', exact: true }).click()
  await expect(page.getByRole('tab', { name: '智能命令提示', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'AI 功能', exact: true }).click()
  await page.getByRole('tab', { name: '模型服务', exact: true }).click()
  await page.getByRole('button', { name: '删除模型 manual-model', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除模型', exact: true })
  await expect(confirmation).toContainText('主模型')
  await confirmation.getByRole('button', { name: '删除', exact: true }).click()
  await expect(page.getByLabel('主模型', { exact: true }).locator('option:checked')).toHaveText('模型已删除，请重新选择')
  await page.getByRole('tab', { name: '智能命令提示', exact: true }).click()
  await expect(page.getByText('当前模型：模型已删除，请重新选择', { exact: true })).toBeVisible()
})

test('uses saved proxy references for lists and generation, keeps failure visible, and saves without successful detection', async ({ page }) => {
  await open(page); await fixture(page)
  await page.evaluate(async () => {
    const { saveProxyProfile } = await import('/src/services/proxy/profiles.ts')
    await saveProxyProfile({ id: 'test-proxy', name: 'Test HTTP proxy', type: 'http', host: '127.0.0.1', port: 7890, authentication: 'none', username: '' })
  })
  await add(page)
  await page.getByLabel('连接方式', { exact: true }).selectOption('saved')
  await page.getByRole('button', { name: '检测 API 地址', exact: true }).click()
  expect(await page.evaluate(() => (window as any).modelCalls[0].proxy)).toEqual({ mode: 'saved', id: 'test-proxy' })
  await page.evaluate(async () => {
    const { nativeFixture } = await import('/tests/native-mock.ts')
    nativeFixture.handlers.http_request = async () => { throw new Error('API Key 无效或已过期（HTTP 401）') }
  })
  await page.getByRole('button', { name: '检测 API 地址', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('HTTP 401')
  await page.getByLabel('模型 ID', { exact: true }).fill('manual-after-failure')
  await page.getByRole('button', { name: '添加模型', exact: true }).click()
  await page.getByRole('tab', { name: '历史命令提示', exact: true }).click()
  await page.getByRole('tab', { name: '模型服务', exact: true }).click()
  await expect(page.getByRole('button', { name: '检测模型 manual-after-failure', exact: true })).toBeVisible()
})
