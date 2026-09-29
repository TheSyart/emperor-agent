// The user's own protected / high-risk / sensitive app lists (spec 01 §4.4,
// §5.2): enforced by the kernel on top of the built-in lists.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeApi } from '../../api/test-helpers'
import { SessionLogStore } from '../../session-log/store'
import { COMPUTER_USE_CONFIG_FILE, ComputerUseConfigStore } from './config'
import { GrantStore } from './grants/store'
import type { UiCallerIdentity } from './identity'
import { computerUseStateDir } from './install'
import { UiActionPolicy } from './policy'
import type {
  ComputerUseHostPort,
  DesktopWindowInfo,
  NativeDesktopDriver,
  TargetSnapshot,
} from './port'
import { defaultHighImpactClassifier } from './risk'
import {
  ComputerUseService,
  type AppListKind,
  type OpContext,
} from './service/service'
import { TINY_PNG } from './testing/fake-browser-driver'
import { FakeComputerUsePort } from './testing/fake-port'
import { GUI_TOOL_CATALOG } from './tools/catalog'

const windows: DesktopWindowInfo[] = [
  {
    windowRef: 'w-bank',
    appId: 'com.example.Bank',
    appName: 'Bank',
    pid: 11,
    title: 'Accounts',
    minimized: false,
    main: true,
  },
  {
    windowRef: 'w-notes',
    appId: 'com.example.Notes',
    appName: 'Notes',
    pid: 12,
    title: 'Diary',
    minimized: false,
    main: true,
  },
  {
    windowRef: 'w-shell',
    appId: 'com.example.Shell',
    appName: 'Shell',
    pid: 13,
    title: 'zsh',
    minimized: false,
    main: true,
  },
]

function setup(lists: Partial<Record<AppListKind, readonly string[]>>) {
  const store = new SessionLogStore({ root: '/tmp/unused', persist: false })
  store.create({ id: 's1' })
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-lists-')), 'computer-use'),
  })
  const snapshots = new Map<string, TargetSnapshot>()
  let observedWithText: boolean | undefined
  const driver = {
    driver: 'desktop',
    capability: () => ({
      driver: 'desktop',
      platform: 'macos',
      stage: 'experimental',
      label: 'Desktop test',
      enabled: true,
      available: true,
      actions: [],
      missing: [],
    }),
    listApps: async () =>
      windows.map((window) => ({
        appId: window.appId,
        name: window.appName,
        pid: window.pid,
        frontmost: false,
        hidden: false,
      })),
    listWindows: async () => windows,
    bind: async ({ windowRef }: { windowRef: string }) => {
      const window = windows.find((item) => item.windowRef === windowRef)!
      const snapshot: TargetSnapshot = {
        targetId: `t-${windowRef}`,
        kind: 'desktop-window',
        driver: 'desktop',
        generation: 1,
        revision: 1,
        url: `app:${window.appId}`,
        title: window.title,
        loading: false,
        profileId: 'desktop',
        appId: window.appId,
        windowRef,
      }
      snapshots.set(snapshot.targetId, snapshot)
      return snapshot
    },
    snapshot: (id: string) => snapshots.get(id) ?? null,
    list: () => [...snapshots.values()],
    close: async (id: string) => {
      snapshots.delete(id)
    },
    observe: async (request: { includeText: boolean }) => {
      observedWithText = request.includeText
      return {
        generation: 1,
        revision: 2,
        title: 'Diary',
        urlOrApp: 'app:com.example.Notes',
        focus: true,
        frameOrWindowId: 'w-notes',
        viewport: { width: 800, height: 600, scale: 1 },
        elements: [
          {
            ref: 'r2.1',
            role: 'textbox',
            name: 'Entry',
            value: 'dear diary',
            actions: ['setValue'],
          },
          { ref: 'r2.2', role: 'button', name: 'Save', actions: ['press'] },
        ],
        textExcerpt: 'dear diary',
        truncated: false,
        redactions: 0,
      }
    },
    screenshot: async () => ({
      screenshotId: 'shot-1',
      generation: 1,
      revision: 2,
      png: TINY_PNG,
      width: 1,
      height: 1,
      scale: 1,
    }),
    setPaused: () => undefined,
    subscribe: () => () => undefined,
    permissions: async () => ({}),
    releaseAll: async () => undefined,
  } as unknown as NativeDesktopDriver
  const port: ComputerUseHostPort = {
    platform: 'macos',
    embeddedBrowser: () => null,
    externalBrowser: () => null,
    desktop: () => driver,
    capabilities: async () => [driver.capability()],
    indicateControl: () => undefined,
  }
  const service = new ComputerUseService({
    port,
    grants,
    policy: new UiActionPolicy({ grants }),
    sessionFor: (id) => store.get(id),
    saveImage: (bytes, mediaType) => ({
      attachmentId: 'att_1',
      mediaType,
      bytes: bytes.byteLength,
    }),
    cancelGrantCards: () => undefined,
    settings: () => ({ enabled: true, appLists: lists }),
  })
  return {
    service,
    observedWithText: () => observedWithText,
  }
}

const identity = (fullAccess: boolean): UiCallerIdentity => ({
  subject: 'session:s1',
  kind: 'session',
  ownerSessionId: 's1',
  callerSessionId: 's1',
  taskId: 's1:1',
  turn: 1,
  background: false,
  canAsk: true,
  fullAccess,
})

let calls = 0
const ctx = (): OpContext => ({
  identity: identity(true),
  callId: `call-${++calls}`,
  toolName: 'desktop_test',
  signal: new AbortController().signal,
  ticket: { kind: 'auto', actionClass: 'observe' },
  vision: false,
})

/** The ticket the gate would issue for binding this window. */
const bindCtx = (window: DesktopWindowInfo): OpContext => ({
  ...ctx(),
  ticket: {
    kind: 'auto',
    actionClass: 'observe',
    requirement: {
      driver: 'desktop',
      actionClass: 'observe',
      appId: window.appId,
      windowRef: window.windowRef,
      callId: 'bind',
    },
  },
})

describe('user app lists', () => {
  it('hides and refuses apps the user added to the protected list', async () => {
    const k = setup({ protected: ['com.example.Bank'] })
    const signal = new AbortController().signal
    expect(
      (await k.service.listDesktopApps(signal)).map((app) => app.appId),
    ).not.toContain('com.example.Bank')
    expect(
      (await k.service.listDesktopWindows(identity(true), undefined, signal))
        .map((window) => window.appId)
        .sort(),
    ).toEqual(['com.example.Notes', 'com.example.Shell'])
    // A guessed ref of the hidden window is refused as protected.
    expect(() => k.service.desktopCandidate(identity(true), 'w-bank')).toThrow(
      /protected/,
    )
    expect(k.service.isProtectedApp('com.example.Bank')).toBe(true)
    // The built-in list still applies.
    expect(k.service.isProtectedApp('com.apple.keychainaccess')).toBe(true)
    expect(k.service.isProtectedApp('com.example.Notes')).toBe(false)
  })

  it('reads a sensitive app as structure only and never captures it', async () => {
    const k = setup({ sensitive: ['com.example.Notes'] })
    const signal = new AbortController().signal
    await k.service.listDesktopWindows(identity(true), undefined, signal)
    const record = await k.service.bindDesktop(bindCtx(windows[1]!), 'w-notes')
    const observation = await k.service.observe(ctx(), {
      targetId: record.targetId,
    })
    expect(k.observedWithText()).toBe(false)
    expect(JSON.stringify(observation)).not.toContain('dear diary')
    expect(observation.elements[0]).not.toHaveProperty('value')
    expect(observation.redactions).toBe(1)
    expect(observation.notes?.join(' ')).toContain('sensitive')
    // Refused before any card, and in the kernel as well.
    expect(() =>
      GUI_TOOL_CATALOG.desktop_screenshot!.classify!({
        args: { targetId: record.targetId },
        identity: identity(false),
        service: k.service,
        highImpact: defaultHighImpactClassifier,
        callId: 'c',
        toolName: 'desktop_screenshot',
      }),
    ).toThrow(/sensitive/)
    await expect(
      k.service.screenshot(ctx(), { targetId: record.targetId }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' })
  })

  it('confirms every input to a user-added high-risk app in scoped mode', async () => {
    const k = setup({ highRisk: ['com.example.Shell'] })
    const signal = new AbortController().signal
    await k.service.listDesktopWindows(identity(true), undefined, signal)
    const record = await k.service.bindDesktop(bindCtx(windows[2]!), 'w-shell')
    const classify = (fullAccess: boolean) =>
      GUI_TOOL_CATALOG.desktop_type!.classify!({
        args: { targetId: record.targetId, text: 'ls' },
        identity: identity(fullAccess),
        service: k.service,
        highImpact: defaultHighImpactClassifier,
        callId: 'c',
        toolName: 'desktop_type',
      }).requirement
    expect(classify(false)).toMatchObject({
      highRiskApp: true,
      confirmEachTime: true,
    })
    expect(classify(true)).toMatchObject({ highRiskApp: true })
    expect(classify(true).confirmEachTime).toBeUndefined()
  })

  it('persists the lists through CoreApi, deduplicated', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cu-lists-api-'))
    const stateRoot = join(root, 'home')
    const fixture = await makeApi({
      root,
      stateRoot,
      extra: { computerUsePort: new FakeComputerUsePort() },
    })
    try {
      const view = await fixture.api.computerUse.setAppLists({
        protected: ['com.example.Bank', 'com.example.Bank'],
        sensitive: ['com.example.Notes'],
      })
      expect(view.appLists).toEqual({
        protected: ['com.example.Bank'],
        highRisk: [],
        sensitive: ['com.example.Notes'],
      })
      expect(
        new ComputerUseConfigStore(computerUseStateDir(stateRoot)).get()
          .appLists.protected,
      ).toEqual(['com.example.Bank'])
      expect(COMPUTER_USE_CONFIG_FILE).toBe('config.json')
    } finally {
      await fixture.api.close()
    }
  })
})
