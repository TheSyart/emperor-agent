/**
 * Electron entry for the Computer Use end-to-end suite (bundled to
 * `out-e2e/harness.cjs` by `scripts/e2e-cu.mjs`, never packaged). It runs
 * one mode inside a real Electron main process and prints one
 * `E2E-RESULT <json>` line per check:
 *
 *   --mode=smoke     fixture site loads in an offscreen agent tab
 *   --mode=contract  driver contract cases against the embedded driver
 *   --mode=extra     iframes, overlays, dialogs, crashes, debugger loss,
 *                    profile isolation, restart recovery
 *
 * `--mode=restart_phase` is internal: one launch of the M2.7 restart case
 * (restart.ts), spawned by the extra suite.
 */

import { app, BaseWindow, WebContentsView } from 'electron'
import { startFixtureSite } from '../fixtures/site'
import { runContract } from './contract'
import { runExtra } from './extra'
import { runOverlay } from './overlay'
import { runRestartPhase } from './restart'

export interface E2eResult {
  readonly suite: string
  readonly name: string
  readonly ok: boolean
  readonly ms: number
  readonly detail?: unknown
  readonly error?: string
}

export function report(result: E2eResult): void {
  process.stdout.write(`E2E-RESULT ${JSON.stringify(result)}\n`)
}

async function smoke(): Promise<void> {
  const site = await startFixtureSite()
  const host = new BaseWindow({ show: false, width: 1280, height: 800 })
  try {
    for (const path of ['/form', '/spa', '/frames', '/shadow', '/slow']) {
      const started = Date.now()
      const view = new WebContentsView({
        webPreferences: {
          offscreen: true,
          sandbox: true,
          partition: 'e2e-smoke',
        },
      })
      host.contentView.addChildView(view)
      view.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
      try {
        await view.webContents.loadURL(`${site.origin}${path}`)
        report({
          suite: 'smoke',
          name: path,
          ok: view.webContents.getTitle() !== '',
          ms: Date.now() - started,
          detail: { title: view.webContents.getTitle() },
        })
      } catch (error) {
        report({
          suite: 'smoke',
          name: path,
          ok: false,
          ms: Date.now() - started,
          error: String(error),
        })
      } finally {
        host.contentView.removeChildView(view)
        view.webContents.close()
      }
    }
  } finally {
    host.destroy()
    await site.close()
  }
}

const mode = /--mode=(\w+)/.exec(process.argv.join(' '))?.[1] ?? 'smoke'

app.on('window-all-closed', () => undefined)
if (mode === 'restart_phase') {
  // Both launches of the restart case share one userData, like the app.
  const userData = process.env.CU_RESTART_USER_DATA
  if (userData) app.setPath('userData', userData)
  // Quit normally (not app.exit) so storage shuts down as it does in the app.
  app
    .whenReady()
    .then(runRestartPhase)
    .then(
      () => app.quit(),
      (error: unknown) => {
        const text =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        process.stdout.write(`E2E-PHASE-ERROR ${JSON.stringify(text)}\n`, () =>
          app.exit(1),
        )
      },
    )
} else {
  app
    .whenReady()
    .then(async () => {
      if (mode === 'contract') await runContract(report)
      else if (mode === 'extra') await runExtra(report)
      else if (mode === 'overlay') await runOverlay(report)
      else await smoke()
    })
    .catch((error: unknown) => {
      report({
        suite: mode,
        name: 'harness',
        ok: false,
        ms: 0,
        error: String(error),
      })
    })
    .finally(() => {
      process.stdout.write('E2E-DONE\n', () => app.exit(0))
    })
}
