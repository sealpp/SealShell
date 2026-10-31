import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('shows detected OS logos in root and nested rows and restores saved results', async ({ page }) => {
  await page.goto('/tests/connections-tree-harness.html')
  await page.locator('.conn-list').waitFor()
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { nativeCall } = await import('/src/native/bridge.ts')
    const { loadHostSystems } = await import('/src/services/remoteSystem.ts')
    const changes = store.hosts.map((host, index) => ({
      collection: 'hostSystems', key: host.id, value: {
        id: host.id, target: { address: host.address, port: host.port, username: host.username },
        info: index === 0 ? { family: 'linux', id: 'ubuntu', name: 'Ubuntu 24.04 LTS' }
          : index === 1 ? { family: 'windows', id: 'windows', name: 'Windows' }
          : { family: 'macos', id: 'macos', name: 'macOS' },
      },
    }))
    await nativeCall('store_write', { changes })
    await loadHostSystems()
  })
  for (const [label, name] of [['Root host', 'Ubuntu 24.04 LTS'], ['Alpha host', 'Windows'], ['Nested host', 'macOS']]) {
    const row = page.locator('.conn-item').filter({ hasText: label })
    const icon = row.getByRole('img', { name, exact: true })
    await expect(icon).toBeVisible()
    await expect(icon).toHaveCSS('width', '16px')
    await expect(icon).toHaveJSProperty('naturalWidth', 32)
    await expect(row).toHaveAttribute('title', new RegExp(`SSH · .*\\n${name}\\n双击连接`))
  }
  const root = page.locator('.conn-item').filter({ hasText: 'Root host' })
  await root.click()
  await root.hover()
  await expect(root.getByRole('img', { name: 'Ubuntu 24.04 LTS' })).toBeVisible()
  const screenshots = join(tmpdir(), 'seal-e2e', 'connections')
  await mkdir(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, 'remote-system-icons.png'), clip: { x: 0, y: 0, width: 360, height: 220 } })
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    store.hostSystems = {}
    await (await import('/src/services/remoteSystem.ts')).loadHostSystems()
  })
  await expect(root.getByRole('img', { name: 'Ubuntu 24.04 LTS' })).toBeVisible()
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    store.hosts.find(host => host.id === 'host-root')!.address = 'changed-target'
  })
  await expect(root.getByRole('img', { name: 'SSH 终端' })).toBeVisible()
  await expect(root).not.toHaveAttribute('title', /Ubuntu/)
})

test('updates an icon when discovery completes and keeps unknown distributions generic', async ({ page }) => {
  await page.goto('/tests/connections-tree-harness.html')
  const root = page.locator('.conn-item').filter({ hasText: 'Root host' })
  await expect(root.getByRole('img', { name: 'SSH 终端' })).toBeVisible()
  await page.evaluate(async () => {
    const { store } = await import('/src/stores/app.ts')
    const { nativeFixture } = await import('/tests/native-mock.ts')
    const { detectHostSystem } = await import('/src/services/remoteSystem.ts')
    const host = store.hosts.find(host => host.id === 'host-root')!
    nativeFixture.handlers.ssh_detect_system = () => ({
      id: host.id, target: { address: host.address, port: host.port, username: host.username },
      info: { family: 'linux', id: 'custom', name: 'Custom Linux aarch64' },
    })
    await detectHostSystem(host.id, 'fixture-session')
  })
  const icon = root.getByRole('img', { name: 'Custom Linux aarch64' })
  await expect(icon).toBeVisible()
  await expect(icon).toHaveAttribute('src', /\/linux\.svg/)
})
