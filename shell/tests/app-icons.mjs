// Run after npm run build; validates the shipped icons and offline cache.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { chromium } from '@playwright/test'

const root = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../dist/manifest.webmanifest', import.meta.url), 'utf8'))
for (const size of [192, 512]) {
  assert(manifest.icons.some(icon => icon.type === 'image/png' && icon.sizes === `${size}x${size}` && icon.purpose === 'any'))
}
const maskable = manifest.icons.find(icon => icon.purpose === 'maskable')
assert.equal(maskable?.sizes, '512x512')
assert.equal(manifest.start_url, '/')
assert.equal(manifest.name, 'SealShell')

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
}
for (const icon of manifest.icons) {
  const bytes = await readFile(new URL(`../dist${icon.src}`, import.meta.url))
  assert.deepEqual(pngSize(bytes), icon.sizes.split('x').map(Number))
}
const ico = await readFile(new URL('../dist/favicon.ico', import.meta.url))
assert.equal(ico.readUInt32LE(0), 0x00010000)
const frames = []
for (let index = 0; index < ico.readUInt16LE(4); index++) {
  const entry = 6 + index * 16
  const width = ico[entry] || 256
  const height = ico[entry + 1] || 256
  const length = ico.readUInt32LE(entry + 8)
  const offset = ico.readUInt32LE(entry + 12)
  assert(offset + length <= ico.length)
  assert.deepEqual(pngSize(ico.subarray(offset, offset + length)), [width, height])
  frames.push(width)
}
for (const size of [16, 32, 48, 256]) assert(frames.includes(size))

const server = await preview({ root, preview: { host: '127.0.0.1', port: 9325, strictPort: true } })
let browser
try {
  browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:9325/')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller)
  const cdp = await context.newCDPSession(page)
  const loadedManifest = await cdp.send('Page.getAppManifest')
  assert.deepEqual(loadedManifest.errors, [])
  assert.deepEqual(JSON.parse(loadedManifest.data).icons, manifest.icons)
  const installability = await cdp.send('Page.getInstallabilityErrors')
  assert.deepEqual(installability.installabilityErrors, [])
  const links = await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll(elements => elements.map(element => ({
    src: new URL(element.href).pathname, sizes: element.sizes.value, rel: element.rel,
  })))
  assert(links.some(link => link.src === '/favicon.ico'))
  assert(links.some(link => link.sizes === '16x16' && link.src.endsWith('.png')))
  assert(links.some(link => link.sizes === '32x32' && link.src.endsWith('.png')))
  assert(links.some(link => link.rel === 'apple-touch-icon' && link.sizes === '180x180'))

  await context.setOffline(true)
  const sources = [...new Set([...manifest.icons.map(icon => icon.src), ...links.map(link => link.src)])]
  const images = await page.evaluate(async sources => {
    const results = []
    for (const src of sources) {
      const response = await fetch(src)
      if (!response.ok) throw new Error(`Offline icon failed: ${src}`)
      const image = new Image()
      image.src = src
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let colored = 0
      let unsafe = 0
      for (let pixel = 0; pixel < pixels.length; pixel += 4) {
        if (pixels[pixel + 3] && (pixels[pixel] !== pixels[pixel + 1] || pixels[pixel + 1] !== pixels[pixel + 2])) colored++
        if (src.includes('maskable')) {
          const x = (pixel / 4) % canvas.width + 0.5 - canvas.width / 2
          const y = Math.floor(pixel / 4 / canvas.width) + 0.5 - canvas.height / 2
          if (Math.hypot(x, y) > canvas.width * 0.4 && (pixels[pixel] !== 24 || pixels[pixel + 1] !== 24 || pixels[pixel + 2] !== 24 || pixels[pixel + 3] !== 255)) unsafe++
        }
      }
      results.push({ src, width: image.naturalWidth, height: image.naturalHeight, colored, unsafe })
    }
    return results
  }, sources)
  for (const image of images) {
    assert(image.width > 0 && image.width === image.height)
    assert(image.colored > 0, `${image.src} must contain the colored logo`)
    assert.equal(image.unsafe, 0, `${image.src} must fit inside the maskable safe circle`)
  }
  console.log('PASS browser favicon, touch icon and installable PWA manifest use the app logo; all icon sizes decode offline and maskable artwork stays within its safe circle')
} finally {
  await browser?.close()
  server.httpServer.closeAllConnections()
  await new Promise(resolve => server.httpServer.close(resolve))
}
