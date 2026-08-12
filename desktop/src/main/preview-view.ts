import { shell, WebContentsView, type BrowserWindow } from 'electron'
import type { CoreApi } from '@emperor/core/api'
import {
  normalizedPreviewBounds,
  previewExternalNavigationEligible,
  previewNavigationAllowed,
} from './preview-view-policy'
import { PREVIEW_STATE_CHANNEL } from '../shared/ipc-contract'

interface ActivePreview {
  sessionId: string
  previewId: string
  ownedUrl: string
  view: WebContentsView
}

export class PreviewViewHost {
  private active: ActivePreview | null = null

  constructor(
    private readonly window: BrowserWindow,
    private readonly core: CoreApi,
  ) {}

  async open(input: {
    sessionId: string
    previewId: string
  }): Promise<{ ok: true }> {
    const sessionId = required(input.sessionId)
    const previewId = required(input.previewId)
    const preview = this.resolveReadyPreview(sessionId, previewId)
    this.close()
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `emperor-preview-${safePartition(sessionId)}`,
      },
    })
    const active: ActivePreview = {
      sessionId,
      previewId,
      ownedUrl: preview.url,
      view,
    }
    this.active = active
    this.window.contentView.addChildView(view)
    view.webContents.session.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    )
    view.webContents.session.on('will-download', (event) =>
      event.preventDefault(),
    )
    view.webContents.on('will-navigate', (event, target) => {
      if (!previewNavigationAllowed(target, active.ownedUrl)) {
        event.preventDefault()
        if (previewExternalNavigationEligible(target))
          void shell.openExternal(target)
      }
    })
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (previewExternalNavigationEligible(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    const emit = () => this.emitState()
    view.webContents.on('did-start-loading', emit)
    view.webContents.on('did-stop-loading', emit)
    view.webContents.on('did-navigate', emit)
    view.webContents.on('did-navigate-in-page', emit)
    view.webContents.on('did-fail-load', (_event, code, description) =>
      this.emitState({ error: `${code}: ${description}` }),
    )
    await view.webContents.loadURL(preview.url)
    this.emitState()
    return { ok: true }
  }

  async openExternal(input: {
    sessionId: string
    previewId: string
  }): Promise<{ ok: true }> {
    const preview = this.resolveReadyPreview(
      required(input.sessionId),
      required(input.previewId),
    )
    await shell.openExternal(preview.url)
    return { ok: true }
  }

  setBounds(value: unknown): void {
    const bounds = normalizedPreviewBounds(value)
    if (bounds && this.active) this.active.view.setBounds(bounds)
  }

  action(action: string): void {
    const active = this.active
    if (!active) return
    try {
      this.resolveReadyPreview(active.sessionId, active.previewId)
    } catch {
      this.emitState({ error: '本地预览已停止或不可用。' })
      this.close()
      return
    }
    const contents = active.view.webContents
    if (!contents) return
    if (action === 'back' && contents.canGoBack()) contents.goBack()
    else if (action === 'forward' && contents.canGoForward())
      contents.goForward()
    else if (action === 'reload') contents.reload()
  }

  close(): void {
    const active = this.active
    this.active = null
    if (!active) return
    try {
      this.window.contentView.removeChildView(active.view)
    } catch {
      // Shutdown may have already detached the child view from the window.
    }
    if (!active.view.webContents.isDestroyed()) active.view.webContents.close()
  }

  private emitState(extra: { error?: string } = {}): void {
    const active = this.active
    if (!active || this.window.isDestroyed()) return
    const contents = active.view.webContents
    this.window.webContents.send(PREVIEW_STATE_CHANNEL, {
      sessionId: active.sessionId,
      previewId: active.previewId,
      url: contents.getURL() || active.ownedUrl,
      loading: contents.isLoading(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
      ...extra,
    })
  }

  private resolveReadyPreview(sessionId: string, previewId: string) {
    return this.core.projectProcesses.authorizePreview({
      sessionId,
      previewId,
    })
  }
}

function required(value: unknown): string {
  const result = typeof value === 'string' ? value.trim() : ''
  if (!result || result.length > 256)
    throw new Error('invalid preview identity')
  return result
}

function safePartition(value: string): string {
  return Buffer.from(value).toString('hex').slice(0, 96)
}
