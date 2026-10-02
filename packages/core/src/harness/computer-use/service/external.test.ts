// Chrome/Edge 智能体权限 in the kernel (PLAN-CAP-001 RV-09): the gate and
// the service apply the user's 浏览 rule before a new tab or a navigation
// reaches the extension, pages that move by themselves are judged by the
// same rules, and downloads from the Agent's tabs follow the 下载 rule plus
// the inbox's executable check.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionLogStore } from '../../../session-log/store'
import type { Agent } from '../../agent/agent'
import { PendingInteractions } from '../../host/interactions'
import type { ToolCallInfo } from '../../tools/registry'
import {
  ExternalSiteRuleStore,
  type ExternalBrowserSettingsPatch,
} from '../external-site-rules'
import { createComputerUseGate, type GateDeps } from '../gate'
import { GrantAskService } from '../grants/ask'
import { GrantStore } from '../grants/store'
import type { UiCallerIdentity } from '../identity'
import { UiActionPolicy } from '../policy'
import type {
  BrowserDriver,
  BrowserProfileSpec,
  ComputerUseHostPort,
  DriverEvent,
  DriverEventListener,
  ExternalSiteDecider,
  TargetSnapshot,
} from '../port'
import { defaultHighImpactClassifier } from '../risk'
import { GUI_TOOL_CATALOG } from '../tools/catalog'
import {
  ComputerUseService,
  type ExternalConfirmation,
  type GateTicket,
  type OpContext,
} from './service'

const OWNER = 'owner'
const identity: UiCallerIdentity = {
  subject: `session:${OWNER}`,
  kind: 'session',
  ownerSessionId: OWNER,
  callerSessionId: OWNER,
  taskId: `${OWNER}:1`,
  turn: 1,
  background: false,
  canAsk: true,
  fullAccess: true,
}

async function tick(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

function kit(
  options: { rules?: ExternalBrowserSettingsPatch; answer?: boolean } = {},
) {
  const log = new SessionLogStore({ root: '/tmp/unused', persist: false })
  const session = log.create({ id: OWNER })
  const dir = mkdtempSync(join(tmpdir(), 'cu-external-'))
  const grants = new GrantStore({ root: join(dir, 'grants') })
  const policy = new UiActionPolicy({ grants })
  const sites = new ExternalSiteRuleStore(dir)
  if (options.rules) sites.update(options.rules)
  const listeners = new Set<DriverEventListener>()
  const state: {
    decider: ExternalSiteDecider | null
    answer: boolean
    profile: string | null
  } = { decider: null, answer: options.answer ?? true, profile: 'pair-1' }
  const opened: Array<{ profile: BrowserProfileSpec; url: string }> = []
  const acted: unknown[] = []
  const navigation: Array<[string, boolean]> = []
  const downloads: Array<[string, { allow: boolean; reason?: string }]> = []
  const snapshots = new Map<string, TargetSnapshot>()
  let opens = 0
  const driver = {
    driver: 'external-browser',
    capability: () => ({
      driver: 'external-browser',
      platform: 'macos',
      stage: 'experimental',
      label: 'Chrome/Edge 连接',
      enabled: true,
      available: true,
      actions: ['click', 'fill', 'navigate'],
      missing: [],
    }),
    snapshot: (targetId: string) => snapshots.get(targetId) ?? null,
    list: () => [...snapshots.values()],
    open: async (request: { profile: BrowserProfileSpec; url: string }) => {
      opened.push(request)
      const snapshot: TargetSnapshot = {
        targetId: `ext-${++opens}`,
        kind: 'external-tab',
        driver: 'external-browser',
        generation: 1,
        revision: 0,
        url: new URL(request.url).origin,
        title: `Chrome/Edge ${new URL(request.url).origin}`,
        loading: false,
        profileId:
          request.profile.kind === 'persistent'
            ? request.profile.profileId
            : 'temporary',
      }
      snapshots.set(snapshot.targetId, snapshot)
      return snapshot
    },
    act: async (
      request: { targetId: string },
      hooks: { dispatched(): void },
    ) => {
      acted.push(request)
      hooks.dispatched()
      return { outcome: 'observed', afterRevision: 1 }
    },
    close: async () => undefined,
    release: async () => undefined,
    setPaused: () => undefined,
    subscribe: (listener: DriverEventListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setNavigationPolicy: () => undefined,
    setSiteDecider: (decider: ExternalSiteDecider) => {
      state.decider = decider
    },
    openProfile: () => state.profile,
    resolveNavigation: (targetId: string, allow: boolean) => {
      navigation.push([targetId, allow])
    },
    resolveDownload: (
      downloadId: string,
      verdict: { allow: boolean; reason?: string },
    ) => {
      downloads.push([downloadId, verdict])
    },
    historyTarget: () => null,
    listAttached: () => [],
  } as unknown as BrowserDriver
  const port = {
    platform: 'macos',
    embeddedBrowser: () => null,
    externalBrowser: () => driver,
    desktop: () => null,
    capabilities: async () => [],
    indicateControl: () => undefined,
  } satisfies ComputerUseHostPort
  const confirmations: ExternalConfirmation[] = []
  const changes: string[] = []
  const service = new ComputerUseService({
    port,
    grants,
    policy,
    sessionFor: (id) => log.get(id),
    saveImage: () => ({ attachmentId: 'a', mediaType: 'image/png', bytes: 1 }),
    cancelGrantCards: () => undefined,
    settings: () => ({ enabled: true }),
    externalSites: sites,
    confirmExternal: async (request) => {
      confirmations.push(request)
      return state.answer
    },
    onChanged: (reason) => changes.push(reason),
  })
  const ctx = (ticket: GateTicket = { kind: 'auto' }): OpContext => ({
    identity,
    callId: `call-${Math.random()}`,
    toolName: 'external_tab_open',
    signal: new AbortController().signal,
    ticket,
    vision: false,
  })
  const emit = async (event: DriverEvent): Promise<void> => {
    for (const listener of listeners) listener(event)
    await tick()
  }
  const classify = (name: string, args: Record<string, unknown>) =>
    GUI_TOOL_CATALOG[name]!.classify!({
      args,
      identity,
      service,
      highImpact: defaultHighImpactClassifier,
      callId: 'classify',
      toolName: name,
    })
  return {
    log,
    session,
    grants,
    policy,
    sites,
    state,
    opened,
    acted,
    navigation,
    downloads,
    confirmations,
    changes,
    service,
    ctx,
    emit,
    classify,
  }
}

type Kit = ReturnType<typeof kit>

async function openAllowed(k: Kit, url = 'https://github.com/emperor') {
  return await k.service.openExternal(k.ctx(), { url })
}

describe('opening and navigating in the user’s Chrome or Edge', () => {
  it('opens an allowed site in a new tab of the connected browser for this task', async () => {
    const k = kit()
    const record = await openAllowed(k)
    expect(k.opened).toEqual([
      {
        profile: { kind: 'persistent', profileId: 'pair-1' },
        url: 'https://github.com/emperor',
        ownerSessionId: OWNER,
      },
    ])
    expect(record).toMatchObject({
      driver: 'external-browser',
      kind: 'external-tab',
      ownerSessionId: OWNER,
      profileId: 'pair-1',
      url: 'https://github.com',
    })
    expect(k.log.get(OWNER)!.events.map((event) => event.type)).toContain(
      'ui/target-opened',
    )
    // The kernel handed the driver the user's rules.
    expect(k.state.decider?.('https://github.com/', 'download')).toBe('ask')
  })

  it('says so when no browser is connected', async () => {
    const k = kit()
    k.state.profile = null
    await expect(openAllowed(k)).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
      reason: 'not-connected',
    })
    expect(k.opened).toEqual([])
  })

  it('refuses a blocked site before anything reaches the browser', async () => {
    const k = kit({
      rules: {
        sites: [
          { pattern: '*.bank.example', browse: 'block', download: 'block' },
        ],
      },
    })
    await expect(
      k.service.openExternal(k.ctx(), { url: 'https://www.bank.example/' }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      reason: 'site-blocked',
    })
    expect(k.opened).toEqual([])
  })

  it('needs the user’s card for a site that asks first', async () => {
    const k = kit({ rules: { defaults: { browse: 'ask' } } })
    await expect(openAllowed(k)).rejects.toMatchObject({
      code: 'PERMISSION_REQUIRED',
      reason: 'site-needs-approval',
    })
    expect(k.opened).toEqual([])
  })

  it('checks the rule again for every navigation in the tab', async () => {
    const k = kit({
      rules: {
        sites: [
          { pattern: 'evil.example', browse: 'block', download: 'block' },
        ],
      },
    })
    const record = await openAllowed(k)
    await expect(
      k.service.act(k.ctx(), {
        targetId: record.targetId,
        action: { kind: 'navigate', url: 'https://evil.example/login' },
      }),
    ).rejects.toMatchObject({ reason: 'site-blocked' })
    await expect(
      k.service.act(k.ctx(), {
        targetId: record.targetId,
        action: { kind: 'history', direction: 'back' },
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DISABLED' })
    expect(k.acted).toEqual([])
    await k.service.act(k.ctx(), {
      targetId: record.targetId,
      action: { kind: 'navigate', url: 'https://docs.github.com/' },
    })
    expect(k.acted).toHaveLength(1)
  })
})

describe('pages that move by themselves', () => {
  it('asks the user before the Agent carries on in a site that needs approval', async () => {
    const k = kit({
      rules: {
        sites: [{ pattern: 'pay.example', browse: 'ask', download: 'ask' }],
      },
    })
    const record = await openAllowed(k)
    await k.emit({
      type: 'navigation-pending',
      targetId: record.targetId,
      url: 'https://pay.example',
    })
    expect(k.confirmations).toEqual([
      expect.objectContaining({
        identity,
        profileId: 'pair-1',
        origin: 'https://pay.example',
        actionClass: 'navigate',
      }),
    ])
    expect(k.navigation).toEqual([[record.targetId, true]])
  })

  it('disconnects the tab when the user says no, and tells the Agent why', async () => {
    const k = kit({ answer: false })
    const record = await openAllowed(k)
    await k.emit({
      type: 'navigation-pending',
      targetId: record.targetId,
      url: 'https://pay.example',
    })
    expect(k.navigation).toEqual([[record.targetId, false]])
    await k.emit({
      type: 'lost',
      targetId: record.targetId,
      reason: 'site-denied',
    })
    await expect(
      k.service.act(k.ctx(), {
        targetId: record.targetId,
        action: { kind: 'navigate', url: 'https://github.com/' },
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      reason: 'user-denied',
      message: expect.stringContaining('https://pay.example'),
    })
  })

  it('says the site is blocked when a page took the tab there', async () => {
    const k = kit()
    const record = await openAllowed(k)
    await k.emit({
      type: 'navigation-blocked',
      targetId: record.targetId,
      url: 'https://evil.example',
    })
    await k.emit({
      type: 'lost',
      targetId: record.targetId,
      reason: 'site-blocked',
    })
    // With its id, and once without one (it was the current tab).
    await expect(
      k.service.act(k.ctx(), {
        action: { kind: 'navigate', url: 'https://github.com/' },
      }),
    ).rejects.toMatchObject({ reason: 'site-blocked' })
    expect(() =>
      k.classify('browser_observe', { targetId: record.targetId }),
    ).toThrow(/evil\.example/)
  })
})

describe('downloads from the Agent’s tabs', () => {
  async function download(
    k: Kit,
    targetId: string,
    downloadId: string,
    filename: string,
    url = 'https://files.example',
  ) {
    await k.emit({
      type: 'download-requested',
      targetId,
      downloadId,
      url,
      filename,
      bytes: 1_024,
    })
  }

  it('never lets an executable through, without asking', async () => {
    const k = kit({ rules: { defaults: { download: 'allow' } } })
    const record = await openAllowed(k)
    await download(k, record.targetId, 'xd_1', 'setup.dmg')
    expect(k.downloads).toEqual([
      ['xd_1', { allow: false, reason: 'executable' }],
    ])
    expect(k.confirmations).toEqual([])
    expect(k.log.get(OWNER)!.events.at(-1)).toMatchObject({
      type: 'ui/download',
      data: { downloadId: 'xd_1', state: 'refused', filename: 'setup.dmg' },
    })
  })

  it('takes the stricter rule of the page and the file’s site', async () => {
    const k = kit({
      rules: {
        defaults: { download: 'allow' },
        sites: [
          { pattern: 'files.example', browse: 'allow', download: 'block' },
        ],
      },
    })
    const record = await openAllowed(k)
    await download(k, record.targetId, 'xd_2', 'report.pdf')
    await download(
      k,
      record.targetId,
      'xd_3',
      'notes.txt',
      'https://github.com',
    )
    await download(k, record.targetId, 'xd_4', 'blob.csv', '')
    expect(k.downloads).toEqual([
      ['xd_2', { allow: false, reason: 'blocked' }],
      ['xd_3', { allow: true }],
      ['xd_4', { allow: true }],
    ])
  })

  it('asks the user when the rule says 需要批准 (the default)', async () => {
    const k = kit()
    const record = await openAllowed(k)
    await download(k, record.targetId, 'xd_5', 'report.pdf')
    expect(k.confirmations.at(-1)).toMatchObject({
      origin: 'https://files.example',
      actionClass: 'transfer',
      display: { url: expect.stringContaining('report.pdf') },
    })
    k.state.answer = false
    await download(k, record.targetId, 'xd_6', 'second.pdf')
    expect(k.downloads).toEqual([
      ['xd_5', { allow: true }],
      ['xd_6', { allow: false, reason: 'denied' }],
    ])
  })

  it('writes a finished download into the conversation log', async () => {
    const k = kit()
    const record = await openAllowed(k)
    await k.emit({
      type: 'download-finished',
      targetId: record.targetId,
      downloadId: 'xd_7',
      state: 'completed',
      filename: 'report.pdf',
      bytes: 2_048,
      url: 'https://files.example',
    })
    expect(k.log.get(OWNER)!.events.at(-1)).toMatchObject({
      type: 'ui/download',
      data: {
        downloadId: 'xd_7',
        state: 'completed',
        filename: 'report.pdf',
        bytes: 2_048,
        origin: 'https://files.example',
        pageOrigin: 'https://github.com',
      },
    })
  })
})

describe('the gate', () => {
  it('classifies opening a tab by the 浏览 rule: allow, ask once, or refuse', () => {
    const k = kit({
      rules: {
        sites: [
          { pattern: 'pay.example', browse: 'ask', download: 'ask' },
          { pattern: 'evil.example', browse: 'block', download: 'block' },
        ],
      },
    })
    expect(
      k.classify('external_tab_open', { url: 'https://github.com/' })
        .requirement,
    ).toMatchObject({
      driver: 'external-browser',
      actionClass: 'navigate',
      profileId: 'pair-1',
      origin: 'https://github.com/',
    })
    expect(
      k.classify('external_tab_open', { url: 'https://github.com/' })
        .requirement.confirmEachTime,
    ).toBeUndefined()
    expect(
      k.classify('external_tab_open', { url: 'https://pay.example/checkout' })
        .requirement,
    ).toMatchObject({ confirmEachTime: true })
    expect(() =>
      k.classify('external_tab_open', { url: 'https://evil.example/' }),
    ).toThrow(/blocked/)
    expect(() =>
      k.classify('external_tab_open', { url: 'file:///etc/hosts' }),
    ).toThrow(/http/)
  })

  it('classifies a navigation in a Chrome/Edge tab the same way, without history moves', async () => {
    const k = kit({ rules: { defaults: { browse: 'ask' } } })
    k.sites.update({
      sites: [{ pattern: 'github.com', browse: 'allow', download: 'ask' }],
    })
    const record = await openAllowed(k)
    expect(
      k.classify('browser_navigate', {
        targetId: record.targetId,
        url: 'https://pay.example/',
      }).requirement,
    ).toMatchObject({
      driver: 'external-browser',
      origin: 'https://pay.example/',
      confirmEachTime: true,
    })
    expect(() =>
      k.classify('browser_navigate', {
        targetId: record.targetId,
        history: 'back',
      }),
    ).toThrow(/URL/)
  })

  it('shows one card for a site that asks, then lets that one tab open', async () => {
    const k = kit({ rules: { defaults: { browse: 'ask' } } })
    const pending = new PendingInteractions()
    const ask = new GrantAskService()
    ask.setAnswerer(pending.grantAnswerer)
    const deps: GateDeps = {
      service: k.service,
      policy: k.policy,
      grants: k.grants,
      ask,
      identity: () => identity,
      planActive: () => false,
      rootSession: () => k.session,
      highImpact: defaultHighImpactClassifier,
      now: () => new Date(),
    }
    const gate = createComputerUseGate(deps)
    const call: ToolCallInfo = {
      callId: 'open-1',
      name: 'external_tab_open',
      arguments: { url: 'https://pay.example/checkout' },
      agent: { id: OWNER, session: k.session } as unknown as Agent,
      signal: new AbortController().signal,
    }
    const decision = gate(call)
    await tick()
    const [card] = pending.forSession(OWNER)
    expect(k.session.events.at(-1)).toMatchObject({
      type: 'ui/grant-requested',
      data: {
        driver: 'external-browser',
        actions: ['navigate'],
        allowedScopes: ['once'],
        display: { url: 'https://pay.example/checkout' },
      },
    })
    pending.answer(card!, { grant: { option_id: 'once' } })
    expect(await decision).toEqual({ kind: 'allow' })
    const record = await k.service.openExternal(
      { ...k.ctx(k.service.takeTicket(OWNER, 'open-1')), callId: 'open-1' },
      { url: 'https://pay.example/checkout' },
    )
    expect(record.url).toBe('https://pay.example')
  })
})

describe('the settings', () => {
  it('reads and changes them, and tells the UI', () => {
    const k = kit()
    expect(k.service.externalBrowserSettings()).toMatchObject({
      defaults: { browse: 'allow', download: 'ask' },
      history: 'ask',
    })
    k.service.setExternalBrowserSettings({ history: 'never' })
    expect(k.service.externalBrowserSettings().history).toBe('never')
    expect(k.changes).toContain('state')
  })
})
