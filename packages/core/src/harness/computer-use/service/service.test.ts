import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SessionLogStore } from '../../../session-log/store'
import { UiError } from '../errors'
import { GrantStore } from '../grants/store'
import type { UiCallerIdentity } from '../identity'
import { UiActionPolicy } from '../policy'
import { ScreenshotLedger } from '../screenshots'
import type { TargetSnapshot } from '../port'
import { FakeComputerUsePort } from '../testing/fake-port'
import type { UiAction } from '../types'
import { ComputerUseService, type GateTicket, type OpContext } from './service'

function setup(
  options: {
    enabled?: boolean
    mode?: 'unrestricted' | 'scoped'
    screenshots?: ScreenshotLedger
  } = {},
) {
  let mode = options.mode ?? 'unrestricted'
  const store = new SessionLogStore({ root: '/tmp/unused', persist: false })
  store.create({ id: 's1' })
  store.create({ id: 's2' })
  store.create({ id: 'c1' })
  const grants = new GrantStore({
    root: join(mkdtempSync(join(tmpdir(), 'cu-service-')), 'computer-use'),
  })
  const policy = new UiActionPolicy({ grants })
  const port = new FakeComputerUsePort()
  const saved: Array<{ mediaType: string; name: string }> = []
  const cancelled: Array<string | undefined> = []
  const changes: string[] = []
  const deleted: string[] = []
  const service = new ComputerUseService({
    port,
    grants,
    policy,
    ...(options.screenshots === undefined
      ? {}
      : {
          screenshots: options.screenshots,
          deleteImage: (id: string) => deleted.push(id),
        }),
    sessionFor: (id) => store.get(id),
    saveImage: (bytes, mediaType, name) => {
      saved.push({ mediaType, name })
      return {
        attachmentId: `att_${saved.length}`,
        mediaType,
        bytes: bytes.byteLength,
      }
    },
    cancelGrantCards: (sessionId) => cancelled.push(sessionId),
    settings: () => ({
      enabled: options.enabled ?? true,
      authorizationMode: mode,
    }),
    onChanged: (reason) => changes.push(reason),
  })
  return {
    store,
    grants,
    policy,
    port,
    service,
    saved,
    cancelled,
    changes,
    deleted,
    setMode: (next: 'unrestricted' | 'scoped') => {
      mode = next
    },
  }
}

const who = (over: Partial<UiCallerIdentity> = {}): UiCallerIdentity => ({
  subject: 'session:s1',
  kind: 'session',
  ownerSessionId: 's1',
  callerSessionId: 's1',
  taskId: 's1:1',
  turn: 1,
  background: false,
  canAsk: true,
  fullAccess: true,
  ...over,
})

let calls = 0
function ctx(
  over: Partial<OpContext> & { ticket?: GateTicket } = {},
): OpContext & { controller: AbortController } {
  const controller = new AbortController()
  calls += 1
  return {
    identity: who(),
    callId: `call-${calls}`,
    toolName: 'browser_test',
    signal: controller.signal,
    ticket: { kind: 'auto', actionClass: 'interact' },
    vision: false,
    controller,
    ...over,
  }
}

async function openForm(k: ReturnType<typeof setup>, path = '/form') {
  const record = await k.service.open(
    ctx({ ticket: { kind: 'auto', actionClass: 'navigate' } }),
    {
      url: k.port.browser.url(path),
    },
  )
  const observation = await k.service.observe(
    ctx({ ticket: { kind: 'auto', actionClass: 'observe' } }),
    {},
  )
  const ref = (name: string): string =>
    observation.elements.find((element) => element.name === name)!.ref
  return { record, observation, ref }
}

function types(store: SessionLogStore, id: string): string[] {
  return store.get(id)!.events.map((event) => event.type)
}

async function expectUiError(
  promise: Promise<unknown>,
  code: string,
  reason?: string,
) {
  try {
    await promise
    expect.unreachable(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(UiError)
    expect((error as UiError).code).toBe(code)
    if (reason !== undefined) expect((error as UiError).reason).toBe(reason)
  }
}

describe('ComputerUseService', () => {
  it('opens, observes and acts with journal and target facts on the right logs', async () => {
    const k = setup()
    const { record, observation, ref } = await openForm(k)
    expect(record.ownerSessionId).toBe('s1')
    expect(observation.target).toMatchObject({
      targetId: record.targetId,
      generation: 1,
    })
    expect(observation.revision).toBe(1)
    expect(observation.redactions).toBe(3)
    expect(
      observation.elements.find((element) => element.name === 'Password')
        ?.value,
    ).toBe('')

    const result = await k.service.act(ctx(), {
      action: { kind: 'fill', ref: ref('Name'), text: '张三' },
    })
    expect(result.outcome.outcome).toBe('observed')
    expect(result.autoApproved).toBe(true)
    expect(k.port.browser.valueFor(record.targetId, 'name')).toBe('张三')

    const submit = await k.service.act(ctx(), {
      action: { kind: 'click', ref: ref('Submit') },
    })
    expect(submit.target.url).toBe(k.port.browser.url('/done'))
    expect(submit.target.generation).toBe(2)

    expect(types(k.store, 's1')).toEqual([
      'ui/action-prepared',
      'ui/auto-approved',
      'ui/action-dispatched',
      'ui/action-settled',
      'ui/target-opened',
      'ui/control-state',
      'ui/action-prepared',
      'ui/auto-approved',
      'ui/action-settled',
      'ui/action-prepared',
      'ui/auto-approved',
      'ui/action-dispatched',
      'ui/action-settled',
      'ui/action-prepared',
      'ui/auto-approved',
      'ui/action-dispatched',
      'ui/action-settled',
    ])
    const fill = k.store
      .get('s1')!
      .events.find(
        (event) =>
          event.type === 'ui/action-prepared' &&
          event.data.action.kind === 'fill',
      )
    expect(JSON.stringify(fill)).not.toContain('张三')
  })

  it('journals subagent actions on the child log and target facts on the root', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    await k.service.act(
      ctx({ identity: who({ callerSessionId: 'c1', kind: 'subagent' }) }),
      {
        action: { kind: 'click', ref: ref('I agree') },
      },
    )
    expect(types(k.store, 'c1')).toEqual([
      'ui/action-prepared',
      'ui/auto-approved',
      'ui/action-dispatched',
      'ui/action-settled',
    ])
  })

  it('refuses stale element refs before anything is sent', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    await k.service.observe(ctx(), {})
    await expectUiError(
      k.service.act(ctx(), { action: { kind: 'click', ref: ref('Submit') } }),
      'STALE_ELEMENT',
    )
    expect(k.port.browser.dispatchedOps).toHaveLength(0)
    const settled = k.store.get('s1')!.events.at(-1)!
    expect(settled).toMatchObject({
      type: 'ui/action-settled',
      data: { outcome: 'no-effect', errorCode: 'STALE_ELEMENT' },
    })
  })

  it('reports OUTCOME_UNKNOWN after dispatch and never retries', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    k.port.browser.faults = { failAfterDispatch: true }
    await expectUiError(
      k.service.act(ctx(), { action: { kind: 'click', ref: ref('I agree') } }),
      'OUTCOME_UNKNOWN',
    )
    expect(k.port.browser.dispatchedOps).toHaveLength(1)
    expect(k.store.get('s1')!.events.at(-1)).toMatchObject({
      type: 'ui/action-settled',
      data: { outcome: 'unknown', errorCode: 'OUTCOME_UNKNOWN' },
    })
  })

  it('keeps the driver reason and advice when a dispatched action is unconfirmed', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    k.port.browser.faults = {
      failAfterDispatchWith: new UiError(
        'OUTCOME_UNKNOWN',
        'Helper request failed',
        {
          reason: 'background-delivery-unconfirmed',
          hint: 'Observe first; retry once only if the text is absent.',
        },
      ),
    }
    const error = await k.service
      .act(ctx(), { action: { kind: 'click', ref: ref('I agree') } })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
    expect(error).toMatchObject({
      code: 'OUTCOME_UNKNOWN',
      message:
        'the action may have happened but its result could not be confirmed',
      reason: 'background-delivery-unconfirmed',
      hint: 'Observe first; retry once only if the text is absent.',
    })
  })

  it('records a driver-reported uncertain outcome as unknown even if its dispatch event was lost', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    k.port.browser.faults = { failBeforeDispatch: 'OUTCOME_UNKNOWN' }
    await expectUiError(
      k.service.act(ctx(), { action: { kind: 'click', ref: ref('I agree') } }),
      'OUTCOME_UNKNOWN',
    )
    expect(k.store.get('s1')!.events.at(-1)).toMatchObject({
      type: 'ui/action-settled',
      data: { outcome: 'unknown', errorCode: 'OUTCOME_UNKNOWN' },
    })
  })

  it('settles an abort after dispatch as unknown and before dispatch as cancelled', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    k.port.browser.faults = { hangAfterDispatch: true }
    const hanging = ctx()
    const pending = k.service.act(hanging, {
      action: { kind: 'click', ref: ref('I agree') },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    hanging.controller.abort()
    await expectUiError(pending, 'OUTCOME_UNKNOWN')

    const early = ctx()
    early.controller.abort()
    await expectUiError(
      k.service.act(early, { action: { kind: 'click', ref: ref('I agree') } }),
      'TIMEOUT_NO_EFFECT',
    )
    expect(k.store.get('s1')!.events.at(-1)).toMatchObject({
      data: { outcome: 'cancelled' },
    })
  })

  it('serializes actions on one target', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    k.port.browser.faults = { hangAfterDispatch: true }
    const first = ctx()
    const order: string[] = []
    const a = k.service
      .act(first, { action: { kind: 'click', ref: ref('I agree') } })
      .catch(() => order.push('first-settled'))
    const b = k.service
      .act(ctx(), {
        action: { kind: 'fill', ref: ref('Email'), text: 'a@b.c' },
      })
      .then(() => order.push('second-done'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(
      k.port.browser.valueFor(k.service.listTargets()[0]!.targetId, 'email'),
    ).toBeUndefined()
    first.controller.abort()
    await Promise.all([a, b])
    expect(order).toEqual(['first-settled', 'second-done'])
  })

  it('re-validates the gate ticket: a revoked grant stops the action', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    const grant = k.grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://fixture.test'],
      },
      allowedActions: ['observe', 'interact'],
      scope: 'session',
      backgroundAllowed: false,
    })
    const ticket: GateTicket = {
      kind: 'grant',
      grantId: grant.grantId,
      grantRevision: grant.revision,
      actionClass: 'interact',
      requirement: {
        driver: 'embedded-browser',
        actionClass: 'interact',
        profileId: 'temporary',
        origin: 'https://fixture.test/form',
        callId: 'x',
      },
    }
    const identity = who({ fullAccess: false })
    await k.service.act(ctx({ identity, ticket }), {
      action: { kind: 'click', ref: ref('I agree') },
    })
    k.service.revokeGrant(grant.grantId)
    await expectUiError(
      k.service.act(ctx({ identity, ticket }), {
        action: { kind: 'click', ref: ref('I agree') },
      }),
      'PERMISSION_DENIED',
      'grant-revoked',
    )
    // An auto ticket is refused once the GUI authorization mode is narrowed.
    k.setMode('scoped')
    await expectUiError(
      k.service.act(ctx({ identity }), {
        action: { kind: 'click', ref: ref('I agree') },
      }),
      'PERMISSION_REQUIRED',
      'preset-changed',
    )
  })

  it('refuses a call that never passed the gate', () => {
    const k = setup()
    expect(() => k.service.takeTicket('s1', 'nope')).toThrow(/not authorized/)
    k.service.issueTicket('s1', 'yes', { kind: 'control' })
    expect(k.service.takeTicket('s1', 'yes')).toEqual({ kind: 'control' })
    expect(() => k.service.takeTicket('s1', 'yes')).toThrow()
  })

  it('keeps targets private to their owner session', async () => {
    const k = setup()
    const { record } = await openForm(k)
    const other = who({
      ownerSessionId: 's2',
      callerSessionId: 's2',
      subject: 'session:s2',
    })
    await expectUiError(
      k.service.observe(ctx({ identity: other }), {
        targetId: record.targetId,
      }),
      'INVALID_REQUEST',
    )
    expect(k.service.lookup(other, record.targetId)).toBeUndefined()
  })

  it('emergency stop cancels, pauses, suspends and dismisses cards; resume restores', async () => {
    const k = setup()
    const { record, ref } = await openForm(k)
    k.port.browser.faults = { hangAfterDispatch: true }
    const inflight = k.service.act(ctx(), {
      action: { kind: 'click', ref: ref('I agree') },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await k.service.emergencyStop()
    await expectUiError(inflight, 'OUTCOME_UNKNOWN')
    expect(k.cancelled).toEqual([undefined])
    expect(k.grants.suspended?.by).toBe('kill-switch')
    expect(k.service.listTargets()[0]!.control).toBe('stopped')
    expect(k.port.indicator.at(-1)).toMatchObject({
      stopped: true,
      active: false,
    })
    await expectUiError(
      k.service.observe(ctx(), { targetId: record.targetId }),
      'PERMISSION_DENIED',
      'emergency-stop',
    )
    k.service.resume()
    expect(k.grants.suspended).toBeNull()
    expect(k.service.listTargets()[0]!.control).toBe('agent')
    await k.service.observe(ctx(), {})
  })

  it('emergency stop asks the desktop helper to release held keys and buttons', async () => {
    const k = setup()
    const releaseAll = vi.fn(async () => undefined)
    ;(k.port as unknown as { desktop: () => unknown }).desktop = () => ({
      driver: 'desktop',
      releaseAll,
      setPaused: () => undefined,
    })
    await k.service.emergencyStop()
    expect(releaseAll).toHaveBeenCalledOnce()
    // A helper that fails to answer never blocks the stop.
    releaseAll.mockRejectedValueOnce(new Error('helper gone'))
    k.service.resume()
    await k.service.emergencyStop()
    expect(k.service.stopped).toBe(true)
  })

  it('emergency stop aborts a dispatched desktop drag before releasing held input', async () => {
    const k = setup()
    const snapshot: TargetSnapshot = {
      targetId: 'desktop-fixture',
      kind: 'desktop-window',
      driver: 'desktop',
      generation: 1,
      revision: 1,
      url: 'app:com.emperor.agent.axfixture',
      title: 'Emperor AX Fixture',
      loading: false,
      profileId: 'desktop',
      appId: 'com.emperor.agent.axfixture',
      windowRef: 'w-fixture',
    }
    k.service.registry.add('s1', snapshot, new Date())
    let signal: AbortSignal | undefined
    let dispatched!: () => void
    const sent = new Promise<void>((resolve) => {
      dispatched = resolve
    })
    let abortedAtRelease: boolean | undefined
    const releaseAll = vi.fn(async () => {
      abortedAtRelease = signal?.aborted
    })
    const setPaused = vi.fn()
    const desktop = {
      driver: 'desktop' as const,
      subscribe: () => () => undefined,
      snapshot: () => snapshot,
      setPaused,
      releaseAll,
      act: async (
        _request: unknown,
        hooks: { dispatched: () => void },
        active: AbortSignal,
      ): Promise<never> => {
        signal = active
        hooks.dispatched()
        dispatched()
        return await new Promise<never>((_resolve, reject) =>
          active.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        )
      },
    }
    ;(k.port as unknown as { desktop: () => unknown }).desktop = () => desktop
    const inflight = k.service.act(ctx(), {
      targetId: snapshot.targetId,
      action: { kind: 'drag', from: 'r1.1', to: 'r1.2' },
    })
    await sent
    await k.service.emergencyStop()
    await expectUiError(inflight, 'OUTCOME_UNKNOWN')
    expect(setPaused).toHaveBeenCalledWith(snapshot.targetId, true)
    expect(releaseAll).toHaveBeenCalledOnce()
    expect(abortedAtRelease).toBe(true)
    await expectUiError(
      k.service.act(ctx(), {
        targetId: snapshot.targetId,
        action: { kind: 'press', key: 'A' },
      }),
      'PERMISSION_DENIED',
      'emergency-stop',
    )
  })

  it('switching a driver off cancels its actions and ends its targets', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    k.port.browser.faults = { hangAfterDispatch: true }
    const inflight = k.service.act(ctx(), {
      action: { kind: 'click', ref: ref('I agree') },
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    await k.service.closeDriver('embedded-browser', 'revoked')
    // Already sent: the outcome is unknown, never retried.
    await expectUiError(inflight, 'OUTCOME_UNKNOWN')
    expect(k.service.listTargets()).toEqual([])
    expect(k.port.browser.list()).toEqual([])
  })

  it('pauses Agent-driven targets when the UI disconnects, until resumed', async () => {
    const k = setup()
    const { record } = await openForm(k)
    expect(k.service.pauseForUiDisconnect()).toBe(1)
    expect(k.service.listTargets()[0]!.control).toBe('paused')
    // Already paused or held by the user: untouched.
    expect(k.service.pauseForUiDisconnect()).toBe(0)
    await expectUiError(
      k.service.observe(ctx(), { targetId: record.targetId }),
      'TARGET_BUSY',
    )
    await k.service.controlTarget(record.targetId, 'resume')
    const observation = await k.service.observe(ctx(), {})
    expect(observation.notes?.join(' ')).toContain('app window reloaded')
  })

  it('honours user pause, takeover and hand-back', async () => {
    const k = setup()
    const { record } = await openForm(k)
    await k.service.controlTarget(record.targetId, 'takeover')
    await expectUiError(k.service.observe(ctx(), {}), 'USER_TAKEOVER')
    await k.service.controlTarget(record.targetId, 'pause')
    await expectUiError(k.service.observe(ctx(), {}), 'TARGET_BUSY', 'paused')
    await k.service.controlTarget(record.targetId, 'handback')
    await k.service.observe(ctx(), {})
    await k.service.controlTarget(record.targetId, 'close')
    expect(k.service.listTargets()).toEqual([])
    expect(k.store.get('s1')!.events.at(-1)).toMatchObject({
      type: 'ui/target-closed',
      data: { reason: 'user' },
    })
  })

  it('caps open targets per session', async () => {
    const k = setup()
    for (let index = 0; index < 4; index += 1)
      await k.service.open(ctx(), { url: k.port.browser.url('/form') })
    await expectUiError(
      k.service.open(ctx(), { url: k.port.browser.url('/form') }),
      'BUDGET_EXCEEDED',
    )
  })

  it('blocks page-initiated navigation to an unauthorized origin in restricted presets', async () => {
    const k = setup({ mode: 'scoped' })
    const restricted = who({ fullAccess: false })
    const grant = k.grants.issue({
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser',
      targetScope: {
        kind: 'browser',
        profileId: 'temporary',
        origins: ['https://fixture.test'],
      },
      allowedActions: ['observe', 'interact', 'navigate'],
      scope: 'session',
      backgroundAllowed: false,
    })
    const ticket: GateTicket = {
      kind: 'grant',
      grantId: grant.grantId,
      grantRevision: 1,
      actionClass: 'navigate',
    }
    const record = await k.service.open(ctx({ identity: restricted, ticket }), {
      url: k.port.browser.url('/form'),
    })
    expect(
      k.service.navigationVerdict({
        targetId: record.targetId,
        url: 'https://other.test/',
        frame: 'main',
        initiator: 'page',
      }),
    ).toBe('block')
    expect(
      k.service.navigationVerdict({
        targetId: record.targetId,
        url: 'https://fixture.test/done',
        frame: 'main',
        initiator: 'page',
      }),
    ).toBe('allow')
    expect(
      k.service.navigationVerdict({
        targetId: record.targetId,
        url: 'https://other.test/embed',
        frame: 'sub',
        initiator: 'page',
      }),
    ).toBe('allow')
    const observation = await k.service.observe(
      ctx({ identity: restricted, ticket }),
      {},
    )
    expect(observation.notes?.join('\n')).toContain(
      'https://other.test was blocked',
    )

    k.setMode('unrestricted')
    const open = await k.service.open(ctx(), {
      url: k.port.browser.url('/form'),
    })
    expect(
      k.service.navigationVerdict({
        targetId: open.targetId,
        url: 'https://other.test/',
        frame: 'main',
        initiator: 'page',
      }),
    ).toBe('allow')
  })

  it('treats a crashed target as lost and a detached one as needing recovery', async () => {
    const k = setup()
    const { record } = await openForm(k)
    k.port.browser.detach(record.targetId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expectUiError(k.service.observe(ctx(), {}), 'TARGET_BUSY')
    await k.service.controlTarget(record.targetId, 'resume')
    await k.service.observe(ctx(), {})
    k.port.browser.crash(record.targetId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expectUiError(k.service.observe(ctx(), {}), 'INVALID_REQUEST')
    expect(k.store.get('s1')!.events.at(-1)).toMatchObject({
      type: 'ui/target-closed',
      data: { reason: 'lost' },
    })
  })

  it('answers action status from memory and from the log after a restart', async () => {
    const k = setup()
    const { ref } = await openForm(k)
    const call = ctx()
    const result = await k.service.act(call, {
      action: { kind: 'click', ref: ref('I agree') },
    })
    expect(
      k.service.actionStatus(who(), { callId: call.callId }),
    ).toMatchObject({
      operationId: result.operationId,
      state: 'observed',
    })
    const restarted = new ComputerUseService({
      port: k.port,
      grants: k.grants,
      policy: k.policy,
      sessionFor: (id) => k.store.get(id),
      saveImage: () => ({
        attachmentId: 'x',
        mediaType: 'image/png',
        bytes: 0,
      }),
      cancelGrantCards: () => undefined,
      settings: () => ({ enabled: true }),
    })
    expect(
      restarted.actionStatus(who(), { operationId: result.operationId }),
    ).toMatchObject({
      state: 'observed',
      outcome: 'observed',
    })
    expect(
      restarted.actionStatus(
        who({ ownerSessionId: 's2', callerSessionId: 's2' }),
        {
          operationId: result.operationId,
        },
      ),
    ).toBeUndefined()
  })

  it('saves screenshots as attachments and a model copy only for vision routes', async () => {
    const k = setup()
    await openForm(k)
    const plain = await k.service.screenshot(ctx(), {})
    expect(plain.model).toBeUndefined()
    expect(plain.audit).toMatchObject({ mediaType: 'image/png', width: 2560 })
    const vision = await k.service.screenshot(ctx({ vision: true }), {})
    expect(vision.model).toMatchObject({ mediaType: 'image/jpeg', width: 1600 })
    expect(k.saved.map((item) => item.mediaType)).toEqual([
      'image/png',
      'image/png',
      'image/jpeg',
    ])
    expect(k.service.listTargets()[0]!.lastScreenshot?.attachmentId).toBe(
      'att_2',
    )
  })

  it('deletes the oldest screenshots past the quota and clears on request', async () => {
    const ledger = new ScreenshotLedger(
      mkdtempSync(join(tmpdir(), 'cu-shots-')),
      {
        perSession: { count: 2, bytes: 1_000_000 },
        total: { count: 100, bytes: 100_000_000 },
      },
    )
    const k = setup({ screenshots: ledger })
    await openForm(k)
    await k.service.screenshot(ctx(), {})
    await k.service.screenshot(ctx(), {})
    expect(k.deleted).toEqual([])
    await k.service.screenshot(ctx(), {})
    expect(k.deleted).toEqual(['att_1'])
    expect(k.service.statusView().screenshots).toMatchObject({ count: 2 })
    expect(k.service.listTargets()[0]!.lastScreenshot?.attachmentId).toBe(
      'att_3',
    )
    expect(k.service.clearScreenshots('s1')).toMatchObject({ removed: 2 })
    expect(k.deleted).toEqual(['att_1', 'att_2', 'att_3'])
    expect(k.service.listTargets()[0]!.lastScreenshot).toBeUndefined()
    expect(k.service.statusView().screenshots).toEqual({ count: 0, bytes: 0 })
  })

  it('requires vision for screenshot coordinates', async () => {
    const k = setup()
    await openForm(k)
    const action: UiAction = {
      kind: 'clickPoint',
      point: { screenshotId: 's', x: 1, y: 1 },
    }
    await expectUiError(k.service.act(ctx(), { action }), 'VISION_UNAVAILABLE')
  })

  it('refuses everything while computer use is switched off', async () => {
    const k = setup({ enabled: false })
    await expectUiError(
      k.service.open(ctx(), { url: 'https://fixture.test/form' }),
      'CAPABILITY_DISABLED',
    )
  })

  it('ends once/task grants with the task and cleans up a deleted session', async () => {
    const k = setup()
    const base = {
      subject: 'session:s1',
      ownerSessionId: 's1',
      driver: 'embedded-browser' as const,
      targetScope: {
        kind: 'browser' as const,
        profileId: 'temporary',
        origins: ['https://a.test'],
      },
      allowedActions: ['observe' as const],
      backgroundAllowed: false,
    }
    k.grants.issue({ ...base, scope: 'task', taskId: 's1:1' })
    k.grants.issue({ ...base, scope: 'once', callId: 'c' })
    k.grants.issue({ ...base, scope: 'session' })
    k.service.endTask('s1')
    expect(k.grants.list().map((grant) => grant.scope)).toEqual(['session'])
    await openForm(k)
    await k.service.onSessionDeleted('s1')
    expect(k.grants.list()).toEqual([])
    expect(k.service.listTargets()).toEqual([])
    expect(k.cancelled).toEqual(['s1'])
  })
})
