import {
  session as electronSession,
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
import { subframeNavigationAllowed } from './computer-use/agent-navigation-policy'
import { hardenSession } from './computer-use/session-hardening'
import {
  UserBrowserHistory,
  type UserBrowserHistoryEntry,
} from './user-browser-history'
import {
  BROWSER_STATE_CHANNEL,
  type BrowserClearResult,
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

/**
 * Clearing the browsing data (plan 5): `closing` stops and destroys the view,
 * `clearing` waits for the partition wipe; then `idle`, or `failed` with the
 * reason. No page opens and no second clearing starts meanwhile.
 */
export type BrowserClearState = 'idle' | 'closing' | 'clearing' | 'failed'

export interface BrowserViewHostOptions {
  /** 设置 › 浏览器 › 临时历史 (default on). */
  historyEnabled?: () => boolean | Promise<boolean>
}

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
  private readonly visited: UserBrowserHistory
  private readonly historyEnabled: () => boolean | Promise<boolean>
  private clearRun: Promise<BrowserClearResult> | null = null
  private clearStateValue: BrowserClearState = 'idle'
  private readonly clearListeners = new Set<
    (state: BrowserClearState) => void
  >()

  constructor(
    private readonly window: BrowserWindow,
    private readonly now: () => number = Date.now,
    options: BrowserViewHostOptions = {},
  ) {
    this.visited = new UserBrowserHistory({ now })
    this.historyEnabled = options.historyEnabled ?? (() => true)
  }

  get clearState(): BrowserClearState {
    return this.clearStateValue
  }

  /** Follow the clearing state; returns an unsubscribe. */
  onClearState(listener: (state: BrowserClearState) => void): () => void {
    this.clearListeners.add(listener)
    return () => this.clearListeners.delete(listener)
  }

  async openUrl(input: { url: string }): Promise<{ ok: true; url: string }> {
    const url = typeof input?.url === 'string' ? input.url : ''
    if (!browserNavigationAllowed(url)) throw new Error('invalid browser url')
    if (this.clearRun) throw new Error('browser data is being cleared')
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

  /**
   * Place the view; null or a rectangle too small for a page hides it. A
   * pane that just appeared (for a link main opened before it mounted) gets
   * the current page state.
   */
  setBounds(value: unknown): void {
    const hidden = this.bounds === null
    this.bounds = normalizedBrowserBounds(value)
    this.applyBounds()
    if (hidden && this.bounds !== null && this.view) this.emitState(this.view)
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
    this.visited.clear()
    const view = this.detachView()
    if (!view) return
    const session = view.webContents.session
    view.webContents.close()
    this.clearing = clearBrowsingData(session)
  }

  /** The temporary history, newest first (empty while it is turned off). */
  async history(): Promise<UserBrowserHistoryEntry[]> {
    if (!(await this.historyEnabled())) {
      this.visited.clear()
      return []
    }
    return this.visited.list()
  }

  /** Reopen a history entry; its address is checked again like a typed one. */
  async openHistory(id: string): Promise<{ ok: true; url: string }> {
    if (this.clearRun) throw new Error('browser data is being cleared')
    const entry = this.visited.find(typeof id === 'string' ? id : '')
    if (entry === undefined) throw new Error('unknown history entry')
    return await this.openUrl({ url: entry.url })
  }

  /**
   * Clear the temporary browsing data of this browser's partition only:
   * stop and destroy the view, forget the history, then wipe storage,
   * cookies, cache and HTTP auth. A call while one runs joins it.
   */
  clearData(): Promise<BrowserClearResult> {
    this.clearRun ??= this.runClear().finally(() => {
      this.clearRun = null
    })
    return this.clearRun
  }

  private async runClear(): Promise<BrowserClearResult> {
    this.setClearState('closing')
    this.visited.clear()
    const view = this.detachView()
    let session: Session | null = null
    if (view) {
      session = view.webContents.session
      view.webContents.stop()
      view.webContents.close()
    }
    // A close just before may still be wiping.
    await this.clearing.catch(() => undefined)
    this.setClearState('clearing')
    try {
      await wipe(session ?? electronSession.fromPartition(BROWSER_PARTITION))
      this.setClearState('idle')
      return { ok: true }
    } catch (error) {
      this.setClearState('failed')
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  private setClearState(state: BrowserClearState): void {
    this.clearStateValue = state
    for (const listener of this.clearListeners) listener(state)
  }

  /** Take the view out of the window; returns it when it is still alive. */
  private detachView(): WebContentsView | null {
    const view = this.view
    this.view = null
    this.pendingUrl = ''
    if (!view) return null
    try {
      this.window.contentView.removeChildView(view)
    } catch {
      // Shutdown may have already detached the child view from the window.
    }
    return view.webContents.isDestroyed() ? null : view
  }

  /** A committed main-frame page of this view (temporary history). */
  private remember(view: WebContentsView): void {
    if (view !== this.view) return
    const contents = view.webContents
    if (contents.isDestroyed()) return
    const url = contents.getURL()
    const title = contents.getTitle()
    const enabled = this.historyEnabled()
    if (enabled === true) this.visited.record(url, title)
    else if (enabled !== false)
      void enabled.then((on) => {
        if (!on || view !== this.view) return
        // The page may have reported its title while the setting was read.
        const still = !contents.isDestroyed() && contents.getURL() === url
        this.visited.record(url, still ? contents.getTitle() : title)
      })
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
    // Sub-frames never reach local files or browser-internal pages.
    contents.on('will-frame-navigate', (details) => {
      if (!details.isMainFrame && !subframeNavigationAllowed(details.url))
        details.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    // Electron would otherwise answer with the first client certificate.
    contents.on('select-client-certificate', (event, _url, _list, callback) => {
      event.preventDefault()
      ;(callback as (certificate?: Certificate) => void)()
    })
    const emit = () => this.emitState(view)
    contents.on('did-start-loading', emit)
    contents.on('did-stop-loading', emit)
    contents.on('did-navigate', () => {
      this.remember(view)
      emit()
    })
    contents.on(
      'did-navigate-in-page',
      (_event: unknown, _url: unknown, isMainFrame?: boolean) => {
        if (isMainFrame !== false) this.remember(view)
        emit()
      },
    )
    contents.on('page-title-updated', () => {
      if (view === this.view && !contents.isDestroyed())
        this.visited.retitle(contents.getURL(), contents.getTitle())
      emit()
    })
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

async function clearBrowsingData(session: Session): Promise<void> {
  await Promise.allSettled([session.clearStorageData(), session.clearCache()])
}

/** Every kind of stored browsing data; fails when any part fails. */
async function wipe(session: Session): Promise<void> {
  await Promise.all([
    session.clearStorageData(),
    session.clearCache(),
    session.clearAuthCache(),
  ])
}
