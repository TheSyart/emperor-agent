// The app lists were retired (2026-10-01): Emperor operates every app except
// the system-protected ones (spec 01 §4.4), with no high-risk mark and no
// screenshot ban; apps the user had kept out are named once in Settings.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import { ComputerUseService, type OpContext } from './service/service'
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
    appId: 'com.apple.Terminal',
    appName: 'Terminal',
    pid: 13,
    title: 'zsh',
    minimized: false,
    main: true,
  },
]

function setup() {
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
    settings: () => ({ enabled: true }),
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

describe('every app but the system-protected ones', () => {
  it('lists and binds any app; only the system-protected ones stay out of reach', async () => {
    const k = setup()
    const signal = new AbortController().signal
    expect(
      (await k.service.listDesktopApps(signal)).map((app) => app.appId).sort(),
    ).toEqual(['com.apple.Terminal', 'com.example.Bank', 'com.example.Notes'])
    expect(
      (await k.service.listDesktopWindows(identity(true), undefined, signal))
        .map((window) => window.appId)
        .sort(),
    ).toEqual(['com.apple.Terminal', 'com.example.Bank', 'com.example.Notes'])
    expect(k.service.desktopCandidate(identity(true), 'w-bank').appId).toBe(
      'com.example.Bank',
    )
    expect(k.service.isProtectedApp('com.example.Bank')).toBe(false)
    // The system list stays: Emperor never grants itself permissions or
    // types your password.
    for (const appId of [
      'com.apple.keychainaccess',
      'com.apple.Passwords',
      'com.apple.systempreferences',
      'com.apple.SecurityAgent',
      'com.apple.loginwindow',
      'com.emperor.agent.desktop',
    ])
      expect(k.service.isProtectedApp(appId)).toBe(true)
  })

  it('reads any app with its text and captures it', async () => {
    const k = setup()
    const signal = new AbortController().signal
    await k.service.listDesktopWindows(identity(true), undefined, signal)
    const record = await k.service.bindDesktop(bindCtx(windows[1]!), 'w-notes')
    const observation = await k.service.observe(ctx(), {
      targetId: record.targetId,
    })
    expect(k.observedWithText()).toBe(true)
    expect(JSON.stringify(observation)).toContain('dear diary')
    expect(observation.redactions).toBe(0)
    expect(() =>
      GUI_TOOL_CATALOG.desktop_screenshot!.classify!({
        args: { targetId: record.targetId },
        identity: identity(false),
        service: k.service,
        highImpact: defaultHighImpactClassifier,
        callId: 'c',
        toolName: 'desktop_screenshot',
      }),
    ).not.toThrow()
    await expect(
      k.service.screenshot(ctx(), { targetId: record.targetId }),
    ).resolves.toBeDefined()
  })

  it('types into a terminal like any other app (no high-risk mark)', async () => {
    const k = setup()
    const signal = new AbortController().signal
    await k.service.listDesktopWindows(identity(true), undefined, signal)
    const record = await k.service.bindDesktop(bindCtx(windows[2]!), 'w-shell')
    for (const fullAccess of [false, true]) {
      const requirement = GUI_TOOL_CATALOG.desktop_type!.classify!({
        args: { targetId: record.targetId, text: 'ls' },
        identity: identity(fullAccess),
        service: k.service,
        highImpact: defaultHighImpactClassifier,
        callId: 'c',
        toolName: 'desktop_type',
      }).requirement
      expect(requirement).not.toHaveProperty('highRiskApp')
      expect(requirement.confirmEachTime).toBeUndefined()
    }
  })

  it('names the apps once kept out until Settings acknowledges them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cu-lists-api-'))
    const stateRoot = join(root, 'home')
    const dir = computerUseStateDir(stateRoot)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(
      join(dir, COMPUTER_USE_CONFIG_FILE),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        appLists: {
          protected: ['com.example.Bank'],
          highRisk: [],
          sensitive: ['com.example.Notes'],
        },
      }),
      { mode: 0o600 },
    )
    const fixture = await makeApi({
      root,
      stateRoot,
      extra: { computerUsePort: new FakeComputerUsePort() },
    })
    try {
      const view = await fixture.api.computerUse.status()
      expect(view.enabled).toBe(true)
      expect(view.retiredProtectedApps).toEqual(['com.example.Bank'])
      const acknowledged =
        await fixture.api.computerUse.acknowledgeRetiredApps()
      expect(acknowledged).not.toHaveProperty('retiredProtectedApps')
      expect(new ComputerUseConfigStore(dir).retiredProtectedApps()).toEqual([])
      expect(fixture.api.computerUse).not.toHaveProperty('setAppLists')
    } finally {
      await fixture.api.close()
    }
  })
})
