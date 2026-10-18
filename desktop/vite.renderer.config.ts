import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { rendererCspPlugin } from './src/shared/vite-csp-plugin'

const repoRoot = resolve(__dirname, '..')

export default defineConfig({
  root: 'src/renderer',
  base: './',
  // SEC-05: the dev CSP, with violation reports for the visual suite.
  plugins: [
    vue(),
    rendererCspPlugin({
      reportOnly: process.env.EMPEROR_CSP_REPORT_ONLY === '1',
      reportFile:
        process.env.EMPEROR_CSP_REPORT_FILE ??
        resolve(__dirname, 'out-e2e', 'visual-csp-reports.jsonl'),
    }),
  ],
  resolve: {
    alias: { '@renderer': resolve(__dirname, 'src/renderer/src') },
  },
  server: {
    fs: { allow: [repoRoot] },
  },
})
