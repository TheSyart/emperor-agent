import { defineConfig } from '@playwright/test'
import { CSP_REPORT_FILE } from './tests/visual/csp-reports'

// A dedicated renderer port (strict): the common 5173 is often taken by
// another local Vite project, and reusing that server would screenshot the
// wrong app.
const PORT = 5577
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests/visual',
  // SEC-05: every page runs under the renderer CSP; any violation fails the
  // run (EMPEROR_CSP_REPORT_ONLY=1: collect only).
  globalSetup: './tests/visual/csp-setup.ts',
  globalTeardown: './tests/visual/csp-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev:renderer -- --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: BASE_URL,
    env: { EMPEROR_CSP_REPORT_FILE: CSP_REPORT_FILE },
    reuseExistingServer: true,
    timeout: 90_000,
  },
})
