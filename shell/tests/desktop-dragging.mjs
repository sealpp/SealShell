import { expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const mouseScript = fileURLToPath(new URL('./desktop-mouse.py', import.meta.url))
const python = process.env.SEAL_PYTHON ?? fileURLToPath(new URL('../../.venv/Scripts/python.exe', import.meta.url))

export async function verifyDesktopDragging(page, { local, remote, artifacts, pid }) {
  // CDP mouse input and synthetic DragEvents bypass the Windows OLE drop
  // handler. Use OS input so the real WebView2 drag interception is exercised.
  async function gesture(from, to) {
    const scale = await page.evaluate(() => window.devicePixelRatio)
    await run(python, [mouseScript, '--pid', String(pid),
      '--from', String(from.x), String(from.y), '--to', String(to.x), String(to.y), '--scale', String(scale)], { windowsHide: true })
  }

  async function drag(source, target, position) {
    const from = await source.boundingBox()
    const to = await target.boundingBox()
    expect(from).not.toBeNull()
    expect(to).not.toBeNull()
    await gesture({ x: from.x + Math.min(24, from.width / 2), y: from.y + from.height / 2 },
      { x: to.x + position.x, y: to.y + position.y })
  }

  async function resize(handle, surface, dimension, dx, dy) {
    const before = await surface.boundingBox()
    const bounds = await handle.boundingBox()
    const from = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await gesture(from, { x: from.x + dx, y: from.y + dy })
    await expect.poll(async () => Math.abs((await surface.boundingBox())[dimension] - before[dimension])).toBeGreaterThan(20)
  }

  await resize(page.locator('.panel-resizer'), page.locator('aside.primary-sidebar'), 'width', 32, 0)
  await resize(page.getByRole('separator', { name: '调整面板高度', exact: true }), page.locator('.workspace-panel'), 'height', 0, -32)
  await resize(page.getByRole('separator', { name: '调整实例列表宽度', exact: true }), page.locator('.workspace-category-view.active .workspace-instance-list'), 'width', -32, 0)
  console.log('Desktop dragging: sidebar, bottom panel and instance list resizing')

  await page.evaluate(async () => {
    await window.desktopFixture.ws.createFolder({ id: 'desktop-drag-folder', name: 'Drag target', parentId: null })
  })
  const host = page.locator('.conn-item').filter({ hasText: 'Desktop fixture' })
  const folder = page.locator('.conn-item.folder').filter({ hasText: 'Drag target' })
  await drag(host, folder, { x: 50, y: 11 })
  await expect.poll(() => page.evaluate(() => window.desktopFixture.store.hosts.find(host => host.id === 'desktop-fixture').folderId)).toBe('desktop-drag-folder')
  const persistedFolder = await page.evaluate(async () => {
    const { nativeCall } = await import('/src/native/bridge.ts')
    return (await nativeCall('store_get', { collection: 'hosts', key: 'desktop-fixture' })).folderId
  })
  expect(persistedFolder).toBe('desktop-drag-folder')
  const tree = page.locator('.conn-list')
  const treeBox = await tree.boundingBox()
  await drag(host, tree, { x: 30, y: treeBox.height - 12 })
  await expect.poll(() => page.evaluate(() => window.desktopFixture.store.hosts.find(host => host.id === 'desktop-fixture').folderId)).toBe(null)
  console.log('Desktop dragging: connection tree move into a folder and back to root, SQLite persistence')

  const terminalId = await page.evaluate(() => {
    const { store, ws } = window.desktopFixture
    const tab = ws.addTab(store.hosts.find(host => host.id === 'desktop-fixture'), 'fixture-password')
    tab.label = 'Drag terminal'
    return tab.id
  })
  await page.waitForFunction(id => window.desktopFixture.store.tabs.find(tab => tab.id === id)?.state === 'online', terminalId)
  const terminal = page.locator('.main-dock .terminal-tab').filter({ hasText: 'Drag terminal' })
  const firstTerminal = page.locator('.main-dock .terminal-tab').filter({ hasText: 'Desktop fixture' })
  await drag(terminal, firstTerminal, { x: 2, y: 12 })
  await expect(page.locator('.main-dock .terminal-tab').first()).toContainText('Drag terminal')
  const mainDock = page.locator('.main-dock')
  const mainBox = await mainDock.boundingBox()
  await drag(terminal, mainDock, { x: mainBox.width - 5, y: mainBox.height / 2 })
  await expect(page.locator('.main-dock .dv-groupview')).toHaveCount(2)
  await expect(page.locator('.main-dock .shell-terminal-content:visible')).toHaveCount(2)
  await page.evaluate(id => window.desktopFixture.ws.closeTabs([id]), terminalId)
  await expect(page.locator('.main-dock .dv-groupview')).toHaveCount(1)
  console.log('Desktop dragging: terminal tab reordering and split panes retain live SSH sessions')

  const ids = await page.evaluate(async local => {
    const { navigateFileTab } = await import('/src/services/sftp/file-tabs.ts')
    const { local: localId, remote: remoteId } = window.desktopFixture
    await navigateFileTab(localId, local)
    return { localId, remoteId }
  }, local)
  const localPanel = page.locator(`.file-panel[data-file-tab="${ids.localId}"]`)
  const remotePanel = page.locator(`.file-panel[data-file-tab="${ids.remoteId}"]`)
  const localInstance = page.locator(`.workspace-instance[data-tab-id="${ids.localId}"]`)
  await page.locator(`.workspace-instance[data-tab-id="${ids.remoteId}"]`).click()
  const fileDock = page.locator('.workspace-category-view.active .workspace-dock')
  const fileBox = await fileDock.boundingBox()
  await drag(localInstance, fileDock, { x: 8, y: fileBox.height / 2 })
  await expect(localPanel).toBeVisible()
  await expect(remotePanel).toBeVisible()
  await expect(page.locator('.workspace-category-view.active .workspace-instance-marker')).toHaveText(['┌', '└'])
  await resize(localPanel.getByRole('separator', { name: '调整名称列宽', exact: true }), localPanel.getByRole('columnheader').first(), 'width', 32, 0)
  const sash = page.locator('.workspace-category-view.active .dv-sash.dv-enabled').first()
  await resize(sash, localPanel, 'width', 32, 0)
  console.log('Desktop dragging: bottom instances split into panes, file column and pane resizing')

  const name = 'drag-copy.txt'
  const contents = 'Copied by a real WebView2 drag gesture.\n'
  await writeFile(join(local, name), contents)
  await localPanel.getByRole('button', { name: '刷新', exact: true }).click()
  const file = localPanel.locator('.file-row').filter({ hasText: name })
  await expect(file).toBeVisible()
  const remoteBox = await remotePanel.boundingBox()
  await drag(file, remotePanel, { x: 40, y: remoteBox.height - 25 })
  await expect.poll(() => readFile(join(remote, name), 'utf8')).toBe(contents)
  expect(await readFile(join(local, name), 'utf8')).toBe(contents)
  await expect(remotePanel.locator('.file-row').filter({ hasText: name })).toBeVisible()
  await page.screenshot({ path: join(artifacts, 'desktop-dragging.png') })
  console.log('Desktop dragging: local-to-remote file copy through the transfer queue preserves the source')
}
