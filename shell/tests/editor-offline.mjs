// Run after npm run build. Exercises the shipped PWA, including its precache.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const assets = await readdir(new URL('../dist/assets/', import.meta.url))
const index = assets.find(name => /^index-.*\.js$/.test(name))
const documents = assets.find(name => /^documents-.*\.js$/.test(name))
assert(index && documents, 'Build the PWA before running the offline editor check')
assert(assets.some(name => /^editor\.worker-.*\.js$/.test(name)))
assert(!assets.some(name => /(?:json|ts|css|html)\.worker-/.test(name)), 'Language service workers must not be bundled')
const serviceWorker = await readFile(new URL('../dist/sw.js', import.meta.url), 'utf8')
for (const asset of assets.filter(name => /^(?:documents-|editor\.worker-|python-|yaml-|codicon-)/.test(name))) {
  assert(serviceWorker.includes(asset), `${asset} is missing from the offline precache`)
}
const server = await preview({ root, preview: { host: '127.0.0.1', port: 9325, strictPort: true } })
let browser
try {
  browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
  const context = await browser.newContext()
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('http://127.0.0.1:9325/')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
  await context.setOffline(true)
  // Find the store exported to the lazy document chunk, without adding a test
  // hook or an alternate editor entry point to the production application.
  await page.evaluate(async index => {
    const module = await import('/assets/' + index)
    const store = Object.values(module).find(value => value && Array.isArray(value.tabs) && typeof value.bottomPanelOpen === 'boolean')
    if (!store) throw new Error('Production store export was not found')
    store.pairingModalOpen = false
    store.view = 'shell'
    store.tabs.push({ id: 'offline-editor', kind: 'editor', endpoint: { kind: 'local', nodeId: 'offline-fixture' }, label: 'offline.py', state: 'online', error: '', sessionId: '', terminalId: '', encoding: 'utf-8',
      editor: { path: '/offline.py', content: 'def hello():\n    return "offline"\n', language: 'plaintext', encoding: 'utf-8', bom: false, lineEnding: '\n', size: 0, contentVersion: 0, dirty: false, largeFileConfirmed: false } })
    store.bottomPanelOpen = true
    store.bottomPanelCategory = 'editors'
    store.activeEditorTabId = 'offline-editor'
    store.focusedDock = 'bottomPanel'
  }, index)
  const panel = page.locator('[data-editor-tab="offline-editor"]')
  await expect(panel.locator('.monaco-editor')).toBeVisible()
  await expect.poll(() => panel.locator('.view-lines span[class^="mtk"]').evaluateAll(spans => new Set(spans.map(span => getComputedStyle(span).color)).size)).toBeGreaterThan(2)
  await panel.getByRole('button', { name: '查找/替换', exact: true }).click()
  await expect(panel.getByRole('textbox', { name: '查找', exact: true })).toBeVisible()
  await expect(panel.locator('.find-widget')).toHaveCSS('background-color', 'rgb(37, 37, 38)')
  assert.deepEqual(errors, [])
  console.log('PASS production PWA opens Monaco for the first time offline with syntax, locale, styles and cached text worker; no language-service workers')
} finally {
  await browser?.close()
  server.httpServer.closeAllConnections()
  await new Promise(resolve => server.httpServer.close(resolve))
}
