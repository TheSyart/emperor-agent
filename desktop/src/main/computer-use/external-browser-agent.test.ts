// The external driver's own browsing (PLAN-CAP-001 RV-09): tabs it opens
// in the user's Chrome or Edge, navigation, pages that move by themselves
// under the user's 智能体权限, and downloads held until the kernel decides.
import { describe, expect, it, vi } from 'vitest'
import type {
  DriverEvent,
  ExternalSiteDecider,
} from '@emperor/core/host-capabilities'
import type { NmBridgeEvent, NmBridgeServer } from './nm-bridge'
import { ExternalBrowserDriver } from './external-browser-driver'
import type { ExternalDownloadEntry } from './external-downloads'

const pairingId = 'pairing-1'
const tabTarget = '12345678-1234-1234-1234-123456789012'
const openedTarget = 'abcdefab-1234-4234-8234-123456789012'

type Reply = (params: Record<string, unknown>) => unknown

function fixture(replies: Record<string, Reply> = {}) {
  const listeners = new Set<(event: NmBridgeEvent) => void>()
  const request = vi.fn(
    async (
      _pairing: string,
      method: string,
      params: Record<string, unknown> = {},
    ) => {
      const reply = replies[method]
      if (reply) return reply(params)
      if (method === 'target.list')
        return {
          targets: [
            {
              targetId: tabTarget,
              tabId: 7,
              windowId: 2,
              origin: 'https://example.com',
              generation: 1,
            },
          ],
        }
      if (method === 'target.detach') return { released: true }
      if (method === 'download.resolve') return { resolved: true }
      throw new Error('unavailable')
    },
  )
  let ready = [pairingId]
  const bridge = {
    subscribe: (listener: (event: NmBridgeEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    readyPairings: () => ready,
    unavailableReason: null,
    request,
  } as unknown as NmBridgeServer
  const recorded: ExternalDownloadEntry[] = []
  const driver = new ExternalBrowserDriver(bridge, 'macos', {
    downloads: { record: (entry) => recorded.push(entry) },
    now: () => 1_700_000_000_000,
  })
  const events: DriverEvent[] = []
  driver.subscribe((event) => events.push(event))
  const rules: Record<string, 'allow' | 'ask' | 'block'> = {}
  const decider: ExternalSiteDecider = (url, kind) =>
    rules[`${kind}:${new URL(url).origin}`] ??
    (kind === 'browse' ? 'allow' : 'ask')
  driver.setSiteDecider(decider)
  const emit = (event: NmBridgeEvent) => {
    for (const listener of listeners) listener(event)
  }
  return {
    driver,
    request,
    events,
    rules,
    recorded,
    emit,
    methods: () => request.mock.calls.map((call) => call[1]),
    setReady: (next: string[]) => {
      ready = next
    },
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

async function claimedTab(k: ReturnType<typeof fixture>) {
  k.emit({
    type: 'target-attached',
    pairingId,
    targetId: tabTarget,
    tabId: 7,
    windowId: 2,
    origin: 'https://example.com',
    generation: 1,
  })
  await k.driver.claimAttachedTarget(
    tabTarget,
    'owner-1',
    new AbortController().signal,
  )
}

const opened = {
  targetId: openedTarget,
  tabId: 41,
  windowId: 3,
  origin: 'https://github.com',
  generation: 9,
}

describe('opening a tab in the user’s browser', () => {
  it('opens through the most recently connected browser and gives the tab to the task', async () => {
    const k = fixture({ 'tab.open': () => opened })
    k.emit({
      type: 'ready',
      pairingId: 'pairing-0',
      extensionId: 'x',
      workerEpoch: 1,
    })
    k.emit({ type: 'ready', pairingId, extensionId: 'x', workerEpoch: 1 })
    k.setReady(['pairing-0', pairingId])
    expect(k.driver.openProfile()).toBe(pairingId)
    const snapshot = await k.driver.open(
      {
        profile: { kind: 'persistent', profileId: pairingId },
        url: 'https://github.com/emperor',
        ownerSessionId: 'owner-1',
      },
      new AbortController().signal,
    )
    expect(k.request.mock.calls[0]?.slice(0, 3)).toEqual([
      pairingId,
      'tab.open',
      { url: 'https://github.com/emperor' },
    ])
    expect(snapshot).toMatchObject({
      targetId: openedTarget,
      kind: 'external-tab',
      driver: 'external-browser',
      generation: 9,
      url: 'https://github.com',
      profileId: pairingId,
    })
    // Already this task's: another task cannot claim it.
    expect(k.driver.listAttached()).toEqual([
      expect.objectContaining({ targetId: openedTarget, claimedBy: 'owner-1' }),
    ])
    expect(k.driver.capability().actions).toContain('navigate')
  })

  it('refuses when no browser is connected', async () => {
    const k = fixture()
    k.setReady([])
    expect(k.driver.openProfile()).toBeNull()
    await expect(
      k.driver.open(
        {
          profile: { kind: 'persistent', profileId: pairingId },
          url: 'https://github.com/',
          ownerSessionId: 'owner-1',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
    expect(k.methods()).toEqual([])
  })

  it('lets go of a tab that landed on a blocked site', async () => {
    const k = fixture({
      'tab.open': () => ({ ...opened, origin: 'https://evil.example' }),
    })
    k.rules['browse:https://evil.example'] = 'block'
    await expect(
      k.driver.open(
        {
          profile: { kind: 'persistent', profileId: pairingId },
          url: 'https://short.example/x',
          ownerSessionId: 'owner-1',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      reason: 'site-blocked',
    })
    expect(k.methods()).toEqual(['tab.open', 'target.detach'])
    expect(k.driver.listAttached()).toEqual([])
  })
})

describe('navigation', () => {
  it('goes to a URL in a claimed tab and carries on under the new generation', async () => {
    const k = fixture({
      'target.navigate': () => ({
        targetId: tabTarget,
        generation: 2,
        origin: 'https://docs.example',
        revision: 0,
      }),
    })
    await claimedTab(k)
    const dispatched = vi.fn()
    const outcome = await k.driver.act(
      {
        operationId: 'op-1',
        targetId: tabTarget,
        generation: 1,
        expectedRevision: 0,
        action: { kind: 'navigate', url: 'https://docs.example/start' },
        deadlineMs: 15_000,
      },
      { dispatched },
      new AbortController().signal,
    )
    expect(dispatched).toHaveBeenCalledOnce()
    expect(k.request.mock.calls.at(-1)?.slice(1, 3)).toEqual([
      'target.navigate',
      { targetId: tabTarget, generation: 1, url: 'https://docs.example/start' },
    ])
    expect(outcome).toMatchObject({
      outcome: 'observed',
      url: 'https://docs.example',
    })
    expect(k.driver.snapshot(tabTarget)).toMatchObject({
      generation: 2,
      url: 'https://docs.example',
    })
    expect(k.events).toContainEqual(
      expect.objectContaining({
        type: 'navigated',
        targetId: tabTarget,
        url: 'https://docs.example',
        generation: 2,
      }),
    )
  })

  it('follows a page that moved to an allowed site', async () => {
    const k = fixture({
      'target.follow': (params) => ({
        targetId: params.targetId,
        generation: 3,
        origin: params.origin,
        revision: 4,
      }),
    })
    await claimedTab(k)
    k.emit({
      type: 'target-navigated',
      pairingId,
      targetId: tabTarget,
      generation: 1,
      origin: 'https://news.example',
    })
    await settle()
    expect(k.request.mock.calls.at(-1)?.slice(1, 3)).toEqual([
      'target.follow',
      { targetId: tabTarget, generation: 1, origin: 'https://news.example' },
    ])
    expect(k.driver.snapshot(tabTarget)).toMatchObject({
      generation: 3,
      url: 'https://news.example',
    })
  })

  it('disconnects a tab whose page went to a blocked site', async () => {
    const k = fixture()
    k.rules['browse:https://evil.example'] = 'block'
    await claimedTab(k)
    k.emit({
      type: 'target-navigated',
      pairingId,
      targetId: tabTarget,
      generation: 1,
      origin: 'https://evil.example',
    })
    await settle()
    expect(k.methods().at(-1)).toBe('target.detach')
    expect(k.events.slice(-2)).toEqual([
      {
        type: 'navigation-blocked',
        targetId: tabTarget,
        url: 'https://evil.example',
      },
      { type: 'lost', targetId: tabTarget, reason: 'site-blocked' },
    ])
    expect(k.driver.listAttached()).toEqual([])
  })

  it('pauses a claimed tab on a site that needs approval until the user answers', async () => {
    const k = fixture({
      'target.follow': (params) => ({
        targetId: params.targetId,
        generation: 3,
        origin: params.origin,
        revision: 0,
      }),
    })
    k.rules['browse:https://pay.example'] = 'ask'
    await claimedTab(k)
    k.emit({
      type: 'target-navigated',
      pairingId,
      targetId: tabTarget,
      generation: 1,
      origin: 'https://pay.example',
    })
    await settle()
    expect(k.events.at(-1)).toEqual({
      type: 'navigation-pending',
      targetId: tabTarget,
      url: 'https://pay.example',
    })
    expect(k.methods()).not.toContain('target.follow')
    await expect(
      k.driver.observe(
        {
          targetId: tabTarget,
          generation: 1,
          budget: {
            maxElements: 10,
            maxTextBytes: 0,
            maxDepth: 4,
            timeoutMs: 1_000,
          },
          includeText: false,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'TARGET_BUSY' })
    k.driver.resolveNavigation(tabTarget, true)
    await settle()
    expect(k.driver.snapshot(tabTarget)).toMatchObject({
      generation: 3,
      url: 'https://pay.example',
    })
  })

  it('disconnects the paused tab when the user says no', async () => {
    const k = fixture()
    k.rules['browse:https://pay.example'] = 'ask'
    await claimedTab(k)
    k.emit({
      type: 'target-navigated',
      pairingId,
      targetId: tabTarget,
      generation: 1,
      origin: 'https://pay.example',
    })
    await settle()
    k.driver.resolveNavigation(tabTarget, false)
    await settle()
    expect(k.methods().at(-1)).toBe('target.detach')
    expect(k.events.at(-1)).toEqual({
      type: 'lost',
      targetId: tabTarget,
      reason: 'site-denied',
    })
  })

  it('lets a tab nobody works in follow a site that asks (the next claim asks instead)', async () => {
    const k = fixture({
      'target.follow': (params) => ({
        targetId: params.targetId,
        generation: 3,
        origin: params.origin,
        revision: 0,
      }),
    })
    k.rules['browse:https://pay.example'] = 'ask'
    k.emit({
      type: 'target-attached',
      pairingId,
      targetId: tabTarget,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    k.emit({
      type: 'target-navigated',
      pairingId,
      targetId: tabTarget,
      generation: 1,
      origin: 'https://pay.example',
    })
    await settle()
    expect(k.driver.listAttached()).toEqual([
      expect.objectContaining({ origin: 'https://pay.example', generation: 3 }),
    ])
  })
})

describe('downloads', () => {
  function pending(
    k: ReturnType<typeof fixture>,
    downloadId: number,
    filename: string,
  ) {
    k.emit({
      type: 'download-pending',
      pairingId,
      downloadId,
      targetId: tabTarget,
      generation: 1,
      origin: 'https://files.example',
      filename,
      mimeType: 'application/pdf',
      bytes: 2_048,
      browser: 'edge',
    })
  }

  it('asks the kernel about a claimed tab’s download and passes the verdict on', async () => {
    const k = fixture()
    await claimedTab(k)
    pending(k, 31, 'report.pdf')
    const requested = k.events.at(-1) as Extract<
      DriverEvent,
      { type: 'download-requested' }
    >
    expect(requested).toMatchObject({
      type: 'download-requested',
      targetId: tabTarget,
      url: 'https://files.example',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      bytes: 2_048,
    })
    expect(requested.downloadId).toMatch(/^xd_[0-9a-f]{12}$/)
    k.driver.resolveDownload(requested.downloadId, { allow: true })
    await settle()
    expect(k.request.mock.calls.at(-1)?.slice(1, 3)).toEqual([
      'download.resolve',
      { downloadId: 31, allow: true },
    ])
    k.emit({
      type: 'download-done',
      pairingId,
      downloadId: 31,
      state: 'complete',
      filename: 'report (1).pdf',
      bytes: 2_048,
    })
    expect(k.events.at(-1)).toEqual({
      type: 'download-finished',
      targetId: tabTarget,
      downloadId: requested.downloadId,
      state: 'completed',
      filename: 'report (1).pdf',
      bytes: 2_048,
      url: 'https://files.example',
    })
    expect(k.recorded.at(-1)).toEqual({
      id: requested.downloadId,
      name: 'report (1).pdf',
      origin: 'https://files.example',
      browser: 'edge',
      state: 'completed',
      bytes: 2_048,
      time: 1_700_000_000_000,
    })
  })

  it('records a refusal with its reason', async () => {
    const k = fixture()
    await claimedTab(k)
    pending(k, 32, 'setup.dmg')
    const requested = k.events.at(-1) as { downloadId: string }
    k.driver.resolveDownload(requested.downloadId, {
      allow: false,
      reason: 'executable',
    })
    await settle()
    expect(k.request.mock.calls.at(-1)?.slice(1, 3)).toEqual([
      'download.resolve',
      { downloadId: 32, allow: false },
    ])
    expect(k.recorded.at(-1)).toMatchObject({
      name: 'setup.dmg',
      state: 'refused',
      reason: 'executable',
      bytes: 0,
    })
  })

  it('decides itself for a tab no task holds: only what the rule allows outright', async () => {
    const k = fixture()
    k.emit({
      type: 'target-attached',
      pairingId,
      targetId: tabTarget,
      tabId: 7,
      windowId: 2,
      origin: 'https://example.com',
      generation: 1,
    })
    pending(k, 33, 'report.pdf')
    await settle()
    expect(k.request.mock.calls.at(-1)?.slice(1, 3)).toEqual([
      'download.resolve',
      { downloadId: 33, allow: false },
    ])
    k.rules['download:https://files.example'] = 'allow'
    k.rules['download:https://example.com'] = 'allow'
    pending(k, 34, 'report.pdf')
    pending(k, 35, 'tool.pkg')
    await settle()
    expect(k.request.mock.calls.slice(-2).map((call) => call[2])).toEqual([
      { downloadId: 34, allow: true },
      { downloadId: 35, allow: false },
    ])
  })
})

describe('history (RV-10)', () => {
  it('searches every connected browser, newest first, one row per page', async () => {
    const k = fixture({
      'history.search': () => ({
        items: [
          {
            url: 'https://github.com/a',
            title: 'A',
            lastVisitTime: 300,
            visitCount: 2,
          },
          {
            url: 'https://news.example/',
            title: 'News',
            lastVisitTime: 100,
            visitCount: 1,
          },
          { url: 'chrome://settings', title: 'x', lastVisitTime: 999 },
          { url: 'https://broken.example/', title: 7, lastVisitTime: 5 },
        ],
      }),
    })
    k.setReady([pairingId, 'pairing-2'])
    k.request.mockImplementation(async (pairing, method) => {
      if (method !== 'history.search') throw new Error('unexpected')
      return pairing === pairingId
        ? {
            items: [
              {
                url: 'https://github.com/a',
                title: 'A',
                lastVisitTime: 300,
                visitCount: 2,
              },
              {
                url: 'https://news.example/',
                title: 'News',
                lastVisitTime: 100,
                visitCount: 1,
              },
              { url: 'chrome://settings', title: 'x', lastVisitTime: 999 },
              { url: 'https://broken.example/', title: 7, lastVisitTime: 5 },
            ],
          }
        : {
            items: [
              {
                url: 'https://github.com/a',
                title: 'A (Edge)',
                lastVisitTime: 500,
                visitCount: 4,
              },
              {
                url: 'https://docs.example/x',
                title: 'Docs',
                lastVisitTime: 200,
                visitCount: 1,
              },
            ],
          }
    })
    const entries = await k.driver.searchHistory(
      { query: 'a', startTime: 50, maxResults: 3 },
      new AbortController().signal,
    )
    expect(k.request.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      [
        pairingId,
        'history.search',
        { text: 'a', startTime: 50, maxResults: 3 },
      ],
      [
        'pairing-2',
        'history.search',
        { text: 'a', startTime: 50, maxResults: 3 },
      ],
    ])
    expect(entries).toEqual([
      {
        url: 'https://github.com/a',
        title: 'A (Edge)',
        lastVisitTime: 500,
        visitCount: 4,
      },
      {
        url: 'https://docs.example/x',
        title: 'Docs',
        lastVisitTime: 200,
        visitCount: 1,
      },
      {
        url: 'https://news.example/',
        title: 'News',
        lastVisitTime: 100,
        visitCount: 1,
      },
    ])
  })

  it('answers with what one browser found when another fails, and fails when none answers', async () => {
    const k = fixture()
    k.setReady([pairingId, 'pairing-2'])
    k.request.mockImplementation(async (pairing) => {
      if (pairing === pairingId) throw new Error('DRIVER_UNAVAILABLE')
      return {
        items: [
          {
            url: 'https://docs.example/',
            title: 'Docs',
            lastVisitTime: 1,
            visitCount: 1,
          },
        ],
      }
    })
    expect(
      await k.driver.searchHistory(
        { query: '', startTime: 0, maxResults: 20 },
        new AbortController().signal,
      ),
    ).toHaveLength(1)
    k.request.mockImplementation(async () => {
      throw new Error('DRIVER_UNAVAILABLE')
    })
    await expect(
      k.driver.searchHistory(
        { query: '', startTime: 0, maxResults: 20 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' })
    k.setReady([])
    await expect(
      k.driver.searchHistory(
        { query: '', startTime: 0, maxResults: 20 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'DRIVER_UNAVAILABLE',
      reason: 'not-connected',
    })
  })
})
