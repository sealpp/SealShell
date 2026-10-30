import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: { entries: ['index.html', 'src/services/editor/runtime.ts'] },
  server: { host: '127.0.0.1', port: 8080, strictPort: true },
  resolve: { alias: { '@': resolve(__dirname, './src') } },
  build: { target: 'chrome105' },
})
