import { expect } from '@playwright/test'
import { join } from 'node:path'

export async function verifyDesktopHostKeys(page, { port, artifacts }) {
  const trusted = await page.evaluate(async port => {
    const { nativeCall } = await import('/src/native/bridge.ts')
    return nativeCall('store_get', { collection: 'knownHosts', key: `127.0.0.1\0${port}` })
  }, port)
  const previous = { ...trusted, publicKey: 'previous-server-key', fingerprint: 'SHA256:Vq5G7EYWXBj8wOcLwCVPVcWYFLHnUoO1ZC7K6NfQTGQ' }
  // Seed a prior server key so the real SSH handshake exercises key rotation.
  await page.evaluate(async previous => {
    const { nativeCall } = await import('/src/native/bridge.ts')
    await nativeCall('store_write', { changes: [{ collection: 'knownHosts', key: previous.id, value: previous }] })
  }, previous)
  const connect = () => page.evaluate(() => {
    const { store, ws } = window.desktopFixture
    return ws.addTab(store.hosts.find(host => host.id === 'desktop-fixture'), 'fixture-password').id
  })
  const close = id => page.evaluate(id => window.desktopFixture.ws.closeTabs([id]), id)
  const read = () => page.evaluate(async port => {
    const { nativeCall } = await import('/src/native/bridge.ts')
    return nativeCall('store_get', { collection: 'knownHosts', key: `127.0.0.1\0${port}` })
  }, port)
  const dialog = page.getByRole('dialog', { name: '远端主机密钥已变化', exact: true })

  const rejected = await connect()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(previous.fingerprint, { exact: true })).toBeVisible()
  await expect(dialog.getByText(trusted.fingerprint, { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '取消连接' })).toBeFocused()
  expect(await read()).toEqual(previous)
  expect(await page.evaluate(id => window.desktopFixture.store.tabs.find(tab => tab.id === id).state, rejected)).toBe('connecting')
  await page.screenshot({ path: join(artifacts, 'host-key-changed.png') })
  await dialog.getByRole('button', { name: '取消连接' }).click()
  await page.waitForFunction(id => window.desktopFixture.store.tabs.find(tab => tab.id === id)?.state === 'error', rejected)
  expect(await read()).toEqual(previous)
  await close(rejected)

  const cancelled = await connect()
  await expect(dialog).toBeVisible()
  await close(cancelled)
  await expect(dialog).toHaveCount(0)
  expect(await read()).toEqual(previous)

  const accepted = await connect()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '更新并连接' }).click()
  await page.waitForFunction(id => window.desktopFixture.store.tabs.find(tab => tab.id === id)?.state === 'online', accepted)
  expect(await read()).toEqual(trusted)
  await close(accepted)

  const unchanged = await connect()
  await page.waitForFunction(id => window.desktopFixture.store.tabs.find(tab => tab.id === id)?.state === 'online', unchanged)
  await expect(dialog).toHaveCount(0)
  await close(unchanged)
  console.log('Desktop host keys: changed-key warning, both fingerprints, cancellation, session close, accepted replacement and trusted reconnect')
}
