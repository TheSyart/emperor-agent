import { defineConfig } from '@playwright/test'
import { CSP_REPORT_FILE } from './tests/visual/csp-reports'

// A dedicated renderer port (strict): the common 5173 is often taken by
// another local Vite project, and reusing that server would screenshot the
// wrong app. EMPEROR_VISUAL_PORT picks another one (parallel worktrees); a
// private config can also call visualConfig(port).
const DEFAULT_PORT = 5317

export function visualConfig(
  port = Number(process.env.EMPEROR_VISUAL_PORT) || DEFAULT_PORT,
) {
  const baseURL = `http://127.0.0.1:${port}`
  return defineConfig({
    testDir: './tests/visual',
    // SEC-05: every page runs under the renderer CSP; any violation fails the
    // run (EMPEROR_CSP_REPORT_ONLY=1: collect only).
    globalSetup: './tests/visual/csp-setup.ts',
    globalTeardown: './tests/visual/csp-teardown.ts',
    timeout: 60_000,
    // DS-06 pixel baselines (tests/visual/baseline.ts): one committed PNG per
    // key screen and theme, at tests/visual/__baselines__/<area>/<screen>.png.
    snapshotPathTemplate: '{testDir}/__baselines__/{arg}{ext}',
    expect: {
      timeout: 10_000,
      toHaveScreenshot: {
        // At most 0.1% of the pixels may differ, and a pixel only counts as
        // the same when its colour is within 0.02 (YIQ): a 6-level shift of
        // a grey surface already fails.
        maxDiffPixelRatio: 0.001,
        threshold: 0.02,
        animations: 'disabled',
        caret: 'hide',
        scale: 'css',
      },
    },
    reporter: [['list']],
    use: {
      baseURL,
      trace: 'retain-on-failure',
    },
    webServer: {
      command: `npm run dev:renderer -- --host 127.0.0.1 --port ${port} --strictPort`,
      url: baseURL,
      env: { EMPEROR_CSP_REPORT_FILE: CSP_REPORT_FILE },
      reuseExistingServer: true,
      timeout: 90_000,
    },
  })
}

export default visualConfig()
