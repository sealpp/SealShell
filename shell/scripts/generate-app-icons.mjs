// Regenerate every browser and installed-app icon from the in-app logo.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const publicDirectory = new URL('../public/', import.meta.url)
const logo = await readFile(new URL('icon.svg', publicDirectory))
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const pngSizes = [16, 32, 180, 192, 512]
const browser = await chromium.launch()
let images
try {
  const page = await browser.newPage()
  images = await page.evaluate(async ({ source, sizes }) => {
    const image = new Image()
    image.src = source
    await image.decode()
    function render(size, scale = 1, background) {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const context = canvas.getContext('2d')
      if (background) {
        context.fillStyle = background
        context.fillRect(0, 0, size, size)
      }
      context.imageSmoothingQuality = 'high'
      const inset = size * (1 - scale) / 2
      context.drawImage(image, inset, inset, size * scale, size * scale)
      return canvas.toDataURL('image/png').split(',')[1]
    }
    return {
      normal: Object.fromEntries(sizes.map(size => [size, render(size)])),
      touch: render(180, 1, '#181818'),
      maskable: render(512, 0.8, '#181818'),
    }
  }, {
    source: `data:image/svg+xml;base64,${logo.toString('base64')}`,
    sizes: [...new Set([...icoSizes, ...pngSizes])],
  })
} finally {
  await browser.close()
}

const iconsDirectory = new URL('icons/', publicDirectory)
await mkdir(iconsDirectory, { recursive: true })
for (const size of pngSizes) {
  const png = size === 180 ? images.touch : images.normal[size]
  await writeFile(new URL(`sealshell-${size}.png`, iconsDirectory), Buffer.from(png, 'base64'))
}
await writeFile(new URL('sealshell-maskable-512.png', iconsDirectory), Buffer.from(images.maskable, 'base64'))

// ICO directory entries point to PNG frames, retaining transparency at each
// Windows display scale. A zero width/height byte represents a 256px frame.
const frames = icoSizes.map(size => Buffer.from(images.normal[size], 'base64'))
const directory = Buffer.alloc(6 + frames.length * 16)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(frames.length, 4)
let offset = directory.length
for (let index = 0; index < frames.length; index++) {
  const entry = 6 + index * 16
  directory[entry] = directory[entry + 1] = icoSizes[index] % 256
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(frames[index].length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += frames[index].length
}
await writeFile(new URL('favicon.ico', publicDirectory), Buffer.concat([directory, ...frames]))
console.log('Generated browser, touch and PWA icons from public/icon.svg')
