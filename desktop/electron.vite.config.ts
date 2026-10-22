import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { rendererCspPlugin } from './src/shared/vite-csp-plugin'

const repoRoot = resolve(__dirname, '..')
// SEC-05: the production CSP in the build, the dev policy (HMR) in the dev
// server; EMPEROR_CSP_REPORT_ONLY=1 only reports violations.
const csp = rendererCspPlugin({
  reportOnly: process.env.EMPEROR_CSP_REPORT_ONLY === '1',
  reportFile:
    process.env.EMPEROR_CSP_REPORT_FILE ??
    resolve(__dirname, 'out-e2e', 'csp-reports.jsonl'),
})

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ include: ['typescript', 'node-pty'] })],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        external: ['turndown', '@anthropic-ai/claude-agent-sdk'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          recovery: resolve(__dirname, 'src/preload/recovery.ts'),
        },
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
    plugins: [vue(), csp],
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
