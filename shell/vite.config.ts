// @ts-nocheck
import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type ResolvedConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

function copyRuntimeAssets() {
  let config: ResolvedConfig
  return {
    name: 'seal-copy-runtime-assets',
    configResolved(resolved: ResolvedConfig) {
      config = resolved
      const assets = [
        ['@verdigris/libssh2.js/dist/libssh2.wasm', 'libssh2.wasm'],
      ]
      mkdirSync(config.publicDir, { recursive: true })
      for (const [source, target] of assets) {
        copyFileSync(resolve(config.root, 'node_modules', source), resolve(config.publicDir, target))
      }
    },
  }
}

export default defineConfig({
  optimizeDeps: { include: ['@verdigris/libssh2.js'] },
  plugins: [
    copyRuntimeAssets(),
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
      },
      manifest: {
        name: 'SealShell',
        short_name: 'SealShell',
        description: 'Local-first SSH terminal console',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
})
