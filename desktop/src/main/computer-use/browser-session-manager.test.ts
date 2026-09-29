import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  DriverEvent,
  NavigationRequest,
} from '@emperor/core/host-capabilities'
import type { Session, WebContents, WebPreferences } from 'electron'
import {
  AGENT_FRAME_RATES,
  BrowserSessionManager,
  permissionKinds,
  type ElectronFactory,
  type HostLike,
  type ViewLike,
} from './browser-session-manager'
import { ProfileDeletionQueue } from './profile-deletions'

type Listener = (...args: any[]) => unknown

class Emitter {
  readonly listeners = new Map<string, Listener[]>()
  on(name: string, listener: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
    return this
  }
  emit(name: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(name) ?? []) listener(...args)
  }
}

class FakeSession extends Emitter {
  beforeRequest: Listener | null = null
  readonly webRequest = {
    onBeforeRequest: (listener: Listener) => {
      this.beforeRequest = listener
    },
  }
  setPermissionRequestHandler = vi.fn()
  setPermissionCheckHandler = vi.fn()
  setDevicePermissionHandler = vi.fn()
  clearStorageData = vi.fn(async () => undefined)
  clearCache = vi.fn(async () => undefined)
}

let nextId = 1
class FakeContents extends Emitter {
  readonly id = nextId++
  destroyed = false
  frameRate = 0
  openHandler: Listener | null = null
  loadImpl: (url: string) => Promise<void> = async () => undefined
  loaded: string[] = []
  entries: string[] = []
  active = -1
  constructor(readonly session: FakeSession) {
    super()
  }
  readonly navigationHistory = {
    getActiveIndex: () => this.active,
    length: () => this.entries.length,
    getEntryAtIndex: (index: number) => ({
      url: this.entries[index]!,
      title: '',
    }),
    goBack: vi.fn(),
    goForward: vi.fn(),
  }
  setWindowOpenHandler(handler: Listener): void {
    this.openHandler = handler
  }
  async loadURL(url: string): Promise<void> {
    this.loaded.push(url)
    await this.loadImpl(url)
  }
  setFrameRate(fps: number): void {
    this.frameRate = fps
  }
  reload = vi.fn()
  stop = vi.fn()
  close(): void {
    this.destroyed = true
  }
  isDestroyed(): boolean {
    return this.destroyed
  }
}

function setup(
  verdict: (request: NavigationRequest) => 'allow' | 'block' = () => 'allow',
  loadImpl?: (url: string) => Promise<void>,
  options?: {
    profilesRoot?: string
    deletions?: Pick<ProfileDeletionQueue, 'mark' | 'reconcile'>
  },
) {
  const sessions = new Map<string, FakeSession>()
  const hosts: Array<HostLike & { children: ViewLike[]; destroyed: boolean }> =
    []
  const views: Array<ViewLike & { prefs: WebPreferences }> = []
  const events: DriverEvent[] = []
  let now = 1_000
  const electron: ElectronFactory = {
    createHost: () => {
      const host = {
        children: [] as ViewLike[],
        destroyed: false,
        contentView: {
          addChildView: (view: ViewLike) => host.children.push(view),
          removeChildView: (view: ViewLike) => {
            host.children = host.children.filter((item) => item !== view)
          },
        },
        destroy: () => {
          host.destroyed = true
        },
        isDestroyed: () => host.destroyed,
      }
      hosts.push(host)
      return host
    },
    createView: (prefs) => {
      const partition = String(prefs.partition)
      const session =
        (prefs.session as unknown as FakeSession | undefined) ??
        sessions.get(partition) ??
        new FakeSession()
      if (prefs.session === undefined) sessions.set(partition, session)
      const contents = new FakeContents(session)
      if (loadImpl !== undefined) contents.loadImpl = loadImpl
      const view = {
        prefs,
        webContents: contents as unknown as WebContents,
        setBounds: vi.fn(),
      }
      views.push(view)
      return view
    },
    sessionFromPartition: (partition) => {
      const session = sessions.get(partition) ?? new FakeSession()
      sessions.set(partition, session)
      return session as unknown as Session
    },
    sessionFromPath: (path) => {
      const session = sessions.get(`path:${path}`) ?? new FakeSession()
      sessions.set(`path:${path}`, session)
      return session as unknown as Session
    },
  }
  const policy = vi.fn(verdict)
  const removed: string[] = []
  const popups: Array<{ opener: string; popup: string; partition: string }> = []
  const allowed = new Set<string>()
  const permission = vi.fn(
    (request: { targetId: string; origin: string; kind: string }) =>
      allowed.has(`${request.origin}|${request.kind}`),
  )
  const manager = new BrowserSessionManager({
    sitePermission: () => permission,
    onPopup: (opener, popup) =>
      popups.push({
        opener: opener.targetId,
        popup: popup.targetId,
        partition: popup.partition,
      }),
    electron,
    policy: () => policy,
    emit: (event) => events.push(event),
    profilesRoot: options?.profilesRoot ?? '/home/.emperor/browser/profiles',
    deletions: options?.deletions ?? {
      mark: async () => undefined,
      reconcile: async () => undefined,
    },
    removeDirectory: async (path) => {
      removed.push(path)
    },
    now: () => now,
  })
  return {
    manager,
    removed,
    popups,
    allowed,
    permission,
    hosts,
    views,
    events,
    policy,
    sessions,
    advance(ms: number) {
      now += ms
    },
  }
}

const fake = (contents: WebContents) => contents as unknown as FakeContents
const navigationEvent = (url: string) => ({ url, preventDefault: vi.fn() })

describe('BrowserSessionManager', () => {
  it('opens an offscreen tab in a hidden host and destroys the host with the last tab', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    expect(tab.targetId).toMatch(/^tab_[0-9a-f-]{36}$/)
    expect(k.views[0]!.prefs).toMatchObject({
      offscreen: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      partition: expect.stringMatching(/^emperor-task-/),
    })
    expect(JSON.stringify(k.views[0]!.prefs)).not.toContain('preload')
    expect(k.hosts).toHaveLength(1)
    expect(k.hosts[0]!.children).toHaveLength(1)
    expect(fake(tab.contents).loaded).toEqual(['https://example.com/'])
    expect(fake(tab.contents).frameRate).toBe(AGENT_FRAME_RATES.active)
    const session = k.sessions.get(tab.partition)!
    expect(session.setPermissionRequestHandler).toHaveBeenCalledTimes(1)

    await k.manager.close(tab.targetId)
    expect(fake(tab.contents).destroyed).toBe(true)
    expect(session.clearStorageData).toHaveBeenCalled()
    expect(k.hosts[0]!.destroyed).toBe(true)
    expect(k.manager.hasHost).toBe(false)
    expect(k.manager.get(tab.targetId)).toBeUndefined()
  })

  it('gives each temporary tab its own partition', async () => {
    const k = setup()
    const a = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://a.test/',
    })
    const b = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://b.test/',
    })
    expect(a.partition).not.toBe(b.partition)
    expect(k.hosts).toHaveLength(1)
    expect(k.hosts[0]!.children).toHaveLength(2)
  })

  it('refuses a blocked or non-web first load before creating anything', async () => {
    const k = setup((request) =>
      request.url.includes('evil') ? 'block' : 'allow',
    )
    await expect(
      k.manager.open({ ownerSessionId: 's1', url: 'https://evil.test/' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' })
    await expect(
      k.manager.open({ ownerSessionId: 's1', url: 'file:///etc/passwd' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_REQUIRED' })
    expect(k.views).toHaveLength(0)
    expect(k.policy).toHaveBeenCalledWith(
      expect.objectContaining({ initiator: 'agent', ownerSessionId: 's1' }),
    )
  })

  it('guards page navigations, redirects and frames', async () => {
    const k = setup((request) =>
      request.url.includes('evil') ? 'block' : 'allow',
    )
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    const contents = fake(tab.contents)
    const ok = navigationEvent('https://example.com/next')
    contents.emit('will-navigate', ok)
    expect(ok.preventDefault).not.toHaveBeenCalled()
    const bad = navigationEvent('https://evil.test/steal')
    contents.emit('will-navigate', bad)
    expect(bad.preventDefault).toHaveBeenCalled()
    expect(k.events).toContainEqual({
      type: 'navigation-blocked',
      targetId: tab.targetId,
      url: 'https://evil.test/steal',
    })
    const redirect = {
      ...navigationEvent('https://evil.test/'),
      isMainFrame: true,
    }
    contents.emit('will-redirect', redirect)
    expect(redirect.preventDefault).toHaveBeenCalled()
    const frame = {
      ...navigationEvent('file:///etc/hosts'),
      isMainFrame: false,
    }
    contents.emit('will-frame-navigate', frame)
    expect(frame.preventDefault).toHaveBeenCalled()
    const webFrame = {
      ...navigationEvent('https://evil.test/embed'),
      isMainFrame: false,
    }
    contents.emit('will-frame-navigate', webFrame)
    expect(webFrame.preventDefault).not.toHaveBeenCalled()
    expect(k.policy).toHaveBeenCalledWith(
      expect.objectContaining({
        initiator: 'page',
        url: 'https://evil.test/steal',
      }),
    )
  })

  it('filters main-frame and sub-frame requests (redirects included)', async () => {
    const k = setup((request) =>
      request.url.includes('evil') ? 'block' : 'allow',
    )
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    const session = k.sessions.get(tab.partition)!
    const ask = (
      resourceType: string,
      url: string,
      webContentsId = tab.contents.id,
    ) => {
      const callback = vi.fn()
      session.beforeRequest!({ resourceType, url, webContentsId }, callback)
      return callback.mock.calls[0]![0]
    }
    expect(ask('mainFrame', 'https://example.com/a')).toEqual({})
    expect(ask('mainFrame', 'https://evil.test/')).toEqual({ cancel: true })
    expect(ask('subFrame', 'file:///etc/hosts')).toEqual({ cancel: true })
    expect(ask('subFrame', 'https://evil.test/embed')).toEqual({})
    expect(ask('image', 'https://evil.test/pixel.gif')).toEqual({})
    expect(ask('mainFrame', 'https://example.com/', 99_999)).toEqual({
      cancel: true,
    })
  })

  it('tracks commits: cross-document bumps generation, same-document bumps revision', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    const contents = fake(tab.contents)
    contents.emit('did-navigate', {}, 'https://example.com/')
    expect(tab).toMatchObject({
      generation: 2,
      revision: 1,
      pendingAgentUrl: null,
    })
    contents.emit('did-navigate-in-page', {}, 'https://example.com/#a', true)
    expect(tab).toMatchObject({ generation: 2, revision: 2 })
    contents.emit('did-navigate-in-page', {}, 'https://ads.test/#x', false)
    expect(tab.revision).toBe(2)
    contents.emit('page-title-updated', {}, 'Example')
    expect(k.events.map((event) => event.type)).toEqual([
      'navigated',
      'navigated',
      'title',
    ])
    expect(k.events[1]).toMatchObject({ sameDocument: true })
  })

  it('closes a tab whose committed URL is not web content (fail closed)', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    fake(tab.contents).emit('did-navigate', {}, 'file:///etc/passwd')
    expect(k.events.at(-1)).toMatchObject({
      type: 'lost',
      targetId: tab.targetId,
    })
    await Promise.resolve()
    expect(k.manager.get(tab.targetId)).toBeUndefined()
  })

  it('opens an allowed popup as a tab sharing the opener partition', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    expect(
      fake(tab.contents).openHandler!({ url: 'https://example.com/popup' }),
    ).toEqual({
      action: 'deny',
    })
    await vi.waitFor(() => expect(k.popups).toHaveLength(1))
    expect(k.popups[0]).toMatchObject({
      opener: tab.targetId,
      partition: tab.partition,
    })
    expect(k.policy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/popup',
        initiator: 'page',
      }),
    )
    const popup = k.manager.get(k.popups[0]!.popup)!
    expect(fake(popup.contents).loaded).toEqual(['https://example.com/popup'])
    // Closing the opener keeps the shared temporary storage for the popup.
    await k.manager.close(tab.targetId)
    expect(
      k.sessions.get(tab.partition)!.clearStorageData,
    ).not.toHaveBeenCalled()
    await k.manager.close(popup.targetId)
    expect(
      k.sessions.get(tab.partition)!.clearStorageData,
    ).toHaveBeenCalledTimes(1)
  })

  it('blocks popups the kernel refuses and reports renderer crashes as lost', async () => {
    const k = setup((request) =>
      request.initiator === 'page' ? 'block' : 'allow',
    )
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    const contents = fake(tab.contents)
    expect(contents.openHandler!({ url: 'https://example.com/popup' })).toEqual(
      {
        action: 'deny',
      },
    )
    expect(k.events).toContainEqual({
      type: 'popup-blocked',
      targetId: tab.targetId,
      url: 'https://example.com/popup',
    })
    expect(k.popups).toEqual([])
    contents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(k.events.at(-1)).toMatchObject({
      type: 'lost',
      reason: 'render-process-gone: crashed',
    })
  })

  it('checks history destinations before moving', async () => {
    const k = setup((request) =>
      request.url.includes('evil') ? 'block' : 'allow',
    )
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    const contents = fake(tab.contents)
    contents.entries = [
      'https://evil.test/',
      'https://example.com/',
      'https://example.com/next',
    ]
    contents.active = 1
    expect(k.manager.historyTarget(tab.targetId, 'back')).toBe(
      'https://evil.test/',
    )
    expect(k.manager.historyTarget(tab.targetId, 'forward')).toBe(
      'https://example.com/next',
    )
    await expect(k.manager.history(tab.targetId, 'back')).rejects.toMatchObject(
      {
        code: 'PERMISSION_REQUIRED',
      },
    )
    expect(contents.navigationHistory.goBack).not.toHaveBeenCalled()
    expect(await k.manager.history(tab.targetId, 'forward')).toBe(true)
    expect(contents.navigationHistory.goForward).toHaveBeenCalled()
    contents.active = 2
    expect(await k.manager.history(tab.targetId, 'forward')).toBe(false)
  })

  it('sets frame rates for idle, active and preview', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://example.com/',
    })
    const contents = fake(tab.contents)
    expect(contents.frameRate).toBe(AGENT_FRAME_RATES.active)
    k.advance(5_000)
    k.manager.settleFrameRates()
    expect(contents.frameRate).toBe(AGENT_FRAME_RATES.idle)
    k.manager.setPreviewing(tab.targetId, true)
    expect(contents.frameRate).toBe(AGENT_FRAME_RATES.preview)
    k.manager.setPreviewing(tab.targetId, false)
    k.manager.touch(tab.targetId)
    expect(contents.frameRate).toBe(AGENT_FRAME_RATES.active)
  })

  it('keeps a failed load open on its error page', async () => {
    const k = setup(undefined, async () => {
      throw new Error('ERR_NAME_NOT_RESOLVED')
    })
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://down.test/',
    })
    expect(tab.closed).toBe(false)
    expect(tab.lastError).toBe('ERR_NAME_NOT_RESOLVED')
    expect(k.manager.get(tab.targetId)).toBe(tab)
  })

  it('maps Electron permission names to the kinds a user can allow', () => {
    expect(permissionKinds('media', ['video', 'audio'])).toEqual([
      'camera',
      'microphone',
    ])
    expect(permissionKinds('media', [])).toBeNull()
    expect(permissionKinds('clipboard-sanitized-write', [])).toEqual([
      'clipboard-write',
    ])
    expect(permissionKinds('geolocation', [])).toEqual(['geolocation'])
    for (const denied of [
      'midi',
      'openExternal',
      'fileSystem',
      'display-capture',
      'unknown',
    ])
      expect(permissionKinds(denied, [])).toBeNull()
  })

  it('asks the kernel for site permissions of its own tabs only', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://meet.test/',
    })
    const session = k.sessions.get(tab.partition)!
    const request = session.setPermissionRequestHandler.mock.calls[0]![0] as (
      contents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
      details: Record<string, unknown>,
    ) => void
    const check = session.setPermissionCheckHandler.mock.calls[0]![0] as (
      contents: unknown,
      permission: string,
      origin: string,
      details: Record<string, unknown>,
    ) => boolean
    const ask = (
      permission: string,
      details: Record<string, unknown>,
      contents: unknown = tab.contents,
    ) =>
      new Promise<boolean>((resolve) =>
        request(contents, permission, resolve, details),
      )
    k.allowed.add('https://meet.test|camera')
    await expect(
      ask('media', {
        requestingUrl: 'https://meet.test/room',
        mediaTypes: ['video'],
      }),
    ).resolves.toBe(true)
    await expect(
      ask('media', {
        requestingUrl: 'https://meet.test/room',
        mediaTypes: ['video', 'audio'],
      }),
    ).resolves.toBe(false)
    await expect(
      ask('midi', { requestingUrl: 'https://meet.test/' }),
    ).resolves.toBe(false)
    await expect(
      ask(
        'media',
        { requestingUrl: 'https://meet.test/', mediaTypes: ['video'] },
        { id: -1 },
      ),
    ).resolves.toBe(false)
    expect(
      check(tab.contents, 'media', 'https://meet.test', { mediaType: 'video' }),
    ).toBe(true)
    expect(check(tab.contents, 'geolocation', 'https://meet.test', {})).toBe(
      false,
    )
    expect(k.permission).toHaveBeenCalledWith({
      targetId: tab.targetId,
      origin: 'https://meet.test',
      kind: 'camera',
    })
  })

  it('opens persistent profiles from their directory and keeps them on close', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://a.test/',
      profileId: 'p_0123456789ab',
    })
    const session = k.sessions.get(
      'path:/home/.emperor/browser/profiles/p_0123456789ab',
    )!
    expect(k.views[0]!.prefs.session).toBe(session)
    expect(k.views[0]!.prefs.partition).toBeUndefined()
    expect(tab.partition).toBe('profile:p_0123456789ab')
    expect(k.policy).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'p_0123456789ab',
        initiator: 'agent',
      }),
    )
    await k.manager.close(tab.targetId)
    expect(session.clearStorageData).not.toHaveBeenCalled()
    await expect(
      k.manager.open({
        ownerSessionId: 's1',
        url: 'https://a.test/',
        profileId: '../../etc',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
  })

  it('clears a profile (tabs closed, storage wiped) and deletes its directory', async () => {
    const k = setup()
    const tab = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://a.test/',
      profileId: 'p_0123456789ab',
    })
    await k.manager.clearProfile('p_0123456789ab', { remove: false })
    expect(tab.closed).toBe(true)
    const session = k.sessions.get(
      'path:/home/.emperor/browser/profiles/p_0123456789ab',
    )!
    expect(session.clearStorageData).toHaveBeenCalledTimes(1)
    expect(session.clearCache).toHaveBeenCalledTimes(1)
    expect(k.removed).toEqual([])
    await k.manager.clearProfile('p_0123456789ab', { remove: true })
    expect(k.removed).toEqual([
      '/home/.emperor/browser/profiles/p_0123456789ab',
    ])
  })

  it('sweeps a deleted profile when the next manager starts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'emperor-profile-restart-'))
    const id = 'p_0123456789ab'
    const first = setup(undefined, undefined, {
      profilesRoot: root,
      deletions: new ProfileDeletionQueue(root),
    })
    await first.manager.open({
      ownerSessionId: 's1',
      url: 'https://a.test/',
      profileId: id,
    })
    await first.manager.clearProfile(id, { remove: true })
    expect(existsSync(join(root, `.delete-${id}`))).toBe(true)

    // Chromium writes a new cache after the deletion request, at shutdown.
    mkdirSync(join(root, id, 'Cache'), { recursive: true })
    writeFileSync(join(root, id, 'Cache', 'remaining'), 'cache')
    const restarted = setup(undefined, undefined, {
      profilesRoot: root,
      deletions: new ProfileDeletionQueue(root),
    })
    await restarted.manager.open({
      ownerSessionId: 's1',
      url: 'https://b.test/',
      profileId: 'p_aaaaaaaaaaaa',
    })
    expect(existsSync(join(root, id))).toBe(false)
    expect(existsSync(join(root, `.delete-${id}`))).toBe(false)
  })

  it('closes every tab and the host with the main window, then reopens on demand', async () => {
    const k = setup()
    await k.manager.open({ ownerSessionId: 's1', url: 'https://a.test/' })
    await k.manager.closeAll()
    expect(k.manager.size).toBe(0)
    expect(k.hosts.every((host) => host.destroyed)).toBe(true)
    const again = await k.manager.open({
      ownerSessionId: 's1',
      url: 'https://b.test/',
    })
    expect(again.closed).toBe(false)
    expect(k.hosts).toHaveLength(2)
  })

  it('shuts down every tab and the host, then refuses new tabs', async () => {
    const k = setup()
    await k.manager.open({ ownerSessionId: 's1', url: 'https://a.test/' })
    await k.manager.open({ ownerSessionId: 's2', url: 'https://b.test/' })
    await k.manager.shutdown()
    expect(k.manager.size).toBe(0)
    expect(k.hosts.every((host) => host.destroyed)).toBe(true)
    await expect(
      k.manager.open({ ownerSessionId: 's1', url: 'https://a.test/' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' })
  })
})
