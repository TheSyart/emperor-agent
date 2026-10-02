/**
 * CU-04: every window and tab a task controlled is released when the task
 * ends (2026-09-29 §3.3) — nothing is closed, old handles say why they are
 * stale, and the next task takes things back.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionLogStore } from '../../../session-log/store'
import { UiError } from '../errors'
import { GrantStore } from '../grants/store'
import type { UiCallerIdentity } from '../identity'
import { UiActionPolicy } from '../policy'
import type { ActHooks, ActRequest, DriverEvent, TargetSnapshot } from '../port'
import { FakeComputerUsePort } from '../testing/fake-port'
import { ComputerUseService, type GateTicket, type OpContext } from './service'

const OWNER = 's1'

const who = (over: Partial<UiCallerIdentity> = {}): UiCallerIdentity => ({
  subject: `session:${OWNER}`,
  kind: 'session',
  ownerSessionId: OWNER,
  callerSessionId: OWNER,
  taskId: `${OWNER}:1`,
  turn: 1,
  background: false,
  canAsk: true,
  fullAccess: true,
  ...over,
})

let calls = 0
function ctx(
  over: Partial<OpContext> & { ticket?: GateTicket } = {},
): OpContext {
  calls += 1
  return {
    identity: who(),
    callId: `call-${calls}`,
    toolName: 'test',
    signal: new AbortController().signal,
    ticket: { kind: 'auto', actionClass: 'interact' },
    vision: false,
    ...over,
  }
}

function windowSnapshot(targetId: string, appId: string): TargetSnapshot {
  return {
    targetId,
    kind: 'desktop-window',
    driver: 'desktop',
    generation: 1,
    revision: 1,
    url: `app:${appId}`,
    title: targetId,
    loading: false,
    profileId: 'desktop',
    appId,
    windowRef: `ref-${targetId}`,
  }
}

/** A desktop driver that logs the release steps in order. */
function fakeDesktop() {
  const log: string[] = []
  const bound = new Map<string, TargetSnapshot>()
  const listeners: Array<(event: DriverEvent) => void> = []
  const faults: {
    releaseFails?: string
    captureHangs?: boolean
  } = {}
  const driver = {
    driver: 'desktop' as const,
    snapshot: (id: string) => bound.get(id) ?? null,
    list: () => [...bound.values()],
    subscribe: (listener: (event: DriverEvent) => void) => {
      listeners.push(listener)
      return () => undefined
    },
    setPaused: () => undefined,
    act: async (request: ActRequest, hooks: ActHooks) => {
      log.push(`act ${request.targetId}`)
      hooks.dispatched()
      return { outcome: 'observed' as const, afterRevision: 2 }
    },
    setCapture: async (target: { targetId: string }, active: boolean) => {
      log.push(`capture ${target.targetId} ${active}`)
      if (faults.captureHangs === true && !active)
        await new Promise(() => undefined)
      return active
    },
    releaseAll: async () => {
      log.push('releaseAll')
    },
    restoreFront: async (target: { targetId: string }) => {
      // The helper needs the window still bound for this.
      if (!bound.has(target.targetId))
        throw new UiError('STALE_TARGET', 'Target no longer exists')
      log.push(`front ${target.targetId}`)
      return true
    },
    release: async (targetId: string) => {
      log.push(`release ${targetId}`)
      if (faults.releaseFails === targetId)
        throw new Error('the helper did not answer')
      bound.delete(targetId)
    },
    close: async (targetId: string) => {
      log.push(`close ${targetId}`)
      bound.delete(targetId)
    },
    resetConnection: async (reason: string) => {
      log.push(`reset ${reason}`)
      for (const targetId of [...bound.keys()]) {
        bound.delete(targetId)
        for (const listener of listeners)
          listener({ type: 'lost', targetId, reason })
      }
    },
  }
  return { driver, log, bound, faults }
}

interface ExternalTab {
  targetId: string
  profileId: string
  tabId: number
  windowId: number
  origin: string
  generation: number
  revision: number
  claimedBy: string | null
}

/** An external browser driver: one tab the user connected in Chrome. */
function fakeExternal() {
  const log: string[] = []
  const tabs = new Map<string, ExternalTab>([
    [
      'ext-1',
      {
        targetId: 'ext-1',
        profileId: 'pairing-1',
        tabId: 7,
        windowId: 1,
        origin: 'https://mail.test',
        generation: 3,
        revision: 0,
        claimedBy: null,
      },
    ],
  ])
  const snapshotOf = (tab: ExternalTab): TargetSnapshot => ({
    targetId: tab.targetId,
    kind: 'external-tab',
    driver: 'external-browser',
    generation: tab.generation,
    revision: tab.revision,
    url: tab.origin,
    title: `Chrome ${tab.origin}`,
    loading: false,
    profileId: tab.profileId,
  })
  const driver = {
    driver: 'external-browser' as const,
    listAttached: () => [...tabs.values()].map((tab) => ({ ...tab })),
    claimAttachedTarget: async (targetId: string, owner: string) => {
      const tab = tabs.get(targetId)!
      tab.claimedBy = owner
      return snapshotOf(tab)
    },
    snapshot: (id: string) => {
      const tab = tabs.get(id)
      return tab === undefined ? null : snapshotOf(tab)
    },
    list: () =>
      [...tabs.values()].filter((tab) => tab.claimedBy).map(snapshotOf),
    subscribe: () => () => undefined,
    setPaused: () => undefined,
    setNavigationPolicy: () => undefined,
    historyTarget: () => null,
    release: async (targetId: string) => {
      log.push(`release ${targetId}`)
      const tab = tabs.get(targetId)
      if (tab !== undefined) tab.claimedBy = null
    },
    close: async (targetId: string) => {
      log.push(`detach ${targetId}`)
      tabs.delete(targetId)
    },
  }
  return { driver, log, tabs }
}

function setup() {
  const store = new SessionLogStore({ root: '/tmp/unused', persist: false })
  store.create({ id: OWNER })
  store.create({ id: 's2' })
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-release-')), 'computer-use'),
  })
  const port = new FakeComputerUsePort()
  const desktop = fakeDesktop()
  const external = fakeExternal()
  const mutable = port as unknown as {
    desktop: () => unknown
    externalBrowser: () => unknown
  }
  mutable.desktop = () => desktop.driver
  mutable.externalBrowser = () => external.driver
  const changes: string[] = []
  const service = new ComputerUseService({
    port,
    grants,
    policy: new UiActionPolicy({ grants }),
    sessionFor: (id) => store.get(id),
    saveImage: (bytes, mediaType) => ({
      attachmentId: 'att',
      mediaType,
      bytes: bytes.byteLength,
    }),
    cancelGrantCards: () => undefined,
    settings: () => ({ enabled: true }),
    onChanged: (reason) => changes.push(reason),
  })
  return { store, grants, port, desktop, external, service, changes }
}

type Kit = ReturnType<typeof setup>

/** Bind a window the way a task does, and act on it once (it came forward). */
async function bindWindow(k: Kit, targetId: string, appId: string) {
  const snapshot = windowSnapshot(targetId, appId)
  k.desktop.bound.set(targetId, snapshot)
  k.service.registry.add(OWNER, snapshot, new Date())
  await k.service.act(ctx(), {
    targetId,
    action: { kind: 'press', key: 'Tab' },
  })
}

async function openTab(k: Kit, path = '/form') {
  const record = await k.service.open(
    ctx({ ticket: { kind: 'auto', actionClass: 'navigate' } }),
    { url: k.port.browser.url(path) },
  )
  const observation = await k.service.observe(
    ctx({ ticket: { kind: 'auto', actionClass: 'observe' } }),
    { targetId: record.targetId },
  )
  return { record, observation }
}

async function attachExternal(k: Kit) {
  return await k.service.attachExternal(
    ctx({ ticket: { kind: 'auto', actionClass: 'observe' } }),
    'ext-1',
  )
}

function events(k: Kit, type: string) {
  return k.store
    .get(OWNER)!
    .events.filter((event) => event.type === type)
    .map((event) => event.data as Record<string, unknown>)
}

async function uiError(promise: Promise<unknown>): Promise<UiError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(UiError)
    return error as UiError
  }
  throw new Error('expected a UiError')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('releasing a task (CU-04)', () => {
  it('releases every window and tab at the end of the task, closing none', async () => {
    const k = setup()
    await bindWindow(k, 'win-1', 'com.example.Writer')
    await bindWindow(k, 'win-2', 'com.example.Keys')
    const { record: tab } = await openTab(k)
    await attachExternal(k)
    k.grants.issue({
      subject: `session:${OWNER}`,
      ownerSessionId: OWNER,
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://fixture.test'],
      },
      allowedActions: ['interact'],
      scope: 'once',
      callId: 'c',
      backgroundAllowed: false,
    })
    expect(k.service.listTargets(OWNER)).toHaveLength(4)

    const summary = await k.service.releaseTask(OWNER, 'task-end')

    expect(summary).toEqual({
      released: ['win-1', 'win-2', tab.targetId, 'ext-1'],
      failed: [],
    })
    // Windows: the picture stops, input is let go, the front goes back while
    // the window is still bound, then it is unbound. Nothing is closed.
    const steps = k.desktop.log.filter((line) => !line.startsWith('act'))
    expect(steps).toEqual([
      'capture win-1 false',
      'capture win-2 false',
      'releaseAll',
      'front win-1',
      'front win-2',
      'release win-1',
      'release win-2',
    ])
    expect(k.desktop.log.some((line) => line.startsWith('close'))).toBe(false)
    // The built-in tab keeps its page; the Chrome tab stays connected.
    expect(k.port.browser.released).toEqual([tab.targetId])
    expect(k.port.browser.list().map((item) => item.targetId)).toEqual([
      tab.targetId,
    ])
    expect(k.external.log).toEqual(['release ext-1'])
    expect(k.external.tabs.get('ext-1')?.claimedBy).toBeNull()
    // The preview has nothing left to show; the page is there to take back.
    expect(k.service.listTargets(OWNER)).toEqual([])
    expect(k.service.listTabs(OWNER)).toEqual([
      expect.objectContaining({ targetId: tab.targetId, state: 'released' }),
    ])
    expect(events(k, 'ui/target-released')).toHaveLength(4)
    expect(events(k, 'ui/task-released')).toEqual([
      { reason: 'task-end', released: 4, failed: 0 },
    ])
    expect(k.grants.list().filter((grant) => grant.scope === 'once')).toEqual(
      [],
    )
    expect(k.changes.at(-1)).toBe('targets')
    expect(k.port.indicator.at(-1)).toMatchObject({
      active: false,
      targets: [],
    })
  })

  it('aborts an action in flight: it settles unknown and is never replayed', async () => {
    const k = setup()
    const { record, observation } = await openTab(k)
    const ref = observation.elements.find(
      (element) => element.name === 'I agree',
    )!.ref
    k.port.browser.faults = { hangAfterDispatch: true }
    const inflight = k.service.act(ctx(), {
      targetId: record.targetId,
      action: { kind: 'click', ref },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await k.service.releaseTask(OWNER, 'task-end')
    const error = await uiError(inflight)
    expect(error.code).toBe('OUTCOME_UNKNOWN')
    expect(k.port.browser.dispatchedOps).toHaveLength(1)
    expect(events(k, 'ui/action-settled').at(-1)).toMatchObject({
      outcome: 'unknown',
    })
  })

  it('answers old handles with released-at-task-end, never "closed"', async () => {
    const k = setup()
    await bindWindow(k, 'win-1', 'com.example.Writer')
    const { record: tab } = await openTab(k)
    await attachExternal(k)
    await k.service.releaseTask(OWNER, 'task-end')

    const onTab = await uiError(
      k.service.observe(ctx(), { targetId: tab.targetId }),
    )
    expect(onTab).toMatchObject({
      code: 'STALE_TARGET',
      reason: 'released-at-task-end',
    })
    expect(onTab.message).toContain('still open')
    expect(onTab.hint).toContain('browser_tab_select')
    // No targetId: the current one was released.
    const current = await uiError(k.service.observe(ctx(), {}))
    expect(current.reason).toBe('released-at-task-end')
    const onWindow = await uiError(
      k.service.act(ctx(), {
        targetId: 'win-1',
        action: { kind: 'press', key: 'Tab' },
      }),
    )
    expect(onWindow.reason).toBe('released-at-task-end')
    expect(onWindow.hint).toContain('desktop_bind')
    const onChrome = await uiError(
      k.service.observe(ctx(), { targetId: 'ext-1' }),
    )
    expect(onChrome.hint).toContain('external_tab_attach')
  })

  it('lets the next task take a built-in tab back, with fresh refs only', async () => {
    const k = setup()
    const { record: tab, observation } = await openTab(k)
    const oldRef = observation.elements.find(
      (element) => element.name === 'I agree',
    )!.ref
    await k.service.releaseTask(OWNER, 'task-end')

    const next = who({ taskId: `${OWNER}:2`, turn: 2 })
    const taken = await k.service.select(next, tab.targetId)
    expect(taken).toMatchObject({ state: 'attached', control: 'agent' })
    expect(k.service.listTargets(OWNER)).toHaveLength(1)
    expect(events(k, 'ui/target-opened')).toHaveLength(2)
    // A ref from the earlier task no longer resolves.
    const stale = await uiError(
      k.service.act(ctx({ identity: next }), {
        targetId: tab.targetId,
        action: { kind: 'click', ref: oldRef },
      }),
    )
    expect(stale.code).toBe('STALE_ELEMENT')
    const fresh = await k.service.observe(
      ctx({
        identity: next,
        ticket: { kind: 'auto', actionClass: 'observe' },
      }),
      {},
    )
    expect(fresh.target.targetId).toBe(tab.targetId)
  })

  it('lets the next task attach the Chrome tab again, still connected', async () => {
    const k = setup()
    await attachExternal(k)
    await k.service.releaseTask(OWNER, 'task-end')
    expect(k.service.listExternalTabs(OWNER)).toEqual([
      expect.objectContaining({ targetId: 'ext-1', claimedBy: null }),
    ])
    const again = await attachExternal(k)
    expect(again).toMatchObject({ targetId: 'ext-1', state: 'attached' })
    expect(k.external.log).toEqual(['release ext-1'])
  })

  it('reports a window it could not release, and restarts the helper connection', async () => {
    const k = setup()
    await bindWindow(k, 'win-1', 'com.example.Writer')
    await bindWindow(k, 'win-2', 'com.example.Mail')
    k.desktop.faults.releaseFails = 'win-2'

    const summary = await k.service.releaseTask(OWNER, 'task-end')

    expect(summary.released).toEqual(['win-1'])
    expect(summary.failed).toEqual([
      { targetId: 'win-2', error: 'the helper did not answer' },
    ])
    expect(k.desktop.log.at(-1)).toBe('reset release failed')
    expect(events(k, 'ui/target-released')).toEqual([
      { targetId: 'win-1', reason: 'task-end', outcome: 'released' },
      {
        targetId: 'win-2',
        reason: 'task-end',
        outcome: 'failed',
        error: 'the helper did not answer',
      },
    ])
    // Never "all released".
    expect(events(k, 'ui/task-released')).toEqual([
      { reason: 'task-end', released: 1, failed: 1 },
    ])
    // No new action runs on it (the helper reset lost it meanwhile).
    await uiError(
      k.service.act(ctx(), {
        targetId: 'win-2',
        action: { kind: 'press', key: 'Tab' },
      }),
    )
    expect(k.desktop.log.filter((line) => line === 'act win-2')).toHaveLength(1)
  })

  it('shows a failed release on the target until the helper is gone', async () => {
    const k = setup()
    await openTab(k)
    const failing = k.port.browser as unknown as {
      release: (targetId: string) => Promise<void>
    }
    failing.release = async () => {
      throw new Error('renderer busy')
    }
    await k.service.releaseTask(OWNER, 'task-end')
    expect(k.service.listTargets(OWNER)).toEqual([
      expect.objectContaining({
        state: 'released',
        releaseFailed: 'renderer busy',
      }),
    ])
  })

  it('fails a step the driver never answers instead of hanging the task', async () => {
    vi.useFakeTimers()
    const k = setup()
    const snapshot = windowSnapshot('win-1', 'com.example.Writer')
    k.desktop.bound.set('win-1', snapshot)
    k.service.registry.add(OWNER, snapshot, new Date())
    k.desktop.faults.captureHangs = true
    const release = k.service.releaseTask(OWNER, 'task-end')
    await vi.advanceTimersByTimeAsync(10_000)
    const summary = await release
    expect(summary.failed).toEqual([
      { targetId: 'win-1', error: 'the driver did not answer in time' },
    ])
    expect(k.desktop.log).toContain('release win-1')
  })

  it('joins a release in progress, and finds nothing left afterwards', async () => {
    const k = setup()
    await bindWindow(k, 'win-1', 'com.example.Writer')
    const first = k.service.releaseTask(OWNER, 'task-end')
    const second = k.service.releaseTask(OWNER, 'task-end')
    expect(second).toBe(first)
    await first
    const later = await k.service.releaseTask(OWNER, 'task-end')
    expect(later).toEqual({ released: [], failed: [] })
    expect(
      k.desktop.log.filter((line) => line === 'release win-1'),
    ).toHaveLength(1)
    expect(events(k, 'ui/task-released')).toHaveLength(1)
  })

  it('keeps other sessions untouched', async () => {
    const k = setup()
    await openTab(k)
    const other = who({
      subject: 'session:s2',
      ownerSessionId: 's2',
      callerSessionId: 's2',
      taskId: 's2:1',
    })
    await k.service.open(
      ctx({
        identity: other,
        ticket: { kind: 'auto', actionClass: 'navigate' },
      }),
      { url: k.port.browser.url('/form') },
    )
    await k.service.releaseTask(OWNER, 'task-end')
    expect(k.service.listTargets('s2')).toHaveLength(1)
  })

  it('makes room by closing the oldest released tab when a new target needs it', async () => {
    const k = setup()
    const first = await openTab(k)
    for (let index = 0; index < 3; index += 1) await openTab(k)
    await k.service.releaseTask(OWNER, 'task-end')
    const next = who({ taskId: `${OWNER}:2`, turn: 2 })
    await k.service.open(
      ctx({
        identity: next,
        ticket: { kind: 'auto', actionClass: 'navigate' },
      }),
      { url: k.port.browser.url('/form') },
    )
    const tabs = k.service.listTabs(OWNER)
    expect(tabs).toHaveLength(4)
    expect(tabs.map((tab) => tab.targetId)).not.toContain(first.record.targetId)
    expect(k.port.browser.list()).toHaveLength(4)
  })

  it('closes a released built-in tab without taking it back first', async () => {
    const k = setup()
    const { record } = await openTab(k)
    await k.service.releaseTask(OWNER, 'task-end')
    await k.service.close(ctx(), { targetId: record.targetId })
    expect(k.service.listTabs(OWNER)).toEqual([])
    expect(k.port.browser.list()).toEqual([])
  })

  it('closes, not adopts, a popup a released tab opens', async () => {
    const k = setup()
    const { record } = await openTab(k, '/popup')
    await k.service.releaseTask(OWNER, 'task-end')
    const popup = k.port.browser.pageOpenPopup(record.targetId, '/done')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(popup).not.toBeNull()
    expect(k.service.listTabs(OWNER).map((tab) => tab.targetId)).toEqual([
      record.targetId,
    ])
  })

  it('releases the same way when the session is deleted, then closes its pages', async () => {
    const k = setup()
    await bindWindow(k, 'win-1', 'com.example.Writer')
    await openTab(k)
    await attachExternal(k)
    await k.service.onSessionDeleted(OWNER)
    expect(k.desktop.log).toContain('release win-1')
    expect(k.desktop.log.some((line) => line.startsWith('close'))).toBe(false)
    expect(k.external.log).toEqual(['release ext-1'])
    expect(k.port.browser.list()).toEqual([])
    expect(events(k, 'ui/task-released')).toEqual([
      { reason: 'session-deleted', released: 3, failed: 0 },
    ])
  })

  it('releases every session when computer use is switched off', async () => {
    const k = setup()
    await bindWindow(k, 'win-1', 'com.example.Writer')
    await attachExternal(k)
    await k.service.closeAll('revoked')
    expect(k.desktop.log).toContain('release win-1')
    expect(k.external.log).toEqual(['release ext-1'])
    expect(k.external.tabs.has('ext-1')).toBe(true)
    expect(events(k, 'ui/task-released')).toEqual([
      { reason: 'switched-off', released: 2, failed: 0 },
    ])
  })

  it('lets the Agent release one target early, keeping it open', async () => {
    const k = setup()
    const { record } = await openTab(k)
    await attachExternal(k)
    await k.service.releaseTarget(ctx(), record.targetId)
    expect(k.port.browser.list()).toHaveLength(1)
    expect(k.service.listTargets(OWNER).map((item) => item.targetId)).toEqual([
      'ext-1',
    ])
    expect(events(k, 'ui/target-released')).toEqual([
      { targetId: record.targetId, reason: 'agent', outcome: 'released' },
    ])
    expect(events(k, 'ui/task-released')).toEqual([])
  })
})
