import { defineConfig } from '@playwright/test'

// A dedicated renderer port (strict): the common 5173 is often taken by
// another local Vite project, and reusing that server would screenshot the
// wrong app.
const PORT = 5317
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './tests/visual',
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
    reuseExistingServer: true,
    timeout: 90_000,
  },
})
