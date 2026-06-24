import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const repoRoot = resolve(__dirname, '..')

export default defineConfig({
  main: {
    build: { outDir: 'out/main' },
  },
  preload: {
    build: { outDir: 'out/preload' },
  },
  renderer: {
    root: 'src/renderer',
    base: './',
    plugins: [vue()],
    resolve: {
      alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      // Allow importing the shared repo-root assets/ directory from the renderer.
      fs: { allow: [repoRoot] },
      proxy: {
        '/api': 'http://127.0.0.1:8765',
        '/ws': { target: 'ws://127.0.0.1:8765', ws: true },
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
