import {
  shell,
  WebContentsView,
  type BrowserWindow,
  type Certificate,
  type Rectangle,
  type Session,
  type WebContents,
  type WebPreferences,
} from 'electron'
import {
  browserExternalOpenEligible,
  browserNavigationAllowed,
  normalizedBrowserBounds,
} from './browser-view-policy'
import {
  BROWSER_STATE_CHANNEL,
  type BrowserViewState,
} from '../shared/ipc-contract'

/**
 * In-memory partition of the embedded browser: without the persist: prefix
 * nothing reaches disk, and it is not the default session, so the `app://`
 * protocol handler and the app's own storage are unreachable from it.
 */
export const BROWSER_PARTITION = 'emperor-browser'

/** Minimum gap between two popups handed to the system browser. */
export const BROWSER_EXTERNAL_OPEN_INTERVAL_MS = 1_000

const ERR_ABORTED = -3

/** Sessions that already carry the browser hardening (process-wide). */
const hardenedSessions = new WeakSet<Session>()

export function browserViewWebPreferences(): WebPreferences {
  return {
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
  }
}

/**
 * The single embedded browser of the main window: a sandboxed
 * `WebContentsView` without preload in a memory-only partition. It only loads
 * URLs the user typed (normalized by `normalizeBrowserInput` before they get
 * here) and credential-free http(s) navigations from those pages.
 */
export class BrowserViewHost {
  private view: WebContentsView | null = null
  private pendingUrl = ''
  private bounds: Rectangle | null = null
  private clearing: Promise<void> = Promise.resolve()
  private lastExternalOpen = Number.NEGATIVE_INFINITY

  constructor(
    private readonly window: BrowserWindow,
    private readonly now: () => number = Date.now,
  ) {}

  async openUrl(input: { url: string }): Promise<{ ok: true; url: string }> {
    const url = typeof input?.url === 'string' ? input.url : ''
    if (!browserNavigationAllowed(url)) throw new Error('invalid browser url')
    // A previous close may still be wiping the partition.
    await this.clearing
    if (this.window.isDestroyed()) throw new Error('browser window is closed')
    const view = this.view ?? this.createView()
    this.pendingUrl = url
    view.webContents.loadURL(url).catch(() => {
      // Failed and superseded loads are reported through did-fail-load.
    })
    this.emitState(view)
    return { ok: true, url }
  }

  /** Place the view; null or a rectangle too small for a page hides it. */
  setBounds(value: unknown): void {
    this.bounds = normalizedBrowserBounds(value)
    this.applyBounds()
  }

  action(action: string): void {
    const contents = this.liveContents()
    if (!contents) return
    const history = contents.navigationHistory
    if (action === 'back' && history.canGoBack()) history.goBack()
    else if (action === 'forward' && history.canGoForward()) history.goForward()
    else if (action === 'reload') contents.reload()
    else if (action === 'stop') contents.stop()
  }

  close(): void {
    const view = this.view
    this.view = null
    this.pendingUrl = ''
    if (!view) return
    try {
      this.window.contentView.removeChildView(view)
    } catch {
      // Shutdown may have already detached the child view from the window.
    }
    const contents = view.webContents
    if (contents.isDestroyed()) return
    const session = contents.session
    contents.close()
    this.clearing = clearBrowsingData(session)
  }

  private createView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: browserViewWebPreferences(),
    })
    const contents = view.webContents
    hardenSession(contents.session)
    contents.setWindowOpenHandler(({ url }) => {
      this.openExternal(url)
      return { action: 'deny' }
    })
    const guard = (event: { url: string; preventDefault(): void }) => {
      if (!browserNavigationAllowed(event.url)) event.preventDefault()
    }
    contents.on('will-navigate', (details) => guard(details))
    contents.on('will-redirect', (details) => guard(details))
    contents.on('will-attach-webview', (event) => event.preventDefault())
    // Electron would otherwise answer with the first client certificate.
    contents.on('select-client-certificate', (event, _url, _list, callback) => {
      event.preventDefault()
      ;(callback as (certificate?: Certificate) => void)()
    })
    const emit = () => this.emitState(view)
    contents.on('did-start-loading', emit)
    contents.on('did-stop-loading', emit)
    contents.on('did-navigate', emit)
    contents.on('did-navigate-in-page', emit)
    contents.on('page-title-updated', emit)
    contents.on(
      'did-fail-load',
      (_event, code, description, _url, isMainFrame) => {
        if (!isMainFrame || code === ERR_ABORTED) return
        this.emitState(view, { error: `${description} (${code})` })
      },
    )
    contents.on('render-process-gone', (_event, details) =>
      this.emitState(view, { error: `页面进程已退出（${details.reason}）` }),
    )
    this.view = view
    this.applyBounds()
    this.window.contentView.addChildView(view)
    return view
  }

  private applyBounds(): void {
    const view = this.view
    if (!view) return
    if (this.bounds) view.setBounds(this.bounds)
    view.setVisible(this.bounds !== null)
  }

  private openExternal(url: string): void {
    if (!browserExternalOpenEligible(url)) return
    const now = this.now()
    // Pages can call window.open in a loop; do not flood the system browser.
    if (now - this.lastExternalOpen < BROWSER_EXTERNAL_OPEN_INTERVAL_MS) return
    this.lastExternalOpen = now
    shell.openExternal(url).catch(() => {
      // The system browser refused; nothing to report back to the page.
    })
  }

  private liveContents(): WebContents | null {
    const contents = this.view?.webContents
    return contents && !contents.isDestroyed() ? contents : null
  }

  private emitState(
    view: WebContentsView,
    extra: { error?: string } = {},
  ): void {
    if (view !== this.view || this.window.isDestroyed()) return
    const contents = view.webContents
    if (contents.isDestroyed() || this.window.webContents.isDestroyed()) return
    const history = contents.navigationHistory
    const state: BrowserViewState = {
      url: contents.getURL() || this.pendingUrl,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      ...extra,
    }
    this.window.webContents.send(BROWSER_STATE_CHANNEL, state)
  }
}

function hardenSession(session: Session): void {
  if (hardenedSessions.has(session)) return
  hardenedSessions.add(session)
  session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.on('will-download', (event) => event.preventDefault())
}

async function clearBrowsingData(session: Session): Promise<void> {
  await Promise.allSettled([session.clearStorageData(), session.clearCache()])
}
