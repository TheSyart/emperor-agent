import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { BROWSER_STATE_CHANNEL } from '../shared/ipc-contract'

type Listener = (...args: any[]) => unknown

const electron = vi.hoisted(() => {
  class FakeEmitter {
    readonly listeners = new Map<string, Listener[]>()

    on(name: string, listener: Listener): this {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
      return this
    }

    emit(name: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(name) ?? []) listener(...args)
    }

    count(name: string): number {
      return this.listeners.get(name)?.length ?? 0
    }
  }

  class FakeSession extends FakeEmitter {
    setPermissionRequestHandler = vi.fn()
    setPermissionCheckHandler = vi.fn()
    setDevicePermissionHandler = vi.fn()
    clearStorageData = vi.fn(async () => undefined)
    clearCache = vi.fn(async () => undefined)
  }

  class FakeWebContents extends FakeEmitter {
    url = ''
    title = ''
    loading = false
    destroyed = false
    windowOpenHandler: Listener | null = null
    readonly navigationHistory = {
      canGoBack: vi.fn(() => false),
      canGoForward: vi.fn(() => false),
      goBack: vi.fn(),
      goForward: vi.fn(),
    }
    loadURL = vi.fn(async (url: string) => {
      this.url = url
    })
    reload = vi.fn()
    stop = vi.fn()
    send = vi.fn()
    close = vi.fn(() => {
      this.destroyed = true
    })
    setWindowOpenHandler = vi.fn((handler: Listener) => {
      this.windowOpenHandler = handler
    })

    constructor(readonly session: FakeSession | null = null) {
      super()
    }

    getURL(): string {
      return this.url
    }

    getTitle(): string {
      return this.title
    }

    isLoading(): boolean {
      return this.loading
    }

    isDestroyed(): boolean {
      return this.destroyed
    }
  }

  const sessions = new Map<string, FakeSession>()
  const views: FakeWebContentsView[] = []

  class FakeWebContentsView {
    readonly webContents: FakeWebContents
    setBounds = vi.fn()
    setVisible = vi.fn()

    constructor(
      readonly options: { webPreferences: { partition: string } } & Record<
        string,
        any
      >,
    ) {
      const partition = options.webPreferences.partition
      let session = sessions.get(partition)
      if (!session) {
        session = new FakeSession()
        sessions.set(partition, session)
      }
      this.webContents = new FakeWebContents(session)
      views.push(this)
    }
  }

  return {
    FakeWebContents,
    FakeWebContentsView,
    sessions,
    views,
    shell: { openExternal: vi.fn(async () => undefined) },
  }
})

vi.mock('electron', () => ({
  shell: electron.shell,
  WebContentsView: electron.FakeWebContentsView,
}))

import {
  BROWSER_EXTERNAL_OPEN_INTERVAL_MS,
  BROWSER_PARTITION,
  BrowserViewHost,
  browserViewWebPreferences,
} from './browser-view'

type FakeView = InstanceType<typeof electron.FakeWebContentsView>

function fakeWindow() {
  const webContents = new electron.FakeWebContents()
  const window = {
    destroyed: false,
    webContents,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    isDestroyed() {
      return this.destroyed
    },
  }
  return window
}

function setup(now: () => number = () => 0) {
  const window = fakeWindow()
  const host = new BrowserViewHost(window as unknown as BrowserWindow, now)
  return { window, host }
}

function onlyView(): FakeView {
  expect(electron.views).toHaveLength(1)
  return electron.views[0]!
}

function navigationEvent(url: string) {
  return { url, preventDefault: vi.fn() }
}

beforeEach(() => {
  electron.sessions.clear()
  electron.views.length = 0
  electron.shell.openExternal.mockClear()
})

describe('browser view webPreferences', () => {
  it('sandboxes the page in a memory-only partition without preload', () => {
    const preferences = browserViewWebPreferences()
    expect(preferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    })
    expect(preferences).not.toHaveProperty('preload')
    expect(preferences.partition).toBe(BROWSER_PARTITION)
    expect(preferences.partition).not.toMatch(/^persist:/)
  })
})

describe('BrowserViewHost', () => {
  it('opens a normalized URL in one hardened view and reuses it', async () => {
    const { window, host } = setup()

    await expect(
      host.openUrl({ url: 'http://localhost:5173/' }),
    ).resolves.toEqual({ ok: true, url: 'http://localhost:5173/' })
    const view = onlyView()
    expect(view.options.webPreferences).toEqual(browserViewWebPreferences())
    expect(window.contentView.addChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.loadURL).toHaveBeenCalledWith(
      'http://localhost:5173/',
    )

    await host.openUrl({ url: 'https://example.com/' })
    expect(electron.views).toHaveLength(1)
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith(
      'https://example.com/',
    )
  })

  it('refuses anything but credential-free http(s) without creating a view', async () => {
    const { host } = setup()
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hi',
      'about:blank',
      'https://token@example.com/',
      'localhost:5173',
      '',
    ])
      await expect(host.openUrl({ url })).rejects.toThrow(/browser url/)
    await expect(
      host.openUrl(undefined as unknown as { url: string }),
    ).rejects.toThrow(/browser url/)
    expect(electron.views).toHaveLength(0)
  })

  it('denies every permission and device request and blocks downloads', async () => {
    const { host } = setup()
    await host.openUrl({ url: 'https://example.com/' })
    const session = onlyView().webContents.session!

    const requestHandler = session.setPermissionRequestHandler.mock
      .calls[0]![0] as Listener
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'fullscreen',
      'openExternal',
    ]) {
      const callback = vi.fn()
      requestHandler(null, permission, callback, {})
      expect(callback).toHaveBeenCalledWith(false)
    }
    const checkHandler = session.setPermissionCheckHandler.mock
      .calls[0]![0] as Listener
    expect(
      checkHandler(null, 'clipboard-read', 'https://example.com', {}),
    ).toBe(false)
    const deviceHandler = session.setDevicePermissionHandler.mock
      .calls[0]![0] as Listener
    expect(deviceHandler({ deviceType: 'usb' })).toBe(false)

    const download = { preventDefault: vi.fn() }
    session.emit('will-download', download)
    expect(download.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('hardens the shared partition session only once across reopened views', async () => {
    const { host } = setup()
    await host.openUrl({ url: 'https://example.com/' })
    host.close()
    await host.openUrl({ url: 'https://example.com/' })

    expect(electron.views).toHaveLength(2)
    const session = electron.views[1]!.webContents.session!
    expect(session).toBe(electron.views[0]!.webContents.session)
    expect(session.count('will-download')).toBe(1)
  })

  it('guards in-view navigations, redirects and webviews', async () => {
    const { host } = setup()
    await host.openUrl({ url: 'https://example.com/' })
    const contents = onlyView().webContents

    for (const channel of ['will-navigate', 'will-redirect']) {
      for (const url of [
        'https://example.com/next',
        'http://localhost:5173/',
      ]) {
        const event = navigationEvent(url)
        contents.emit(channel, event, url)
        expect(event.preventDefault).not.toHaveBeenCalled()
      }
      for (const url of [
        'file:///etc/passwd',
        'javascript:alert(1)',
        'chrome://settings',
        'app://bundle/index.html',
        'https://token@example.com/',
        'custom-scheme://launch',
      ]) {
        const event = navigationEvent(url)
        contents.emit(channel, event, url)
        expect(event.preventDefault).toHaveBeenCalledTimes(1)
      }
    }

    // Sub-frames: web and inline documents load; local and internal pages do not.
    for (const [url, allowed] of [
      ['https://ads.example.net/frame', true],
      ['about:blank', true],
      ['about:srcdoc', true],
      ['data:text/html,hi', true],
      ['file:///etc/passwd', false],
      ['chrome://settings', false],
      ['app://bundle/index.html', false],
      ['https://token@example.com/', false],
    ] as const) {
      const event = { ...navigationEvent(url), isMainFrame: false }
      contents.emit('will-frame-navigate', event)
      expect(event.preventDefault, url).toHaveBeenCalledTimes(allowed ? 0 : 1)
    }
    const mainFrame = { ...navigationEvent('file:///x'), isMainFrame: true }
    contents.emit('will-frame-navigate', mainFrame)
    expect(mainFrame.preventDefault).not.toHaveBeenCalled()

    const attach = { preventDefault: vi.fn() }
    contents.emit('will-attach-webview', attach, {}, {})
    expect(attach.preventDefault).toHaveBeenCalledTimes(1)

    const certificate = { preventDefault: vi.fn() }
    const callback = vi.fn()
    contents.emit(
      'select-client-certificate',
      certificate,
      'https://example.com/',
      [{ subjectName: 'me' }],
      callback,
    )
    expect(certificate.preventDefault).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith()
  })

  it('denies every popup and hands remote ones to the system browser, throttled', async () => {
    let now = 10_000
    const { host } = setup(() => now)
    await host.openUrl({ url: 'https://example.com/' })
    const open = (url: string) =>
      onlyView().webContents.windowOpenHandler!({ url })

    expect(open('http://localhost:5173/')).toEqual({ action: 'deny' })
    expect(open('http://127.0.0.1:5173/')).toEqual({ action: 'deny' })
    expect(open('file:///etc/passwd')).toEqual({ action: 'deny' })
    expect(open('https://token@example.com/')).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).not.toHaveBeenCalled()

    expect(open('https://example.com/docs')).toEqual({ action: 'deny' })
    expect(open('https://example.com/spam')).toEqual({ action: 'deny' })
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(1)
    expect(electron.shell.openExternal).toHaveBeenCalledWith(
      'https://example.com/docs',
    )

    now += BROWSER_EXTERNAL_OPEN_INTERVAL_MS
    open('https://example.com/later')
    expect(electron.shell.openExternal).toHaveBeenCalledTimes(2)
  })

  it('emits url, title, history and loading state on navigation', async () => {
    const { window, host } = setup()
    await host.openUrl({ url: 'https://example.com/' })
    const contents = onlyView().webContents
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_STATE_CHANNEL,
      {
        url: 'https://example.com/',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    )

    contents.url = 'https://example.com/next'
    contents.title = 'Next'
    contents.loading = true
    contents.navigationHistory.canGoBack.mockReturnValue(true)
    contents.emit('did-navigate')
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_STATE_CHANNEL,
      {
        url: 'https://example.com/next',
        title: 'Next',
        loading: true,
        canGoBack: true,
        canGoForward: false,
      },
    )

    for (const channel of [
      'did-start-loading',
      'did-stop-loading',
      'did-navigate-in-page',
      'page-title-updated',
    ]) {
      window.webContents.send.mockClear()
      contents.emit(channel)
      expect(window.webContents.send).toHaveBeenCalledTimes(1)
    }

    window.webContents.send.mockClear()
    contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'x', true)
    contents.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'x',
      false,
    )
    expect(window.webContents.send).not.toHaveBeenCalled()
    contents.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'x', true)
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_STATE_CHANNEL,
      expect.objectContaining({ error: 'ERR_NAME_NOT_RESOLVED (-105)' }),
    )
    contents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(window.webContents.send).toHaveBeenLastCalledWith(
      BROWSER_STATE_CHANNEL,
      expect.objectContaining({ error: expect.stringContaining('crashed') }),
    )
  })

  it('keeps the view hidden until the renderer places it', async () => {
    const { host } = setup()
    host.setBounds({ x: 10, y: 20, width: 640, height: 480 })
    await host.openUrl({ url: 'https://example.com/' })
    const view = onlyView()
    expect(view.setBounds).toHaveBeenLastCalledWith({
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    })
    expect(view.setVisible).toHaveBeenLastCalledWith(true)

    host.setBounds(null)
    expect(view.setVisible).toHaveBeenLastCalledWith(false)
    host.setBounds({ x: 0, y: 0, width: 10, height: 10 })
    expect(view.setVisible).toHaveBeenLastCalledWith(false)

    const hidden = setup()
    await hidden.host.openUrl({ url: 'https://example.com/' })
    expect(electron.views[1]!.setVisible).toHaveBeenLastCalledWith(false)
    expect(electron.views[1]!.setBounds).not.toHaveBeenCalled()
  })

  it('runs history actions on the live view only', async () => {
    const { host } = setup()
    host.action('reload')
    await host.openUrl({ url: 'https://example.com/' })
    const contents = onlyView().webContents

    host.action('back')
    host.action('forward')
    expect(contents.navigationHistory.goBack).not.toHaveBeenCalled()
    expect(contents.navigationHistory.goForward).not.toHaveBeenCalled()
    contents.navigationHistory.canGoBack.mockReturnValue(true)
    contents.navigationHistory.canGoForward.mockReturnValue(true)
    host.action('back')
    host.action('forward')
    host.action('reload')
    host.action('stop')
    host.action('devtools')
    expect(contents.navigationHistory.goBack).toHaveBeenCalledTimes(1)
    expect(contents.navigationHistory.goForward).toHaveBeenCalledTimes(1)
    expect(contents.reload).toHaveBeenCalledTimes(1)
    expect(contents.stop).toHaveBeenCalledTimes(1)
  })

  it('closes the view, wipes the partition and ignores its late events', async () => {
    const { window, host } = setup()
    await host.openUrl({ url: 'https://example.com/' })
    const view = onlyView()
    const session = view.webContents.session!

    host.close()
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(view)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(session.clearStorageData).toHaveBeenCalledTimes(1)
    expect(session.clearCache).toHaveBeenCalledTimes(1)

    window.webContents.send.mockClear()
    view.webContents.destroyed = false
    view.webContents.emit('did-navigate')
    expect(window.webContents.send).not.toHaveBeenCalled()

    host.close()
    expect(session.clearStorageData).toHaveBeenCalledTimes(1)
  })

  it('waits for the previous wipe before opening a new view', async () => {
    const { host } = setup()
    await host.openUrl({ url: 'https://example.com/' })
    const session = onlyView().webContents.session!
    let finishWipe = () => {}
    session.clearStorageData.mockImplementationOnce(
      () =>
        new Promise<undefined>(
          (resolve) => (finishWipe = () => resolve(undefined)),
        ),
    )
    host.close()

    const reopened = host.openUrl({ url: 'https://example.com/again' })
    await Promise.resolve()
    expect(electron.views).toHaveLength(1)
    finishWipe()
    await reopened
    expect(electron.views).toHaveLength(2)
  })

  it('does not open into a destroyed window', async () => {
    const { window, host } = setup()
    window.destroyed = true
    await expect(host.openUrl({ url: 'https://example.com/' })).rejects.toThrow(
      /closed/,
    )
    expect(electron.views).toHaveLength(0)
  })
})
