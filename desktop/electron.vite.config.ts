import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const repoRoot = resolve(__dirname, '..')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['typescript'] })],
    build: { outDir: 'out/main' },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          chunkFileNames: '[name]-[hash].cjs',
        },
      },
    },
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
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
})
