/**
 * REL-04 (MAIN-29): the packaged main window closes and comes back. The
 * smoke opens the real main window (createWindow), closes it, and asks for
 * it again the way the Dock does (`activate`, showMainWindow): a new window
 * must load the bundle and reach Core through the preload bridge, and
 * closing it must release it again. index.ts supplies the real functions.
 */

export interface SmokeWindow {
  readonly id: number
  isDestroyed(): boolean
  webContents: { executeJavaScript(source: string): Promise<unknown> }
}

export interface PackagedWindowSmokeReceipt {
  ok: boolean
  /** The first main window loaded and its UI reached Core. */
  opened: boolean
  /** Closing it destroyed it and released the main window. */
  closed: boolean
  /** `activate` opened a main window again. */
  reopened: boolean
  /** …a new one, not the closed one. */
  distinctWindow: boolean
  /** The reopened window's UI reached Core too. */
  coreAfterReopen: boolean
}

export interface WindowReopenDeps {
  /** Opens the real main window and resolves once it finished loading. */
  open(): Promise<SmokeWindow>
  /** Closes a window and resolves on its `closed` event. */
  close(win: SmokeWindow): Promise<void>
  /** The Dock's `activate`, resolving with the window it showed, once loaded. */
  reopen(): Promise<SmokeWindow>
  /** The window index.ts holds as the main window, if any. */
  current(): SmokeWindow | null
  timeoutMs?: number
}

/** The mounted UI, and a Core bootstrap through the preload bridge. */
export const WINDOW_PROBE_SOURCE = `(async () => {
  const mounted = await new Promise((resolve) => {
    const app = document.querySelector('#app')
    if (app?.childElementCount) return resolve(true)
    const observer = new MutationObserver(() => {
      if (!app?.childElementCount) return
      observer.disconnect()
      resolve(true)
    })
    if (app) observer.observe(app, { childList: true })
    setTimeout(() => { observer.disconnect(); resolve(false) }, 5000)
  })
  let coreBootstrap = false
  try {
    const boot = await globalThis.emperor?.invokeCore('bootstrap')
    coreBootstrap = Boolean(boot && boot.app === 'Emperor Agent')
  } catch {}
  return { mounted, coreBootstrap }
})()`

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`packaged window smoke timed out: ${what}`)),
          timeoutMs,
        )
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function answers(win: SmokeWindow, timeoutMs: number): Promise<boolean> {
  const probe = (await withTimeout(
    win.webContents.executeJavaScript(WINDOW_PROBE_SOURCE),
    timeoutMs,
    'the window probe',
  )) as { mounted?: unknown; coreBootstrap?: unknown } | null
  return probe?.mounted === true && probe.coreBootstrap === true
}

export async function verifyWindowReopen(
  deps: WindowReopenDeps,
): Promise<PackagedWindowSmokeReceipt> {
  const timeoutMs = Math.max(1, deps.timeoutMs ?? 20_000)
  const first = await withTimeout(
    deps.open(),
    timeoutMs,
    'open the main window',
  )
  if (!(await answers(first, timeoutMs)))
    throw new Error('the main window did not load the bundle or reach Core')

  await withTimeout(deps.close(first), timeoutMs, 'close the main window')
  if (!first.isDestroyed() || deps.current() !== null)
    throw new Error('closing the main window left it behind')

  const second = await withTimeout(
    deps.reopen(),
    timeoutMs,
    'reopen the main window',
  )
  if (second === first || second.id === first.id || second.isDestroyed())
    throw new Error('activate did not open a new main window')
  if (!(await answers(second, timeoutMs)))
    throw new Error(
      'the reopened main window did not load the bundle or reach Core',
    )

  await withTimeout(deps.close(second), timeoutMs, 'close the reopened window')
  if (!second.isDestroyed() || deps.current() !== null)
    throw new Error('closing the reopened main window left it behind')

  return {
    ok: true,
    opened: true,
    closed: true,
    reopened: true,
    distinctWindow: true,
    coreAfterReopen: true,
  }
}
