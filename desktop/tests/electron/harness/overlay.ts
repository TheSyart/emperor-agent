import { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ControlOverlay } from '../../../src/main/computer-use/control-overlay'
import type { E2eResult } from './main'

export async function runOverlay(
  report: (result: E2eResult) => void,
): Promise<void> {
  const started = Date.now()
  let stops = 0
  const overlay = new ControlOverlay(() => {
    stops += 1
  })
  try {
    overlay.sync({
      enabled: true,
      stopped: false,
      targets: [
        { title: 'Fixture Chrome', state: 'attached', control: 'agent' },
      ],
    })
    const win = BrowserWindow.getAllWindows().at(-1)
    if (!win) throw new Error('overlay window was not created')
    await new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    )
    const shot = await win.capturePage()
    writeFileSync(join(__dirname, 'control-overlay.png'), shot.toPNG())
    report({
      suite: 'overlay',
      name: 'visible nonfocusable window',
      ok: win.isVisible() && !win.isFocusable(),
      ms: Date.now() - started,
      detail: { visible: win.isVisible(), focusable: win.isFocusable() },
    })
    const physicalClick = process.env.EMPEROR_E2E_PHYSICAL_OVERLAY === '1'
    if (!physicalClick)
      await win.webContents.executeJavaScript(
        'document.querySelector(".stop").click()',
      )
    const deadline = Date.now() + (physicalClick ? 45_000 : 2000)
    while (stops === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    report({
      suite: 'overlay',
      name: 'stop button reaches main process',
      ok: stops === 1,
      ms: Date.now() - started,
      detail: { stops },
    })
    overlay.sync(null)
    report({
      suite: 'overlay',
      name: 'hides after control ends',
      ok: !win.isVisible(),
      ms: Date.now() - started,
    })
  } finally {
    overlay.dispose()
  }
}
